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

import { existsSync, realpathSync, statSync } from "node:fs"

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

/**
 * The version of the helper code that this plugin ships with (review N1).
 * The helper `ping` gives its own `helperVersion` (Router.swift
 * `helperVersion`). {@link judgePing} replaces a helper with a lower number
 * and keeps a helper with a higher number, so two clients on one socket do
 * not stop the helper of the other. Bump it together with the Swift value.
 */
export const HELPER_VERSION = 3

/** The time limit for an old helper to stop after SIGTERM. */
export const STOP_TIMEOUT_MS = 2_000

/**
 * One version of a helper binary file (review M3). The helper `ping` gives
 * the identity of the file that it runs, read one time at its start
 * (Router.swift `HelperBinary`). The client compares it with the file that
 * it would start.
 */
export interface BinaryIdentity {
  /** The absolute path with no symlinks (`realpath`). */
  path: string
  /** The file size in bytes. */
  size: number
  /** The modification time in seconds since 1970, with a fraction. */
  mtime: number
}

/**
 * Two mtimes closer than this many seconds are the same. Swift gives the
 * mtime as a Double of seconds and Bun as a float of ms, so an exact compare
 * can fail on the last bit.
 */
export const MTIME_TOLERANCE_S = 0.001

/** The parts of a `ping` answer that the lifecycle reads. */
export interface PingInfo {
  /** The helper protocol. Absent in a helper older than protocol 2. */
  protocol?: number
  /** The version of the helper code. Absent in an older build: read it as 0. */
  helperVersion?: number
  /** The pid of the helper process, as the helper gives it. */
  pid?: number
  /** The binary that the helper runs. Absent in an older protocol-2 build. */
  binary?: BinaryIdentity
}

/** The binary identity in a ping body, or undefined when a field is missing. */
function parseBinary(v: unknown): BinaryIdentity | undefined {
  if (v === null || typeof v !== "object") return undefined
  const { path, size, mtime } = v as { path?: unknown; size?: unknown; mtime?: unknown }
  if (typeof path !== "string" || typeof size !== "number" || typeof mtime !== "number") {
    return undefined
  }
  return { path, size, mtime }
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
  const { protocol, helperVersion, pid, binary } = b as {
    protocol?: unknown
    helperVersion?: unknown
    pid?: unknown
    binary?: unknown
  }
  if (typeof protocol === "number") info.protocol = protocol
  if (typeof helperVersion === "number") info.helperVersion = helperVersion
  if (typeof pid === "number") info.pid = pid
  const id = parseBinary(binary)
  if (id !== undefined) info.binary = id
  return info
}

/** True when the helper speaks protocol `need` or newer. */
export function isCurrent(info: PingInfo, need: number = HELPER_PROTOCOL): boolean {
  return typeof info.protocol === "number" && info.protocol >= need
}

/** True when two identities name the same file version. */
export function sameBinary(a: BinaryIdentity, b: BinaryIdentity): boolean {
  return a.path === b.path && a.size === b.size && Math.abs(a.mtime - b.mtime) < MTIME_TOLERANCE_S
}

/**
 * Why a helper that answers the ping cannot serve this client:
 * 1. `ok`: it can serve.
 * 2. `protocol`: an old protocol, or none.
 * 3. `old-version`: a lower `helperVersion`, or none (an older build).
 * 4. `other-build`: the same `helperVersion` and the same path, but another
 *    size or mtime (a dev rebuild of the same version).
 */
export type PingVerdict = "ok" | "protocol" | "old-version" | "other-build"

/**
 * Judge a ping answer (reviews M3 and N1). The first rule that applies wins:
 *
 * a. No protocol, or a protocol lower than `need`: `protocol`.
 * b. A protocol higher than `need`: `ok`. Never stop a newer helper.
 * c. No `helperVersion`: read it as 0.
 * d. A `helperVersion` lower than `version`: `old-version`.
 * e. A `helperVersion` higher than `version`: `ok`.
 * f. The same version and the same path, with another size or mtime:
 *    `other-build`. The file changed after the helper started.
 * g. The same version at another path: `ok`. The code is the same version.
 *
 * The file mtime does not order two paths: it is the build or extract time,
 * not the age of the code. All checkouts and the compiled CLI share the
 * default socket, so an mtime rule made two sessions stop the helper of the
 * other on each call.
 *
 * With no `binary` to compare (the file cannot be read), only the protocol
 * counts (rules a and b). A spawn of a file that cannot be read can fail, so
 * do not stop a running helper for it.
 *
 * @param info - The ping info.
 * @param need - The protocol that this client speaks.
 * @param binary - The binary that this client would start.
 * @param version - The helper version that this client ships. Default {@link HELPER_VERSION}.
 */
export function judgePing(
  info: PingInfo,
  need: number,
  binary?: BinaryIdentity,
  version: number = HELPER_VERSION,
): PingVerdict {
  if (!isCurrent(info, need)) return "protocol"
  if ((info.protocol ?? 0) > need) return "ok"
  if (binary === undefined) return "ok"
  const running = info.helperVersion ?? 0
  if (running < version) return "old-version"
  if (running > version) return "ok"
  const file = info.binary
  if (file === undefined || file.path !== binary.path) return "ok"
  return sameBinary(file, binary) ? "ok" : "other-build"
}

/** `<path> (<size> bytes, mtime <mtime>)`, for an error. */
function describeBinary(b: BinaryIdentity): string {
  return `${b.path} (${b.size} bytes, mtime ${b.mtime})`
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
   * The identity of the helper binary that `spawn` starts (reviews M3 and
   * N1). A current helper with a lower `helperVersion`, or the same version
   * at this path with another size or mtime, is stopped and replaced
   * ({@link judgePing}). Unset: only the protocol counts.
   */
  binary?: BinaryIdentity
  /** The helper version that `spawn` starts. Default {@link HELPER_VERSION}. */
  helperVersion?: number
  /**
   * The key of the helper binary that `spawn` starts (path, size, mtime).
   * When a spawn of this key gave an old helper, a later call does not stop
   * the old helper again (review H3). Default: a key made from `binary`.
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

/** The helper version text of a ping, for an error. */
function versionText(info: PingInfo): string {
  return info.helperVersion === undefined
    ? "no helperVersion"
    : `helperVersion ${info.helperVersion}`
}

/** The helper version that this client ships. */
function shipped(deps: EnsureDeps): number {
  return deps.helperVersion ?? HELPER_VERSION
}

/** The error code of a `process.kill` failure, if it has one. */
function errnoCode(e: unknown): string | undefined {
  if (e === null || typeof e !== "object") return undefined
  const code = (e as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

/**
 * The first part of a stop error: which old helper holds the socket.
 *
 * @param verdict - Why the helper cannot serve (not `ok`).
 */
function oldHelperText(
  verdict: PingVerdict,
  info: PingInfo,
  deps: EnsureDeps,
  need: number,
): string {
  if (verdict === "protocol" || deps.binary === undefined) {
    return `an old computer-use helper (${protocolText(info)}, this plugin needs protocol ${need}) holds the socket ${deps.sock}`
  }
  if (verdict === "old-version" || info.binary === undefined) {
    return `an older computer-use helper (${versionText(info)}, this plugin ships helperVersion ${shipped(deps)}) holds the socket ${deps.sock}`
  }
  return `a computer-use helper from another build (it runs ${describeBinary(info.binary)}, this plugin starts ${describeBinary(deps.binary)}) holds the socket ${deps.sock}`
}

/**
 * Stop an old helper that holds the socket. Kill only the pid that its ping
 * gave. Then wait until the socket stops answering.
 *
 * @param info - The ping of the old helper. Only its pid gets the signal.
 * @param deps - The effects.
 * @param what - The first part of each error text ({@link oldHelperText}).
 * @returns Null when the old helper stopped, else the error result.
 */
async function stopOldDaemon(
  info: PingInfo,
  deps: EnsureDeps,
  what: string,
): Promise<EnsureResult | null> {
  const header = "old helper"
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
 * The error for a current helper that is not the binary of this plugin, when
 * a stop and a new spawn do not help (reviews M3 and N1).
 *
 * @param verdict - `old-version` or `other-build`.
 */
function mismatchError(verdict: PingVerdict, info: PingInfo, deps: EnsureDeps): EnsureResult {
  const header = "old helper"
  if (verdict === "old-version" || info.binary === undefined) {
    return {
      ok: false,
      header,
      error: `the computer-use helper answers with ${versionText(info)}, but this plugin ships helperVersion ${shipped(deps)}. The helper binary is older than the plugin. ${deps.oldBinaryHint ?? RELEASE_HINT}`,
    }
  }
  const expected = deps.binary === undefined ? "" : `, expected ${describeBinary(deps.binary)}`
  return {
    ok: false,
    header,
    error: `the computer-use helper on the socket ${deps.sock} does not give the binary that this plugin starts: it runs ${describeBinary(info.binary)}${expected}. Quit the ComputerUseHelper process (Activity Monitor), then try again.`,
  }
}

/** The error for a helper that cannot serve and must not be stopped again. */
function cannotServeError(
  verdict: PingVerdict,
  info: PingInfo,
  deps: EnsureDeps,
  need: number,
): EnsureResult {
  return verdict === "protocol"
    ? oldBinaryError(info, deps, need)
    : mismatchError(verdict, info, deps)
}

/** The key of one binary version for the H3 memory: path, size, mtime. */
function identityKey(deps: EnsureDeps): string | undefined {
  if (deps.binaryKey !== undefined) return deps.binaryKey
  const b = deps.binary
  return b === undefined ? undefined : `${b.path}:${b.size}:${b.mtime}`
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
  const key = identityKey(deps)

  // H1: a ping with no answer in time while the socket file exists means a
  // busy helper. Do not start a second helper over it, and do not kill it.
  if (state.kind === "timeout") return busyError(deps)
  if (state.kind === "answer") {
    const verdict = judgePing(state.info, need, deps.binary, shipped(deps))
    if (verdict === "ok") return { ok: true }
    // H3 and M3: this binary started a helper that could not serve before. A
    // kill and a new spawn give the same helper again, so stop here.
    if (key !== undefined && oldBinaries.has(key)) {
      return cannotServeError(verdict, state.info, deps, need)
    }
    const what = oldHelperText(verdict, state.info, deps, need)
    const stopped = await stopOldDaemon(state.info, deps, what)
    if (stopped !== null) return stopped
  }
  deps.spawn?.()
  for (let i = 0; i < attempts; i++) {
    await wait(300)
    const r = await probe()
    if (r.kind !== "answer") continue
    const verdict = judgePing(r.info, need, deps.binary, shipped(deps))
    if (verdict === "ok") return { ok: true }
    // Do not kill again: the helper that we started cannot serve itself.
    if (key !== undefined) oldBinaries.add(key)
    return cannotServeError(verdict, r.info, deps, need)
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
 * newer, and the binary of this plugin by {@link judgePing}) is kept. A ping
 * with no answer in time gives a "busy" error (no kill, no spawn). Else take
 * the spawn lock (when `lockPath` is set) and ping again, because another
 * caller can have started a helper meanwhile. An old helper (an old protocol,
 * a lower `helperVersion`, or a rebuild at the same path) is stopped with
 * SIGTERM to the pid of its ping, then a new helper starts.
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
  if (first.kind === "answer" && judgePing(first.info, need, deps.binary, shipped(deps)) === "ok") {
    return { ok: true }
  }
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

/** The file calls of {@link binaryIdentityOf}. Tests inject them. */
export interface IdentityFs {
  /** The path with no symlinks. Default: `realpathSync`. */
  realpath?: (p: string) => string
  /** The size and mtime. Default: `statSync`. */
  stat?: (p: string) => { size: number; mtimeMs: number }
}

/**
 * The identity of the helper binary that the handler would start (review
 * M3), in the same form as the `binary` field of the helper ping: the path
 * with no symlinks, the size, and the mtime in seconds. Undefined when the
 * file cannot be read.
 *
 * @param path - The helper binary (`helperBinary`, or `CUD_HELPER`).
 * @param fs - The file calls. Tests inject them.
 */
export function binaryIdentityOf(path: string, fs: IdentityFs = {}): BinaryIdentity | undefined {
  const realpath = fs.realpath ?? realpathSync
  const stat = fs.stat ?? statSync
  try {
    const real = realpath(path)
    const s = stat(real)
    return { path: real, size: s.size, mtime: s.mtimeMs / 1000 }
  } catch {
    return undefined
  }
}
