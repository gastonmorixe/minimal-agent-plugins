/**
 * The message envelope: what one session appends to another's inbox. Pure
 * type + id generation + tolerant parse + validation. No IO.
 *
 * Envelopes are self-contained: the `from` block carries the sender's identity
 * inline, so a recipient never round-trips to the presence feed to know who
 * sent a message (and a message stays attributable even after the sender's
 * presence record is gone).
 *
 * @module lib/envelope
 */

import { isSafeSid, shortId } from "./identity.ts"

/** Message intent. Drives delivery behavior.
 * - `"message"` (default): queued if recipient is busy, wakes them if idle.
 * - `"interrupt"`: preempts the recipient mid-turn (when the host hook is built;
 *   currently same mechanism as message, with urgency branding).
 */
export type MessageKind = "message" | "interrupt"

/** Current envelope schema version. */
export const ENVELOPE_V = 1

/** The sender's self-contained identity, embedded in every envelope. */
export interface EnvelopeFrom {
  readonly sid: string
  readonly short: string
  readonly pid: number
  readonly host: string
  readonly cwd: string
  readonly model: string
  /**
   * Opt-in per-session agent display name (e.g. "Sergio"). OPTIONAL + absent when
   * naming is off. Cosmetic only: arrival notices / inbox renderers prefer
   * `Name (short)` when present, falling back to the short id alone.
   */
  readonly name?: string
}

/** One message. Appended verbatim (one JSON line) to `inbox/<to-sid>.jsonl`. */
export interface Envelope {
  readonly v: number
  /** `${fromShort}-${base36(ms)}-${rand4}` — unique, roughly time-sortable. */
  readonly id: string
  /** ISO timestamp. */
  readonly ts: string
  readonly kind: MessageKind
  readonly from: EnvelopeFrom
  /** Recipient session id (the inbox owner), OR a broadcast label for provenance. */
  readonly to: string
  /** Where the sender addressed it: a sid, "all", or "project". For display. */
  readonly scope: string
  readonly body: string
  /** Prior envelope id this replies to (display-only threading). */
  readonly replyTo?: string
}

/** Does a value look like a valid message kind? */
export function isMessageKind(v: unknown): v is MessageKind {
  return v === "message" || v === "interrupt"
}

/**
 * Max body length enforced at envelope build time.
 *
 * This is a SAFETY ceiling only — stop a runaway model from stuffing
 * multi-megabyte dumps into every peer's inbox / context. Normal
 * coordination messages (plans, reviews, handoffs) must fit comfortably.
 *
 * Historically this was ~3,500 to stay under PIPE_BUF so lock-free
 * `O_APPEND` writes stayed atomic. Concurrent appends for larger lines
 * are now serialized by a per-inbox exclusive lock in `lib/inbox.ts`, so
 * body size is no longer bound by 4096. Keep the clamp high enough that
 * real peer traffic is never clipped, and low enough that a pathological
 * loop cannot flood peers (256 KiB of body text per message).
 */
export const MAX_BODY_LEN = 256_000

/**
 * Generate an envelope id. Sortable-ish (base36 ms prefix per sender) and
 * unique with high probability. The id is the dedup primary key, so we use 32
 * bits of randomness (8 hex) rather than 16: a 16-bit suffix collides at ~1 in
 * 65k for two messages in the same millisecond from the same sender, which on a
 * busy broadcast is a real silent-drop risk. `nowMs`/`rand` injected for tests.
 */
export function makeEnvelopeId(
  fromShort: string,
  nowMs: number = Date.now(),
  rand: () => number = Math.random,
): string {
  const t = Math.floor(nowMs).toString(36)
  // Two 16-bit draws => 32 bits => 8 hex chars, independent of Math.random's
  // internal precision quirks. `>>> 0` forces UNSIGNED 32-bit (a bare `<<`
  // returns a signed int32, so a high bit would render as a "-…" string).
  const hi = Math.floor(rand() * 0x10000) & 0xffff
  const lo = Math.floor(rand() * 0x10000) & 0xffff
  const r = (((hi << 16) | lo) >>> 0).toString(16).padStart(8, "0")
  return `${fromShort}-${t}-${r}`
}

/** Inputs to {@link buildEnvelope}. */
export interface BuildEnvelopeInput {
  readonly from: EnvelopeFrom
  readonly to: string
  readonly scope: string
  readonly kind: MessageKind
  readonly body: string
  readonly replyTo?: string
  readonly nowMs?: number
  readonly rand?: () => number
}

/** Clip a body to {@link MAX_BODY_LEN}, marking the truncation. Pure. */
export function clampBody(body: string): string {
  if (body.length <= MAX_BODY_LEN) return body
  return `${body.slice(0, MAX_BODY_LEN)}…[truncated ${body.length - MAX_BODY_LEN} chars]`
}

/** Build a fully-formed envelope. Pure. Body is clamped at the safety ceiling. */
export function buildEnvelope(input: BuildEnvelopeInput): Envelope {
  const nowMs = Number.isFinite(input.nowMs) ? (input.nowMs as number) : Date.now()
  return {
    v: ENVELOPE_V,
    id: makeEnvelopeId(input.from.short, nowMs, input.rand),
    ts: new Date(nowMs).toISOString(),
    kind: input.kind,
    from: input.from,
    to: input.to,
    scope: input.scope,
    body: clampBody(input.body),
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
  }
}

/** Coerce an unknown parsed object into an {@link Envelope}, or null. */
export function coerceEnvelope(o: unknown): Envelope | null {
  if (o === null || typeof o !== "object") return null
  const r = o as Record<string, unknown>
  if (typeof r.id !== "string" || r.id.length === 0) return null
  if (typeof r.body !== "string") return null
  if (!isMessageKind(r.kind)) return null
  const f = r.from as Record<string, unknown> | null | undefined
  // `from.sid` is identity AND a potential path component (reply addressing),
  // so apply the same path-traversal guard used for presence records.
  if (f === null || typeof f !== "object" || !isSafeSid(f.sid)) return null
  const fromName =
    typeof f.name === "string" && f.name.trim().length > 0 ? f.name.trim().slice(0, 48) : undefined
  const from: EnvelopeFrom = {
    sid: f.sid,
    short: typeof f.short === "string" ? f.short : shortId(f.sid),
    pid: typeof f.pid === "number" ? f.pid : 0,
    host: typeof f.host === "string" ? f.host : "",
    cwd: typeof f.cwd === "string" ? f.cwd : "",
    model: typeof f.model === "string" ? f.model : "",
    ...(fromName ? { name: fromName } : {}),
  }
  return {
    v: typeof r.v === "number" ? r.v : ENVELOPE_V,
    id: r.id,
    ts: typeof r.ts === "string" ? r.ts : "",
    kind: r.kind,
    from,
    to: typeof r.to === "string" ? r.to : "",
    scope: typeof r.scope === "string" ? r.scope : typeof r.to === "string" ? r.to : "",
    body: r.body,
    ...(typeof r.replyTo === "string" && r.replyTo.length > 0 ? { replyTo: r.replyTo } : {}),
  }
}

/**
 * Parse an inbox JSONL blob into envelopes, tolerating blank lines, a torn
 * last line, and junk. Order preserved (append order == roughly time order).
 */
export function parseInbox(text: string): Envelope[] {
  const out: Envelope[] = []
  for (const line of text.split("\n")) {
    const t = line.trim()
    if (!t) continue
    try {
      const env = coerceEnvelope(JSON.parse(t))
      if (env) out.push(env)
    } catch {
      // skip torn/corrupt line
    }
  }
  return out
}

/** Serialize one envelope to its JSONL line (trailing newline included). */
export function serializeEnvelope(env: Envelope): string {
  return `${JSON.stringify(env)}\n`
}
