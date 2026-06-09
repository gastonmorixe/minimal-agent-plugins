/**
 * Client for the computer-use daemon over its unix domain socket, plus the
 * ensure-running lifecycle. The transport (a `fetch`-like fn) and the spawner
 * are injected so the handler logic is testable without a real daemon.
 *
 * Ported from ma-chrome-cdp-plugin/lib/client.ts (the proven pattern). The only
 * difference is the daemon we spawn is the signed Swift .app, not a bun server.
 *
 * @module lib/client
 */

import { existsSync } from "node:fs"

export interface DaemonResponse {
  status: number
  body: unknown
}

/** A minimal fetch over the unix socket. Returns status + parsed JSON body. */
export type SocketFetch = (route: string, body?: Record<string, unknown>) => Promise<DaemonResponse>

/** Real transport: Bun's fetch with the `unix` option. */
export function makeBunSocketFetch(sock: string): SocketFetch {
  return async (route, body) => {
    const res = await fetch(`http://localhost/${route}`, {
      unix: sock,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
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

export interface EnsureDeps {
  sock: string
  /** Probe whether the daemon answers. Defaults to a ping over the socket. */
  ping?: () => Promise<boolean>
  /** Start the daemon process (exec the signed .app binary, detached). */
  spawn?: () => void
  /** Sleep between start and re-probe. */
  wait?: (ms: number) => Promise<void>
  /** Existence check for the socket file (fast pre-check). */
  socketExists?: (p: string) => boolean
  /** Max attempts to confirm liveness after spawning. */
  attempts?: number
}

/**
 * Ensure the daemon is up. Returns true if it is (or became) reachable.
 *
 * Strategy: ping first; if dead, spawn, then re-ping up to `attempts` times
 * with a short wait between. Pure control flow with injected effects.
 */
export async function ensureDaemon(deps: EnsureDeps): Promise<boolean> {
  const ping = deps.ping ?? (async () => false)
  const wait = deps.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const socketExists = deps.socketExists ?? existsSync
  const attempts = deps.attempts ?? 12

  if (socketExists(deps.sock) && (await ping())) return true
  deps.spawn?.()
  for (let i = 0; i < attempts; i++) {
    await wait(300)
    if (await ping()) return true
  }
  return false
}
