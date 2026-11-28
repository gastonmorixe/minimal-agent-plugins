/**
 * A small cross-process lock file, made with an exclusive create (`wx`).
 *
 * Ported from `ma-chrome-cdp-plugin/lib/spawn-lock.ts` (the same pattern).
 * The file holds `{pid, time, token}`. A lock is stale when its pid is dead
 * or it is older than `staleMs`. A stale lock is removed and the create is
 * tried once more. Release removes the file only while it still holds this
 * holder's token.
 *
 * `ensureDaemon` uses it as `<sock>.spawn.lock` (by default in the support
 * dir, next to the socket), so only one caller stops an old helper or starts
 * a new one at a time.
 *
 * Two changes from the chrome-cdp copy:
 * 1. `pidAlive` is in this file (this plugin has no `lifetime.ts`).
 * 2. A missing parent dir (ENOENT) is made once, and the create is tried
 *    again. The support dir does not exist before the first spawn.
 *
 * The lock fails open: an error other than EEXIST (after the ENOENT retry)
 * returns a no-op release, so a broken lock never blocks the tool.
 *
 * @module lib/spawn-lock
 */

import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import { dirname } from "node:path"

/** Default age (ms) after which a lock is stale even if its pid lives. */
export const DEFAULT_LOCK_STALE_MS = 10_000

/** Releases a held lock. */
export type Release = () => void

interface LockBody {
  pid: number
  time: number
  token: string
}

/**
 * True when `pid` names a live process. Signal 0 tests existence only.
 * EPERM means the process exists but belongs to another user.
 * See https://nodejs.org/api/process.html#processkillpid-signal.
 *
 * @param pid - The process id.
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

function readBody(path: string): Partial<LockBody> | undefined {
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown
    return typeof v === "object" && v !== null ? (v as Partial<LockBody>) : undefined
  } catch {
    return undefined
  }
}

/**
 * True when the lock at `path` is stale: dead pid, older than `staleMs`, or
 * unreadable and its mtime is older than `staleMs`. A missing file is stale.
 *
 * @param path - The lock file.
 * @param staleMs - Age after which a lock of a live pid is stale.
 * @param now - The time now, in ms.
 * @param alive - The pid check. Tests inject it.
 */
export function isLockStale(
  path: string,
  staleMs: number = DEFAULT_LOCK_STALE_MS,
  now: number = Date.now(),
  alive: (pid: number) => boolean = pidAlive,
): boolean {
  const body = readBody(path)
  if (body && typeof body.pid === "number" && typeof body.time === "number") {
    return !alive(body.pid) || now - body.time > staleMs
  }
  // Half-written or foreign content: judge by the file age.
  try {
    return now - statSync(path).mtimeMs > staleMs
  } catch {
    return true
  }
}

function release(path: string, token: string): void {
  if (readBody(path)?.token !== token) return
  try {
    unlinkSync(path)
  } catch {
    // already gone
  }
}

function readRaw(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

/**
 * Break the stale lock at `path` whose content was `staleRaw` when it was
 * judged stale. `renameSync` is atomic, so only one breaker moves a given
 * file. The mover then checks that it moved the stale file and not a fresh
 * lock that another breaker made in the meantime. A fresh lock is put back
 * with `linkSync` (fails with EEXIST, never overwrites), then the moved name
 * is removed.
 */
function breakStaleLock(path: string, staleRaw: string | undefined, token: string): void {
  const moved = `${path}.stale.${token}`
  try {
    renameSync(path, moved)
  } catch {
    // another breaker moved it first
    return
  }
  if (readRaw(moved) !== staleRaw) {
    try {
      linkSync(moved, path)
    } catch {
      // a third caller holds the path now
    }
  }
  try {
    unlinkSync(moved)
  } catch {
    // already gone
  }
}

/** Make the parent dir of `path`. True when the create can be tried again. */
function makeParent(path: string): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true })
    return true
  } catch {
    return false
  }
}

/**
 * Try once to take the lock. Returns a release fn, or undefined when a live
 * holder has it. A stale lock is broken (see `breakStaleLock`) and the
 * create is tried again.
 *
 * @param path - The lock file.
 * @param staleMs - Age after which a lock of a live pid is stale.
 * @param onStale - Test seam: runs after the lock is judged stale and before
 *   it is broken, so a test can interleave a second breaker.
 */
export function tryAcquireLock(
  path: string,
  staleMs: number = DEFAULT_LOCK_STALE_MS,
  onStale?: () => void,
): Release | undefined {
  let madeParent = false
  for (let i = 0; i < 3; i++) {
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    let fd: number
    try {
      fd = openSync(path, "wx")
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === "ENOENT" && !madeParent) {
        madeParent = true
        if (makeParent(path)) continue
      }
      if (code !== "EEXIST") return () => {}
      const staleRaw = readRaw(path)
      if (!isLockStale(path, staleMs)) return undefined
      // isLockStale read the file again: keep its view only if it did not change.
      if (readRaw(path) !== staleRaw) continue
      onStale?.()
      breakStaleLock(path, staleRaw, token)
      continue
    }
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, time: Date.now(), token }))
    } finally {
      closeSync(fd)
    }
    return () => release(path, token)
  }
  return undefined
}

/**
 * Take the lock, polling every `pollMs` until `timeoutMs`. After the timeout
 * it returns a no-op release (fail open).
 *
 * @param path - The lock file.
 * @param timeoutMs - The longest wait for a live holder.
 * @param pollMs - The time between tries.
 * @param staleMs - Age after which a lock of a live pid is stale.
 */
export async function acquireLockWait(
  path: string,
  timeoutMs: number = DEFAULT_LOCK_STALE_MS + 2000,
  pollMs = 50,
  staleMs: number = DEFAULT_LOCK_STALE_MS,
): Promise<Release> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const r = tryAcquireLock(path, staleMs)
    if (r) return r
    if (Date.now() >= end) return () => {}
    await new Promise((res) => setTimeout(res, pollMs))
  }
}
