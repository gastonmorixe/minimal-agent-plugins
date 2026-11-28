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

import { existsSync, statSync } from "node:fs"

import { logPath } from "./paths.ts"
import { acquireLockWait } from "./spawn-lock.ts"

/** Wait `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

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

/**
 * The result of one liveness `ping` (review H1). Three kinds:
 * 1. `answer`: HTTP 200, with the ping info.
 * 2. `absent`: no helper answers. Bun fetch gives `ECONNREFUSED` for a socket
 *    file with no listener and `ENOENT` for no socket file. A status that is
 *    not 200 and every other error also count here, so a broken socket file
 *    is replaced, as before.
 * 3. `timeout`: the socket accepted the request, but no answer came in the
 *    time limit. The helper serves one request at a time, so it is busy.
 *    A new helper must not start over it.
 */
export type ProbeResult =
  | { kind: "answer"; info: PingInfo }
  | { kind: "absent" }
  | { kind: "timeout" }

/** No helper answers. */
export const ABSENT: ProbeResult = { kind: "absent" }

/** The helper did not answer in the ping time limit. */
export const TIMEOUT: ProbeResult = { kind: "timeout" }

/**
 * Ping the helper and sort the result into a {@link ProbeResult}.
 *
 * @param socketFetch - The transport. A time limit gives a {@link HelperTimeoutError}.
 * @param timeoutMs - The ping time limit. Default {@link PING_TIMEOUT_MS}.
 */
export async function probePing(
  socketFetch: SocketFetch,
  timeoutMs: number = PING_TIMEOUT_MS,
): Promise<ProbeResult> {
  let res: DaemonResponse
  try {
    res = await socketFetch("ping", undefined, { timeoutMs })
  } catch (e) {
    return e instanceof HelperTimeoutError ? TIMEOUT : ABSENT
  }
  const info = parsePing(res)
  return info === null ? ABSENT : { kind: "answer", info }
}

/** The result of {@link ensureDaemon}. */
export type EnsureResult = { ok: true } | { ok: false; header: string; error: string }

/**
 * Keys of helper binaries that started an old helper in this process (review
 * H3). A key names one file version (path, size, mtime), so a rebuild gives a
 * new key.
 */
const OLD_BINARIES = new Set<string>()

export interface EnsureDeps {
  sock: string
  /** Ping the daemon. Default: always {@link ABSENT}. */
  probe?: () => Promise<ProbeResult>
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
  /**
   * Spawn lock file, usually `<sock>.spawn.lock` (in the support dir for the
   * default socket). When set, only one caller (in any process) stops an old
   * helper or starts a new one at a time, and a waiter pings again first.
   * Unset: no lock.
   */
  lockPath?: string
  /** The time limit of one ping, for the stop wait. Default {@link PING_TIMEOUT_MS}. */
  pingTimeoutMs?: number
  /**
   * The key of the helper binary that `spawn` starts (path, size, mtime).
   * When a spawn of this key gave an old helper, a later call does not stop
   * the old helper again (review H3).
   */
  binaryKey?: string
  /** The keys of binaries that gave an old helper. Default: one set for the process. */
  oldBinaries?: Set<string>
  /** The last sentence of an "old binary" error. Default: install a release. */
  oldBinaryHint?: string
}

/** The default last sentence of an "old binary" error. */
export const RELEASE_HINT = "Install a release where the two agree."

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
  const wait = deps.wait ?? sleep
  const socketExists = deps.socketExists ?? existsSync
  const probe = deps.probe ?? (async () => ABSENT)
  const limit = deps.stopTimeoutMs ?? STOP_TIMEOUT_MS
  const pingLimit = deps.pingTimeoutMs ?? PING_TIMEOUT_MS
  const step = 100
  for (let t = 0; t < limit; t += step) {
    await wait(step)
    if (!socketExists(deps.sock)) return null
    const r = await probe()
    if (r.kind === "absent") return null
    // A ping with no answer in time: the helper still holds the socket (it
    // is busy or it stops slowly). Count the ping time against the limit.
    if (r.kind === "timeout") t += pingLimit
  }
  return {
    ok: false,
    header,
    error: `${what}. It did not stop in ${formatSeconds(limit)} after SIGTERM (pid ${pid}). Quit the ComputerUseHelper process (Activity Monitor), then try again.`,
  }
}

/** The log sentence of an error, or an empty text. */
function logText(deps: EnsureDeps): string {
  return deps.logPath === undefined ? "" : ` Check the helper log: ${deps.logPath}`
}

/** The error for a helper that holds the socket but did not answer the ping in time. */
function busyError(deps: EnsureDeps): EnsureResult {
  const log =
    deps.logPath === undefined ? "" : ` If it repeats, check the helper log: ${deps.logPath}`
  return {
    ok: false,
    header: "helper busy",
    error: `the computer-use helper is busy with another request, try again.${log}`,
  }
}

/** The error for a helper binary that is older than this plugin. */
function oldBinaryError(info: PingInfo, deps: EnsureDeps, need: number): EnsureResult {
  return {
    ok: false,
    header: "old helper",
    error: `the computer-use helper answers with ${protocolText(info)}, but this plugin needs protocol ${need}. The helper binary is older than the plugin. ${deps.oldBinaryHint ?? RELEASE_HINT}`,
  }
}

/**
 * The steps after the first ping, while the spawn lock is held.
 *
 * @param state - The ping result to act on.
 */
async function ensureFrom(
  state: ProbeResult,
  deps: EnsureDeps,
  need: number,
): Promise<EnsureResult> {
  const probe = deps.probe ?? (async () => ABSENT)
  const wait = deps.wait ?? sleep
  const attempts = deps.attempts ?? 12
  const oldBinaries = deps.oldBinaries ?? OLD_BINARIES

  // H1: a ping with no answer in time while the socket file exists means a
  // busy helper. Do not start a second helper over it, and do not kill it.
  if (state.kind === "timeout") return busyError(deps)
  if (state.kind === "answer") {
    if (isCurrent(state.info, need)) return { ok: true }
    // H3: this binary started an old helper before. A kill and a new spawn
    // give the same old helper again, so stop here.
    if (deps.binaryKey !== undefined && oldBinaries.has(deps.binaryKey)) {
      return oldBinaryError(state.info, deps, need)
    }
    const stopped = await stopOldDaemon(state.info, deps, need)
    if (stopped !== null) return stopped
  }
  deps.spawn?.()
  for (let i = 0; i < attempts; i++) {
    await wait(300)
    const r = await probe()
    if (r.kind !== "answer") continue
    if (isCurrent(r.info, need)) return { ok: true }
    // Do not kill again: the helper that we started is old itself.
    if (deps.binaryKey !== undefined) oldBinaries.add(deps.binaryKey)
    return oldBinaryError(r.info, deps, need)
  }
  return {
    ok: false,
    header: "daemon unreachable",
    error: `the computer-use helper is not reachable and could not be started.${logText(deps)}`,
  }
}

/**
 * Ensure a current daemon is up.
 *
 * Strategy: ping first. A current helper (protocol {@link HELPER_PROTOCOL} or
 * newer) is kept. A ping with no answer in time gives a "busy" error (no kill,
 * no spawn). Else take the spawn lock (when `lockPath` is set) and ping again,
 * because another caller can have started a helper meanwhile. An old helper
 * is stopped with SIGTERM to the pid of its ping, then a new helper starts.
 * With no answer, spawn, then ping again up to `attempts` times. The lock is
 * released on every path. Pure control flow with injected effects.
 *
 * @param deps - The effects.
 * @returns `{ ok: true }`, or an error with a header and a text for the user.
 */
export async function ensureDaemon(deps: EnsureDeps): Promise<EnsureResult> {
  const probe = deps.probe ?? (async () => ABSENT)
  const socketExists = deps.socketExists ?? existsSync
  const need = deps.protocol ?? HELPER_PROTOCOL
  const ping = async (): Promise<ProbeResult> => (socketExists(deps.sock) ? probe() : ABSENT)

  const first = await ping()
  if (first.kind === "answer" && isCurrent(first.info, need)) return { ok: true }
  if (first.kind === "timeout") return busyError(deps)
  if (deps.lockPath === undefined) return ensureFrom(first, deps, need)
  const release = await acquireLockWait(deps.lockPath)
  try {
    return await ensureFrom(await ping(), deps, need)
  } finally {
    release()
  }
}

/**
 * The key of one version of the helper binary: path, size and mtime. Null
 * when the file cannot be read.
 *
 * @param path - The helper binary.
 * @param stat - The stat call. Tests inject it.
 */
export function binaryKeyOf(
  path: string,
  stat: (p: string) => { size: number; mtimeMs: number } = statSync,
): string | undefined {
  try {
    const s = stat(path)
    return `${path}:${s.size}:${s.mtimeMs}`
  } catch {
    return undefined
  }
}
