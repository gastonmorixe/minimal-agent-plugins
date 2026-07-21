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
 * Inbox appends need real append semantics so concurrent senders interleave
 * as whole lines. `appendFileSync` is the write primitive; for bodies larger
 * than PIPE_BUF we also take a short exclusive sibling lock so two concurrent
 * multi-buffer writes cannot interleave mid-line (which would corrupt JSONL
 * and make `parseInbox` silently drop the message). Presence/cursor writers
 * (see `lib/presence.ts`, `lib/cursors.ts`) need atomic *replace*, which we get
 * with a temp-file + `renameSync`. And the heartbeat reads sub-1KB files every
 * 5s where a sync call is cheapest. So the node:fs sync surface is the right
 * tool here — this is a deliberate choice, not an un-migrated default.
 *
 * @module lib/inbox
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs"
import { dirname } from "node:path"

import { type Envelope, parseInbox, serializeEnvelope } from "./envelope.ts"

/** Sibling-lock suffix for exclusive inbox appends. */
const LOCK_SUFFIX = ".appendlock"

/**
 * How long we wait for a contended inbox append lock before giving up and
 * writing unlocked (best-effort). Inbox appends are sub-millisecond; multi-
 * second waits only happen if a holder crashed without unlinking.
 */
const LOCK_TIMEOUT_MS = 2_000

/** Age beyond which a leftover `.appendlock` is treated as stale and stolen. */
const LOCK_STALE_MS = 5_000

/** Backoff steps while waiting on a contended lock (last entry repeats). */
const LOCK_BACKOFF_MS: readonly number[] = [5, 10, 20, 40, 80, 100]

/** Sleep without spinning the event loop (Bun/Node both expose this). */
function sleepMs(ms: number): void {
  if (ms <= 0) return
  const bunSleep = (globalThis as { Bun?: { sleepSync?: (n: number) => void } }).Bun?.sleepSync
  if (typeof bunSleep === "function") {
    bunSleep(ms)
    return
  }
  const sab = new SharedArrayBuffer(4)
  const view = new Int32Array(sab)
  Atomics.wait(view, 0, 0, ms)
}

/**
 * Try to create `lockPath` exclusively. Returns true on success.
 * Steals the lock when it is older than {@link LOCK_STALE_MS}.
 */
function tryAcquireAppendLock(lockPath: string, nowMs: number): boolean {
  try {
    const fd = openSync(lockPath, "wx")
    try {
      // Tiny marker so a human can see who held it; content is not parsed.
      appendFileSync(fd, `${process.pid}\n${nowMs}\n`)
    } finally {
      closeSync(fd)
    }
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== "EEXIST") throw err
  }

  // Contended: steal if stale (mtime-based; no holder metadata required).
  try {
    const st = statSync(lockPath)
    const age = nowMs - st.mtimeMs
    if (age > LOCK_STALE_MS) {
      try {
        unlinkSync(lockPath)
      } catch {
        // lost the race to another stealer
      }
      try {
        const fd = openSync(lockPath, "wx")
        closeSync(fd)
        return true
      } catch {
        return false
      }
    }
  } catch {
    // lock vanished between EEXIST and stat — retry as free
    try {
      const fd = openSync(lockPath, "wx")
      closeSync(fd)
      return true
    } catch {
      return false
    }
  }
  return false
}

function releaseAppendLock(lockPath: string): void {
  try {
    unlinkSync(lockPath)
  } catch {
    // already gone
  }
}

/**
 * Run `fn` while holding the exclusive sibling lock for `path`.
 * If the lock cannot be acquired within {@link LOCK_TIMEOUT_MS}, `fn` still
 * runs (unlocked best-effort) so a wedged peer never permanently blocks
 * delivery — same at-least-once tradeoff as the rest of intercom.
 */
function withAppendLock(path: string, fn: () => void): void {
  const lockPath = `${path}${LOCK_SUFFIX}`
  mkdirSync(dirname(path), { recursive: true })
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let held = false
  let step = 0
  while (Date.now() < deadline) {
    if (tryAcquireAppendLock(lockPath, Date.now())) {
      held = true
      break
    }
    const wait = LOCK_BACKOFF_MS[Math.min(step, LOCK_BACKOFF_MS.length - 1)] ?? 100
    sleepMs(wait)
    step += 1
  }
  try {
    fn()
  } finally {
    if (held) releaseAppendLock(lockPath)
  }
}

/**
 * Append one envelope to a recipient's inbox file. Uses a short exclusive
 * sibling lock so concurrent multi-buffer appends cannot interleave mid-line
 * (bodies may exceed PIPE_BUF). Creates the dir/file on first use.
 */
export function appendEnvelope(path: string, env: Envelope): void {
  const line = serializeEnvelope(env)
  withAppendLock(path, () => {
    appendFileSync(path, line)
  })
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
