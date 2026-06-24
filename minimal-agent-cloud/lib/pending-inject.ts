/**
 * Prompt injection + pendingId stamping — the bridge between a claimed pending
 * prompt and the CLI turn loop, and between the resulting user record and the
 * `pendingId` the cloud needs for reconciliation.
 *
 * ## Why a stamp-at-upload design (zero core change)
 *
 * The host's `prompt.inject` channel takes `{text, source?}` and routes it through
 * the normal submit path; the user record it writes is the core's own
 * `{kind,ts,content,id}` with NO pendingId field. Adding one would be a
 * minimal-agent CORE change. Instead we keep ALL the threading inside this plugin:
 *
 *   1. On claim, we inject the prompt content via `prompt.inject` AND remember the
 *      mapping `content -> pendingId` (a small pending-stamp queue).
 *   2. The host runs the turn and writes a normal `user` record (content == what
 *      we injected) to the local JSONL.
 *   3. The C2 uploader, before shipping each record, calls {@link stampPendingId}:
 *      the FIRST not-yet-stamped `user` record whose content matches a queued
 *      mapping gets `record.pendingId = P` added to the outgoing object.
 *   4. Mike stores it jsonb-verbatim; it surfaces on `recordAppended`; the web/
 *      mobile submitter reconciles; the server auto-resolves the pending row.
 *
 * Correlation is by content + claim order. Because only ONE CLI wins a claim
 * (optimistic lock) and the injected content is distinctive, a mismatch is
 * near-impossible; if a match is somehow missed, the record simply ships without
 * pendingId (the prompt still ran + uploaded; only the optimistic-UI reconcile is
 * lost, recoverable by the server's TTL/status surface).
 *
 * @module lib/pending-inject
 */

import type { ClaimedPrompt, PromptInjector } from "./pending.ts"

/** The host emit fn (the `prompt.inject` channel). Injected for testability. */
export type EmitFn = (channel: string, payload?: unknown) => void

/** Normalize a record/claim content to a comparable string for matching. */
function contentKey(content: unknown): string {
  if (typeof content === "string") return content
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

/**
 * Holds the claim→pendingId queue, injects claimed prompts, and stamps the
 * matching uploaded user records. One instance per session (the cloud plugin
 * keeps it for the session's lifetime).
 */
export class PendingInjector {
  /** FIFO of content-key + pendingId pairs awaiting a matching user record to stamp. */
  private readonly queue: { key: string; pendingId: string }[] = []

  constructor(private readonly emit: EmitFn) {}

  /**
   * A {@link PromptInjector} bound to this instance: inject the claimed prompt
   * into the turn loop and remember its pendingId for stamping. Pass this to
   * `drainAndClaim`.
   */
  readonly inject: PromptInjector = (prompt: ClaimedPrompt) => {
    const text = typeof prompt.content === "string" ? prompt.content : contentKey(prompt.content)
    if (text.trim().length === 0) return
    this.queue.push({ key: contentKey(prompt.content), pendingId: prompt.pendingId })
    // Route through the host's prompt.inject channel: enqueues as if the user
    // submitted it, fires between turns, survives crash/resume.
    this.emit("prompt.inject", { text, source: `cloud:pending:${prompt.pendingId}` })
  }

  /**
   * Stamp `pendingId` onto an outgoing record if it's the user record produced by
   * a claimed prompt. Returns the (possibly stamped) record to ship. Called by
   * the uploader for every record before send.
   *
   * Only `user` records are candidates; the first queued mapping whose content
   * matches is consumed (FIFO), so two identical prompts still resolve in order.
   */
  stampPendingId<T extends Record<string, unknown>>(record: T): T {
    if (this.queue.length === 0) return record
    if (record.kind !== "user") return record
    const key = contentKey(record.content)
    const idx = this.queue.findIndex((q) => q.key === key)
    if (idx === -1) return record
    const [match] = this.queue.splice(idx, 1)
    if (!match) return record
    return { ...record, pendingId: match.pendingId }
  }

  /** Number of injected-but-not-yet-stamped prompts (diagnostics/tests). */
  get pending(): number {
    return this.queue.length
  }
}
