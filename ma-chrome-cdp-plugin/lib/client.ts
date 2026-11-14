/**
 * Client for the CDP daemon over its unix domain socket, plus the
 * ensure-running lifecycle. The transport (a `fetch`-like fn) and the spawner
 * are injected so the handler logic is testable without a real daemon.
 *
 * @module lib/client
 */

import { existsSync } from "node:fs"

import { acquireLockWait } from "./spawn-lock.ts"

export interface DaemonResponse {
  status: number
  body: unknown
}

/** A minimal fetch over the unix socket. Returns status + parsed JSON body. */
export type SocketFetch = (route: string, body?: Record<string, unknown>) => Promise<DaemonResponse>

/**
 * Default timeout (ms) of a `ping` over the socket. It keeps the spawn lock
 * hold time in `ensureDaemon` well under the lock stale age, also when a
 * wedged daemon accepts the connection and never answers.
 */
export const DEFAULT_PING_TIMEOUT_MS = 2000

/** Options of {@link makeBunSocketFetch}. */
export interface SocketFetchOpts {
  /** Abort a `ping` after this many ms (default {@link DEFAULT_PING_TIMEOUT_MS}). */
  pingTimeoutMs?: number
}

/**
 * Real transport: Bun's fetch with the `unix` option. A `ping` is aborted
 * after `pingTimeoutMs`. Other routes have no client timeout: a CDP call can
 * take long, and the daemon bounds its own waits.
 */
export function makeBunSocketFetch(sock: string, opts: SocketFetchOpts = {}): SocketFetch {
  const pingTimeoutMs = opts.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS
  return async (route, body) => {
    const res = await fetch(`http://localhost/${route}`, {
      unix: sock,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      ...(route === "ping" ? { signal: AbortSignal.timeout(pingTimeoutMs) } : {}),
    } as RequestInit & { unix: string })
    let parsed: unknown
    try {
      parsed = await res.json()
    } catch {
      parsed = null
    }
    return { status: res.status, body: parsed }
  }
}

/**
 * True when a daemon answers `GET /ping` on `sock` within `timeoutMs`.
 * A missing socket or a socket with no listener gives false.
 */
export async function socketAnswers(sock: string, timeoutMs = 1000): Promise<boolean> {
  try {
    const res = await fetch("http://localhost/ping", {
      unix: sock,
      signal: AbortSignal.timeout(timeoutMs),
    } as RequestInit & { unix: string })
    return res.status === 200
  } catch {
    return false
  }
}

export interface EnsureDeps {
  sock: string
  /** Probe whether the daemon answers. Defaults to a ping over the socket. */
  ping?: () => Promise<boolean>
  /** Start the daemon process. */
  spawn?: () => void
  /** Sleep between start and re-probe. */
  wait?: (ms: number) => Promise<void>
  /** Existence check for the socket file (fast pre-check). */
  socketExists?: (p: string) => boolean
  /** Max attempts to confirm liveness after spawning. */
  attempts?: number
  /**
   * Spawn lock file, usually `<sock>.spawn.lock`. When set, only one caller
   * (in any process) spawns at a time, and a waiter re-pings before it
   * spawns. Unset: no lock (the old behavior).
   */
  lockPath?: string
}

/**
 * Ensure the daemon is up. Returns true if it is (or became) reachable.
 *
 * Strategy: ping first. If dead, take the spawn lock (when `lockPath` is
 * set), ping again (another caller may have spawned it), spawn, then re-ping
 * up to `attempts` times with a short wait between. The lock is released on
 * every path.
 */
export async function ensureDaemon(deps: EnsureDeps): Promise<boolean> {
  const ping = deps.ping ?? (async () => false)
  const wait = deps.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const socketExists = deps.socketExists ?? existsSync
  const attempts = deps.attempts ?? 10

  if (socketExists(deps.sock) && (await ping())) return true
  const release = deps.lockPath === undefined ? undefined : await acquireLockWait(deps.lockPath)
  try {
    if (release && (await ping())) return true
    deps.spawn?.()
    for (let i = 0; i < attempts; i++) {
      await wait(300)
      if (await ping()) return true
    }
    return false
  } finally {
    release?.()
  }
}
