/**
 * Cache-diagnosis chain: the `diagnostics.previous_message_id` value.
 *
 * claude-code 2.1.325 derives it from the HISTORY being sent, not from a
 * per-process "last response" slot: `Mt=Amt(e)` walks the messages backwards
 * to the last assistant message that `ice()` accepts (not an API error, has a
 * `msg_…` id) and sends `diagnostics:{previous_message_id:Mt??null}`
 * (CC/chunk-wqb2b4v0.mjs, `function Amt` / `function ice`). Wire evidence:
 * research/2026-11-15-cc-2.1.325-oauth-diff/cc-wire.md §2.1 (D/…fetch-005-02 →
 * null, D/…fetch-028-02 → the previous response's msg_ id).
 *
 * Our canonical assistant messages carry no provider message id
 * (`CanonicalMessage` = role/content/toolCallId/cache in plugin-api
 * canonical-messages.ts). So we keep a bounded map from a content fingerprint
 * of each SUCCESSFULLY finished response (recorded at `message_stop`) to its
 * `msg_…` id, and look up the last assistant message of the outgoing history.
 * Compaction, rewind, side calls and parallel requests then resolve by
 * content; aborted / failed attempts are never recorded.
 *
 * @module llm/providers/anthropic/cache-diagnosis
 */

import { createHash } from "node:crypto"

import type { CanonicalEvent } from "@minimal-agent/core/plugin-api/llm/canonical-events"
import type { CanonicalMessage } from "@minimal-agent/core/plugin-api/llm/canonical-messages"

/** Max remembered responses (LRU). */
const MAX_ENTRIES = 256

const idByFingerprint = new Map<string, string>()

/** Test seam: forget every recorded response. */
export function _resetCacheDiagnosisForTest(): void {
  idByFingerprint.clear()
}

/** Raw parts a response is identified by. */
interface FingerprintParts {
  toolUseIds: string[]
  texts: string[]
  signatures: string[]
}

/**
 * Stable key for one assistant turn. Tool-use ids are unique server ids, so
 * they win when present; otherwise the non-blank text blocks; otherwise the
 * thinking signatures. Blank text blocks are skipped (the host's stream
 * assembler never stores them). `undefined` when nothing identifies it.
 */
function fingerprint(p: FingerprintParts): string | undefined {
  let raw: string
  if (p.toolUseIds.length > 0) raw = `tools\u0000${p.toolUseIds.join("\u0000")}`
  else if (p.texts.length > 0) raw = `text\u0000${p.texts.join("\u0000")}`
  else if (p.signatures.length > 0) raw = `sig\u0000${p.signatures.join("\u0000")}`
  else return undefined
  return createHash("sha256").update(raw).digest("hex")
}

function partsOfMessage(msg: CanonicalMessage): FingerprintParts {
  const parts: FingerprintParts = { toolUseIds: [], texts: [], signatures: [] }
  for (const b of msg.content) {
    if (b.type === "tool_use") parts.toolUseIds.push(b.id)
    else if (b.type === "text" && !b.sideband && b.text.trim().length > 0) parts.texts.push(b.text)
    else if (b.type === "thinking" && b.signature) parts.signatures.push(b.signature)
  }
  return parts
}

/**
 * The `previous_message_id` for this history: the recorded id of the LAST
 * assistant message, or `null` when there is none or it is unknown (e.g. a
 * response from another process, provider or a resumed session).
 */
export function previousMessageIdFor(messages: readonly CanonicalMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.role !== "assistant") continue
    const key = fingerprint(partsOfMessage(msg))
    if (!key) return null
    const id = idByFingerprint.get(key)
    if (id === undefined) return null
    // LRU touch.
    idByFingerprint.delete(key)
    idByFingerprint.set(key, id)
    return id
  }
  return null
}

/**
 * Drop every fingerprint that maps to `id`, so a history ending in that
 * response resolves to `null` afterwards. Called when the server rejected
 * `diagnostics.previous_message_id`, so a later retry of the same request
 * does not resend the rejected id.
 */
export function forgetMessageId(id: string): void {
  for (const [key, value] of idByFingerprint) {
    if (value === id) idByFingerprint.delete(key)
  }
}

function remember(key: string, id: string): void {
  idByFingerprint.delete(key)
  idByFingerprint.set(key, id)
  while (idByFingerprint.size > MAX_ENTRIES) {
    const oldest = idByFingerprint.keys().next().value
    if (oldest === undefined) break
    idByFingerprint.delete(oldest)
  }
}

/**
 * Observes one response stream and records `fingerprint → msg id` only on a
 * clean `message_stop` (no `stream_error` seen). One per request, so two
 * interleaved requests never mix their parts.
 */
export class ResponseChainRecorder {
  private messageId: string | undefined
  private failed = false
  private readonly texts = new Map<number, string>()
  private readonly toolUseIds: string[] = []
  private readonly signatures = new Map<number, string>()

  observe(ev: CanonicalEvent): void {
    switch (ev.type) {
      case "message_start":
        this.messageId = ev.messageId
        break
      case "text_delta":
        this.texts.set(ev.index, (this.texts.get(ev.index) ?? "") + ev.text)
        break
      case "text_stop":
        if (ev.finalText !== undefined) this.texts.set(ev.index, ev.finalText)
        break
      case "tool_use_start":
        this.toolUseIds.push(ev.id)
        break
      case "thinking_signature":
        this.signatures.set(ev.index, ev.signature)
        break
      case "stream_error":
        this.failed = true
        break
      case "message_stop":
        this.commit()
        break
    }
  }

  private commit(): void {
    if (this.failed || !this.messageId?.startsWith("msg_")) return
    const byIndex = (m: Map<number, string>) =>
      [...m.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
    const key = fingerprint({
      toolUseIds: this.toolUseIds,
      texts: byIndex(this.texts).filter((t) => t.trim().length > 0),
      signatures: byIndex(this.signatures),
    })
    if (key) remember(key, this.messageId)
  }
}

/**
 * CC classifies a 400 whose message includes `diagnostics.previous_message_id`
 * as `previous_message_id_invalid` (CC/chunk-wqb2b4v0.mjs).
 */
export function isPreviousMessageIdRejection(status: number, body: string): boolean {
  return status === 400 && body.includes("diagnostics.previous_message_id")
}
