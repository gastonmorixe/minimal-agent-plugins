/**
 * Inbox IO: append an envelope to a recipient's queue, and drain undelivered
 * envelopes from a cursor mark. Thin shell over `node:fs`; the pure parsing
 * lives in `lib/envelope.ts`.
 *
 * Delivery is at-least-once by construction: a reader drains, acts, THEN
 * advances its cursor. A crash between act and cursor-write replays the tail —
 * the model dedups on envelope `id` (taught in PROMPT.md). Better a duplicate
 * than a dropped interrupt.
 *
 * ## Why `node:fs` and not `Bun.write`/`Bun.file`
 *
 * Inbox appends need real `O_APPEND` semantics so concurrent senders interleave
 * atomically (our lines are well under PIPE_BUF). `appendFileSync` gives that
 * directly; `Bun.write` replaces a file's contents and has no append mode, so it
 * would lose messages under concurrency. Presence/cursor writers (see
 * `lib/presence.ts`, `lib/cursors.ts`) need atomic *replace*, which we get with
 * a temp-file + `renameSync`; `Bun.write` is not atomic-rename either. And the
 * heartbeat reads sub-1KB files every 5s where a sync call is cheapest. So the
 * node:fs sync surface is the right tool here — this is a deliberate choice, not
 * an un-migrated default. (Bun-native APIs like `Bun.Glob` / `Bun.file().json()`
 * shine for bulk scans and typed reads, which this hot path doesn't do.)
 *
 * @module lib/inbox
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"

import { type Envelope, parseInbox, serializeEnvelope } from "./envelope.ts"

/**
 * Append one envelope to a recipient's inbox file. Lock-free `O_APPEND`; our
 * lines are well under PIPE_BUF so concurrent appends from multiple senders
 * stay atomic and interleave cleanly. Creates the dir/file on first use.
 */
export function appendEnvelope(path: string, env: Envelope): void {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, serializeEnvelope(env))
}

/** Read + parse a recipient's whole inbox (empty when absent). */
export function readInbox(path: string): Envelope[] {
  if (!existsSync(path)) return []
  try {
    return parseInbox(readFileSync(path, "utf-8"))
  } catch {
    return []
  }
}

/** The result of draining an inbox from a cursor. */
export interface Drain {
  /** Envelopes after the cursor (undelivered). */
  readonly fresh: Envelope[]
  /** New high-water mark (total envelope count) to persist after acting. */
  readonly nextMark: number
  /** Total envelope count currently in the inbox. */
  readonly total: number
}

/**
 * Drain undelivered envelopes given a cursor mark (an envelope count).
 *
 * Returns everything at index ≥ `mark`, plus `nextMark = total` to persist
 * once the caller has acted. Pure given the parsed list, so callers can test
 * it without touching disk: pass the inbox array directly.
 */
export function drainFrom(envelopes: readonly Envelope[], mark: number): Drain {
  const total = envelopes.length
  const start = Math.min(Math.max(mark, 0), total)
  return { fresh: envelopes.slice(start), nextMark: total, total }
}

/** Convenience: read an inbox file and drain from a mark in one call. */
export function drainInbox(path: string, mark: number): Drain {
  return drainFrom(readInbox(path), mark)
}
