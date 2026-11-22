/**
 * `message.willSend` (priority 100): replace each known paste ref in user
 * text with the wrapped, neutralized file content (PLAN 4.4).
 *
 * Rules:
 * - No codec or no `ctx.host.sessionFiles`: no change.
 * - Only `user` messages: string content and `text` blocks.
 * - Only top-level, self-closing refs with a valid id and a file in this
 *   session expand. All other nodes stay as they are.
 * - `bytes` and `lines` come from the file, never from the typed attrs.
 * - Copy on change: a changed block, message and messages array are new
 *   objects. Unchanged ones keep their identity. Core computes the output
 *   budget again only when the messages array is new (core B5).
 * - Never throws and never denies.
 *
 * @module handlers/expand_on_send
 */

import type { SessionFilesApi } from "@minimal-agent/core/plugin-api/types/host-capabilities"
import type { HookHandlerContext } from "@minimal-agent/core/plugin-api/types/plugin"
import type { SidebandApi, SidebandNode } from "@minimal-agent/core/plugin-api/types/sideband"

import { countLines, utf8Bytes } from "../lib/count.ts"
import { isPasteId } from "../lib/id.ts"

/** The sideband kind of a paste ref. */
export const PASTE_KIND = "paste"

const QUERY = { kinds: [PASTE_KIND] } as const

/** The send snapshot fields that this hook reads. Other fields pass through. */
export interface SendSnapshot {
  messages: Array<{ role: string; content: unknown }>
  [key: string]: unknown
}

/** The context fields that this hook reads. */
export type ExpandContext = Pick<HookHandlerContext, "sideband" | "host" | "agent" | "log">

/** The `(sid, id)` pairs that already sent a `paste.missing` warning in this process. */
const warned = new Set<string>()

/** Clear the warning memory (tests). */
export function resetMissingWarnings(): void {
  warned.clear()
}

interface Expander {
  sb: SidebandApi
  files: SessionFilesApi
  sid: string
  ctx: ExpandContext
}

function warnMissing(x: Expander, id: string): void {
  const key = `${x.sid}\u0000${id}`
  if (warned.has(key)) return
  warned.add(key)
  try {
    x.ctx.log?.warn("paste.missing", `no file for paste ref ${id}; the ref goes as text`, {
      id,
      sid: x.sid,
    })
  } catch {
    // A logger must not stop the send.
  }
}

/** The new text of one ref node, or undefined to keep the node. */
function expandNode(x: Expander, node: SidebandNode): string | undefined {
  if (!node.selfClosing) return undefined
  const id = node.attrs.id
  if (!isPasteId(id)) return undefined
  const content = x.files.read(x.sid, `${id}.txt`)
  if (content === null) {
    warnMissing(x, id)
    return undefined
  }
  return x.sb.render(PASTE_KIND, {
    attrs: { id, bytes: utf8Bytes(content), lines: countLines(content) },
    body: x.sb.neutralize(content),
  })
}

/** The expanded text, or the same string when nothing changed. */
function expandText(x: Expander, text: string): string {
  if (!x.sb.has(text, QUERY)) return text
  return x.sb.replace(text, (n) => expandNode(x, n), QUERY)
}

/** The new content, or the same value when nothing changed. */
function expandContent(x: Expander, content: unknown): unknown {
  if (typeof content === "string") return expandText(x, content)
  if (!Array.isArray(content)) return content
  let out: unknown[] | undefined
  for (let i = 0; i < content.length; i++) {
    const block = content[i] as { type?: unknown; text?: unknown } | null
    if (!block || typeof block !== "object" || block.type !== "text") continue
    if (typeof block.text !== "string") continue
    const next = expandText(x, block.text)
    if (next === block.text) continue
    out ??= content.slice()
    out[i] = { ...block, text: next }
  }
  return out ?? content
}

/**
 * HookBus `message.willSend` handler (default export for the manifest).
 *
 * @param snap - The outgoing send snapshot. The hook does not change it.
 * @param ctx - The hook context (`host: true` in the manifest).
 * @returns `{payload}` with a new messages array, or undefined (no change).
 */
export default function expandOnSend(
  snap: SendSnapshot,
  ctx: ExpandContext,
): { payload: SendSnapshot } | undefined {
  try {
    const sb = ctx.sideband
    const files = ctx.host?.sessionFiles
    const sid = ctx.agent?.sessionId
    if (!sb?.ready || !files || !sid) return undefined
    if (!snap || !Array.isArray(snap.messages)) return undefined
    const x: Expander = { sb, files, sid, ctx }
    let messages: SendSnapshot["messages"] | undefined
    for (let i = 0; i < snap.messages.length; i++) {
      const m = snap.messages[i]
      if (!m || m.role !== "user") continue
      const content = expandContent(x, m.content)
      if (content === m.content) continue
      messages ??= snap.messages.slice()
      messages[i] = { ...m, content }
    }
    return messages ? { payload: { ...snap, messages } } : undefined
  } catch (e) {
    try {
      ctx.log?.warn(
        "paste.expand",
        `expansion failed: ${e instanceof Error ? e.message : String(e)}`,
      )
    } catch {
      // Never throw.
    }
    return undefined
  }
}
