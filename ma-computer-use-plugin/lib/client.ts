/**
 * Client for the computer-use daemon over its unix domain socket, plus the
 * ensure-running lifecycle. The transport (a `fetch`-like fn) and the spawner
 * are injected so the handler logic is testable without a real daemon.
 *
 * Ported from ma-chrome-cdp-plugin/lib/client.ts (the proven pattern). The only
 * difference is the daemon we spawn is the Swift helper binary (one Mach-O
 * file), not a bun server.
 *
 * @module lib/client
 */

import { existsSync } from "node:fs"

import { logPath } from "./paths.ts"

export interface DaemonResponse {
  status: number
  body: unknown
}

/** Options of one socket request. */
export interface SocketFetchOptions {
  /** The time limit of the request in ms. The default is {@link REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number
}

/** A minimal fetch over the unix socket. Returns status + parsed JSON body. */
export type SocketFetch = (
  route: string,
  body?: Record<string, unknown>,
  opts?: SocketFetchOptions,
) => Promise<DaemonResponse>

/** The time limit of one daemon request (review R1: a stuck SCK callback blocks the daemon). */
export const REQUEST_TIMEOUT_MS = 30_000

/** The time limit of a liveness `ping`: a live daemon answers in some ms. */
export const PING_TIMEOUT_MS = 2_000

/** The request did not get an answer before its time limit. */
export class HelperTimeoutError extends Error {
  constructor(
    readonly route: string,
    readonly timeoutMs: number,
  ) {
    super(
      `the helper did not answer in ${formatSeconds(timeoutMs)} (action \`${route}\`). Try again. If it repeats, check the helper log: ${logPath()}`,
    )
    this.name = "HelperTimeoutError"
  }
}

/** `30 s` for 30000 ms, `0.02 s` for 20 ms. */
function formatSeconds(ms: number): string {
  return `${ms / 1000} s`
}

/** True for the error of an `AbortSignal.timeout` signal. */
function isTimeout(e: unknown): boolean {
  return e instanceof Error && e.name === "TimeoutError"
}

/** The part of `fetch` that the transport uses. A test injects a fake. */
export type FetchImpl = (url: string, init: RequestInit & { unix: string }) => Promise<Response>

/**
 * Real transport: Bun's fetch with the `unix` option. Each request has a time
 * limit (`AbortSignal.timeout`). A request after its limit rejects with a
 * {@link HelperTimeoutError}.
 *
 * @param sock - The unix socket path.
 * @param fetchImpl - The fetch to use (default: the global `fetch`).
 */
export function makeBunSocketFetch(
  sock: string,
  fetchImpl: FetchImpl = fetch as unknown as FetchImpl,
): SocketFetch {
  return async (route, body, opts) => {
    const timeoutMs = opts?.timeoutMs ?? REQUEST_TIMEOUT_MS
    const signal = AbortSignal.timeout(timeoutMs)
    let res: Response
    let parsed: unknown
    try {
      res = await fetchImpl(`http://localhost/${route}`, {
        unix: sock,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
        signal,
      })
      try {
        parsed = await res.json()
      } catch (e) {
        if (isTimeout(e) || signal.aborted) throw e
        parsed = null
      }
    } catch (e) {
      if (isTimeout(e) || signal.aborted) throw new HelperTimeoutError(route, timeoutMs)
      throw e
    }
    return { status: res.status, body: parsed }
  }
}

/**
 * The helper protocol that this client needs. The helper `ping` gives its own
 * `protocol` (Router.swift `protocolVersion`). A helper older than protocol 2
 * gives no `protocol`, and it has no `targets` route and no new screenshot modes.
 */
export const HELPER_PROTOCOL = 2

/** The time limit for an old helper to stop after SIGTERM. */
export const STOP_TIMEOUT_MS = 2_000

/** The parts of a `ping` answer that the lifecycle reads. */
export interface PingInfo {
  /** The helper protocol. Absent in a helper older than protocol 2. */
  protocol?: number
  /** The pid of the helper process, as the helper gives it. */
  pid?: number
}

/**
 * Read a `ping` answer.
 *
 * @param res - The answer of the `ping` route.
 * @returns The ping info, or null when the status is not 200.
 */
export function parsePing(res: DaemonResponse): PingInfo | null {
  if (res.status !== 200) return null
  const b = res.body
  if (b === null || typeof b !== "object") return {}
  const info: PingInfo = {}
  const { protocol, pid } = b as { protocol?: unknown; pid?: unknown }
  if (typeof protocol === "number") info.protocol = protocol
  if (typeof pid === "number") info.pid = pid
  return info
}

/** True when the helper speaks protocol `need` or newer. */
export function isCurrent(info: PingInfo, need: number = HELPER_PROTOCOL): boolean {
  return typeof info.protocol === "number" && info.protocol >= need
}

/** The result of {@link ensureDaemon}. */
export type EnsureResult = { ok: true } | { ok: false; header: string; error: string }

export interface EnsureDeps {
  sock: string
  /** Ping the daemon. Null when it does not answer. */
  probe?: () => Promise<PingInfo | null>
  /** Start the daemon process (exec the helper binary, detached). */
  spawn?: () => void
  /** Send a signal to a pid. Default: `process.kill`. */
  kill?: (pid: number, signal: NodeJS.Signals) => void
  /** Sleep between probes. */
  wait?: (ms: number) => Promise<void>
  /** Existence check for the socket file (fast pre-check). */
  socketExists?: (p: string) => boolean
  /** Max attempts to confirm liveness after spawning. */
  attempts?: number
  /** The time limit for an old helper to stop. Default {@link STOP_TIMEOUT_MS}. */
  stopTimeoutMs?: number
  /** The protocol that this client needs. Default {@link HELPER_PROTOCOL}. */
  protocol?: number
  /** The pid of this process. A ping with this pid is never killed. */
  selfPid?: number
  /** The daemon log path, for the error text. */
  logPath?: string
}

/** The protocol text of a ping, for an error. */
function protocolText(info: PingInfo): string {
  return info.protocol === undefined ? "no protocol" : `protocol ${info.protocol}`
}

/** The error code of a `process.kill` failure, if it has one. */
function errnoCode(e: unknown): string | undefined {
  if (e === null || typeof e !== "object") return undefined
  const code = (e as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

/**
 * Stop an old helper that holds the socket. Kill only the pid that its ping
 * gave. Then wait until the socket stops answering.
 *
 * @returns Null when the old helper stopped, else the error result.
 */
async function stopOldDaemon(
  info: PingInfo,
  deps: EnsureDeps,
  need: number,
): Promise<EnsureResult | null> {
  const header = "old helper"
  const what = `an old computer-use helper (${protocolText(info)}, this plugin needs protocol ${need}) holds the socket ${deps.sock}`
  const pid = info.pid
  const selfPid = deps.selfPid ?? process.pid
  if (pid === undefined || !Number.isInteger(pid) || pid <= 1 || pid === selfPid) {
    return {
      ok: false,
      header,
      error: `${what} and its ping gave no usable pid. Quit the ComputerUseHelper process (Activity Monitor), then try again.`,
    }
  }
  const kill = deps.kill ?? ((p, s) => void process.kill(p, s))
  try {
    kill(pid, "SIGTERM")
  } catch (e) {
    // ESRCH: the process stopped between the ping and the kill. Continue.
    if (errnoCode(e) !== "ESRCH") {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        ok: false,
        header,
        error: `${what}. Could not stop it (pid ${pid}): ${msg}. Quit the ComputerUseHelper process (Activity Monitor), then try again.`,
      }
    }
  }
  const wait = deps.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const socketExists = deps.socketExists ?? existsSync
  const probe = deps.probe ?? (async () => null)
  const limit = deps.stopTimeoutMs ?? STOP_TIMEOUT_MS
  const step = 100
  for (let t = 0; t < limit; t += step) {
    await wait(step)
    if (!socketExists(deps.sock) || (await probe()) === null) return null
  }
  return {
    ok: false,
    header,
    error: `${what}. It did not stop in ${formatSeconds(limit)} after SIGTERM (pid ${pid}). Quit the ComputerUseHelper process (Activity Monitor), then try again.`,
  }
}

/**
 * Ensure a current daemon is up.
 *
 * Strategy: ping first. A current helper (protocol {@link HELPER_PROTOCOL} or
 * newer) is kept. An old helper is stopped with SIGTERM to the pid of its
 * ping, then a new helper starts. With no answer, spawn, then ping again up to
 * `attempts` times. Pure control flow with injected effects.
 *
 * @param deps - The effects.
 * @returns `{ ok: true }`, or an error with a header and a text for the user.
 */
export async function ensureDaemon(deps: EnsureDeps): Promise<EnsureResult> {
  const probe = deps.probe ?? (async () => null)
  const wait = deps.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const socketExists = deps.socketExists ?? existsSync
  const attempts = deps.attempts ?? 12
  const need = deps.protocol ?? HELPER_PROTOCOL

  const first = socketExists(deps.sock) ? await probe() : null
  if (first !== null) {
    if (isCurrent(first, need)) return { ok: true }
    const stopped = await stopOldDaemon(first, deps, need)
    if (stopped !== null) return stopped
  }
  deps.spawn?.()
  for (let i = 0; i < attempts; i++) {
    await wait(300)
    const info = await probe()
    if (info === null) continue
    if (isCurrent(info, need)) return { ok: true }
    // Do not kill again: the helper that we started is old itself.
    return {
      ok: false,
      header: "old helper",
      error: `the computer-use helper answers with ${protocolText(info)}, but this plugin needs protocol ${need}. The helper binary is older than the plugin. Install a release where the two agree.`,
    }
  }
  const log = deps.logPath === undefined ? "" : ` Check the helper log: ${deps.logPath}`
  return {
    ok: false,
    header: "daemon unreachable",
    error: `the computer-use helper is not reachable and could not be started.${log}`,
  }
}
