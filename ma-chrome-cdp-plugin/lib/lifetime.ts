/**
 * Daemon lifetime helpers: client leases, the idle rule, env parsing, and a
 * pid liveness probe. Shared by the daemon (`bin/cdp-server.ts`) and the
 * `ChromeCDP` handler (which writes its lease).
 *
 * A lease is an empty-ish file `<lease dir>/<pid>`. A client process writes
 * one before its first daemon call. The daemon sweeps the dir on a timer,
 * removes the files of dead pids, and ends when no live lease is left and it
 * has been idle long enough.
 *
 * @module lib/lifetime
 */

import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** Default idle time (ms) before the daemon exits with no live lease. */
export const DEFAULT_IDLE_MS = 600_000
/** Default interval (ms) between lease sweeps. */
export const DEFAULT_LEASE_CHECK_MS = 30_000
/**
 * Default time (ms) after the user denied the connection (Chromium 403)
 * during which requests fail at once, with no new connect (no new dialog).
 */
export const DEFAULT_DENY_COOLDOWN_MS = 30_000
/** Default max age (ms) of a lease that its client did not refresh: 24 h. */
export const DEFAULT_LEASE_MAX_AGE_MS = 86_400_000
/** Default time (ms) a request waits for the first Chrome connect. */
export const DEFAULT_READY_TIMEOUT_MS = 15_000

/**
 * True when `pid` names a live process. Signal 0 tests existence only.
 * EPERM means the process exists but belongs to another user.
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

/** Parse a non-negative integer env value, else `fallback`. */
export function envInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : fallback
}

/** The lease dir of the daemon on `sock`: `override` when set, else `<sock>.leases`. */
export function leaseDirFor(sock: string, override?: string): string {
  return override !== undefined && override !== "" ? override : `${sock}.leases`
}

/**
 * Write (or refresh) the lease of `pid` (default: this process) into `dir`.
 * The body is `{"pid":N,"time":<epoch ms>}`. The client rewrites it on each
 * call, so `time` is the last use. Returns the lease file path.
 */
export function writeLease(dir: string, pid: number = process.pid): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, String(pid))
  writeFileSync(path, `${JSON.stringify({ pid, time: Date.now() })}\n`)
  return path
}

/**
 * The last-write time (epoch ms) of the lease at `path`: the `time` field,
 * a bare number (old format), else the file mtime. Undefined when unreadable.
 */
function leaseTime(path: string): number | undefined {
  try {
    const raw = readFileSync(path, "utf8").trim()
    if (raw !== "") {
      const v = JSON.parse(raw) as unknown
      if (typeof v === "number" && Number.isFinite(v)) return v
      if (typeof v === "object" && v !== null) {
        const t = (v as { time?: unknown }).time
        if (typeof t === "number" && Number.isFinite(t)) return t
      }
    }
  } catch {
    // not JSON: fall back to the mtime
  }
  try {
    return statSync(path).mtimeMs
  } catch {
    return undefined
  }
}

/**
 * Remove the stale leases in `dir` and count the live ones. A lease is stale
 * when its pid is dead, or when it is older than `maxAgeMs` (0 = no age
 * limit). The age rule stops a reused pid from keeping the daemon up for
 * ever: a real client refreshes its lease on each call. Names that are not a
 * pid are ignored. A missing dir counts as 0.
 */
export function sweepLeases(
  dir: string,
  alive: (pid: number) => boolean = pidAlive,
  maxAgeMs: number = DEFAULT_LEASE_MAX_AGE_MS,
  now: number = Date.now(),
): number {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  let live = 0
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    const path = join(dir, name)
    const time = maxAgeMs > 0 ? leaseTime(path) : undefined
    const tooOld = time !== undefined && now - time > maxAgeMs
    if (!tooOld && alive(Number(name))) {
      live++
      continue
    }
    try {
      unlinkSync(join(dir, name))
    } catch {
      // another sweeper removed it first
    }
  }
  return live
}

/** Inputs of {@link shouldIdleExit}. */
export interface IdleState {
  liveLeases: number
  /** Idle limit in ms. 0 turns the idle exit off. */
  idleMs: number
  lastActivity: number
  now: number
}

/** True when the daemon must exit: idle exit on, no live lease, idle limit passed. */
export function shouldIdleExit(s: IdleState): boolean {
  return s.idleMs > 0 && s.liveLeases === 0 && s.now - s.lastActivity >= s.idleMs
}
