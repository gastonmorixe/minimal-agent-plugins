import { existsSync } from "node:fs"
import { basename, dirname, isAbsolute, relative, resolve } from "node:path"

import {
  type BackendCallInput,
  type BackendCallResult,
  DEFAULT_WATCHDOG_SLACK_SEC,
  defaultParentExitHook,
  killBackend,
  resolveBackendBin,
} from "./backend.ts"
import { type FetchConfig, SESSION_NAME_PATTERN } from "./config.ts"

const PROTOCOL_VERSION = 1
const MAX_STDOUT_BYTES = 96 * 1024 * 1024
const MAX_STDERR_BYTES = 64 * 1024
const HELLO_TIMEOUT_MS = 5_000

type TimerHandle = ReturnType<typeof setTimeout>

export interface BunFileSinkLike {
  write(chunk: Uint8Array): number | Promise<number>
  flush?(): number | Promise<number>
  end?(): number | Promise<number>
  close?(): void
}

export interface PersistentSpawnedProcess {
  readonly stdin: WritableStream<Uint8Array> | BunFileSinkLike | null
  readonly stdout: ReadableStream<Uint8Array> | null
  readonly stderr: ReadableStream<Uint8Array> | null
  readonly exited: Promise<number>
  readonly pid?: number
  kill(signal?: NodeJS.Signals | number): boolean
}

export type PersistentSpawnFn = (
  argv: string[],
  options: {
    env: Record<string, string>
    stdin: "pipe"
    stdout: "pipe"
    stderr: "pipe"
    detached: true
  },
) => PersistentSpawnedProcess

export interface PersistentWorkerDeps {
  spawnFn?: PersistentSpawnFn
  existsFn?: (path: string) => boolean
  parentExitHook?: (onParentExit: () => void) => () => void
  setTimeoutFn?: (cb: () => void, ms: number) => TimerHandle
  clearTimeoutFn?: (handle: TimerHandle) => void
  watchdogSlackSec?: number
}

export interface PersistentWorkerStatus {
  running: boolean
  pid?: number
  protocol?: number
}

export type PersistentCallResult =
  | { kind: "result"; result: BackendCallResult; workerPid?: number }
  | { kind: "fallback"; reason: string }

interface ProtocolResponse {
  v?: unknown
  id?: unknown
  ok?: unknown
  result?: unknown
  error?: unknown
}

interface PendingResponse {
  resolve: (response: ProtocolResponse) => void
  reject: (error: Error) => void
}

interface ProtocolWriter {
  write(chunk: Uint8Array): Promise<void>
  release(): void
}

function protocolWriter(stdin: WritableStream<Uint8Array> | BunFileSinkLike): ProtocolWriter {
  if ("getWriter" in stdin && typeof stdin.getWriter === "function") {
    const writer = stdin.getWriter()
    return {
      write: async (chunk) => {
        await writer.write(chunk)
      },
      release: () => writer.releaseLock(),
    }
  }
  const sink = stdin as BunFileSinkLike
  return {
    write: async (chunk) => {
      await sink.write(chunk)
      if (sink.flush) await sink.flush()
    },
    release: () => {
      try {
        sink.end?.()
      } catch {}
    },
  }
}

interface WorkerState {
  proc: PersistentSpawnedProcess
  writer: ProtocolWriter
  pending: Map<string, PendingResponse>
  stderr: string
  workerPath: string
  pid?: number
  protocol?: number
  supportedFormats?: string[]
  dead: boolean
  unsubscribeParentExit: () => void
}

export interface FetchProtocolParams {
  url: string
  format: Exclude<BackendCallInput["format"], "original">
  wait_until: BackendCallInput["waitUntil"]
  timeout_ms: number
  settle_ms: number
  selector: string | null
  eval: string | null
  session: string | null
  storage_dir: string | null
}

/** Resolve `obscura-worker` beside the configured or managed `obscura` binary. */
export function resolvePersistentWorkerPath(
  config: FetchConfig,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  existsFn: (path: string) => boolean = existsSync,
): string | null {
  const bin = resolveBackendBin(config, env, existsFn)
  if (!bin) return null
  const leaf = process.platform === "win32" ? "obscura-worker.exe" : "obscura-worker"
  return resolve(dirname(bin), leaf)
}

/** Translate the generic backend input into the private protocol's fetch params. */
export function toFetchProtocolParams(
  input: BackendCallInput,
  config: FetchConfig,
): FetchProtocolParams {
  if (input.format === "original") {
    throw new Error("original format is not supported by the persistent protocol")
  }

  let session: string | null = null
  let storageDir: string | null = null
  if (input.storageDir) {
    const root = resolve(config.storageRoot)
    const candidate = resolve(input.storageDir)
    const rel = relative(root, candidate)
    const leaf = basename(candidate)
    if (
      !isAbsolute(input.storageDir) ||
      rel.length === 0 ||
      rel.startsWith("..") ||
      isAbsolute(rel) ||
      rel !== leaf ||
      !SESSION_NAME_PATTERN.test(leaf)
    ) {
      throw new Error("session storage directory is outside the configured storage root")
    }
    session = leaf
    storageDir = candidate
  }

  return {
    url: input.url,
    format: input.format,
    wait_until: input.waitUntil,
    timeout_ms: input.timeoutSec * 1000,
    settle_ms: 5_000,
    selector: input.selector ?? null,
    eval: input.evalExpr ?? null,
    session,
    storage_dir: storageDir,
  }
}

function backendResult(
  fields: Omit<BackendCallResult, "backend" | "stdoutBytes"> & { stdoutBytes?: Uint8Array },
): BackendCallResult {
  return {
    ...fields,
    stdoutBytes: fields.stdoutBytes ?? new TextEncoder().encode(fields.stdout),
    backend: "obscura.ts",
  }
}

function protocolErrorText(response: ProtocolResponse): string {
  const error = response.error
  if (!error || typeof error !== "object" || Array.isArray(error)) return "protocol error"
  const record = error as Record<string, unknown>
  const code = typeof record.code === "string" ? record.code : "protocol_error"
  const message = typeof record.message === "string" ? record.message : "worker request failed"
  return `${code}: ${message}`
}

function appendBounded(current: string, chunk: string, maxBytes: number): string {
  const combined = current + chunk
  const bytes = Buffer.byteLength(combined)
  if (bytes <= maxBytes) return combined
  return Buffer.from(combined)
    .subarray(bytes - maxBytes)
    .toString("utf8")
}

/** Lazy, serialized owner of one parent-bound Obscura Fetch worker. */
export class PersistentWorkerClient {
  private state: WorkerState | null = null
  private nextId = 1
  private serial: Promise<void> = Promise.resolve()
  private readonly deps: Required<
    Pick<PersistentWorkerDeps, "existsFn" | "parentExitHook" | "setTimeoutFn" | "clearTimeoutFn">
  > &
    PersistentWorkerDeps

  constructor(deps: PersistentWorkerDeps = {}) {
    this.deps = {
      ...deps,
      existsFn: deps.existsFn ?? existsSync,
      parentExitHook: deps.parentExitHook ?? defaultParentExitHook,
      setTimeoutFn:
        deps.setTimeoutFn ?? (setTimeout as unknown as (cb: () => void, ms: number) => TimerHandle),
      clearTimeoutFn:
        deps.clearTimeoutFn ?? (clearTimeout as unknown as (handle: TimerHandle) => void),
    }
  }

  status(): PersistentWorkerStatus {
    const state = this.state
    return state && !state.dead
      ? { running: true, pid: state.pid, protocol: state.protocol }
      : { running: false }
  }

  call(
    config: FetchConfig,
    input: BackendCallInput,
    signal: AbortSignal,
  ): Promise<PersistentCallResult> {
    const task = this.serial.then(() => this.callSerialized(config, input, signal))
    this.serial = task.then(
      () => {},
      () => {},
    )
    return task
  }

  shutdown(): void {
    if (this.state) this.killState(this.state, "SIGKILL", new Error("worker shut down"))
  }

  private async callSerialized(
    config: FetchConfig,
    input: BackendCallInput,
    signal: AbortSignal,
  ): Promise<PersistentCallResult> {
    if (signal.aborted) {
      return {
        kind: "result",
        result: backendResult({
          ok: false,
          exitCode: 130,
          stdout: "",
          stderr: "request aborted before dispatch",
          aborted: true,
          abortReason: "signal",
        }),
      }
    }

    let params: FetchProtocolParams
    try {
      params = toFetchProtocolParams(input, config)
    } catch (error) {
      // Adapter rejection means this call cannot safely use the persistent
      // transport. Preserve the existing one-shot path rather than exposing a
      // new model-facing failure for otherwise-valid generic backend input.
      return { kind: "fallback", reason: (error as Error).message }
    }

    let state: WorkerState
    try {
      state = await this.ensureWorker(config)
    } catch (error) {
      return { kind: "fallback", reason: (error as Error).message }
    }

    if (input.format === "accessibility" && !state.supportedFormats?.includes("accessibility")) {
      return { kind: "fallback", reason: "worker does not support accessibility output" }
    }

    const id = String(this.nextId++)
    const request = { v: PROTOCOL_VERSION, id, op: "fetch", params }
    let dispatched = false
    let abortReason: "signal" | "watchdog" | undefined
    const watchdogMs =
      (input.timeoutSec + (this.deps.watchdogSlackSec ?? DEFAULT_WATCHDOG_SLACK_SEC)) * 1000
    let watchdog: TimerHandle | undefined

    const stop = (reason: "signal" | "watchdog") => {
      if (abortReason) return
      abortReason = reason
      this.killState(state, "SIGKILL", new Error(`worker ${reason}`))
    }
    const onAbort = () => stop("signal")
    signal.addEventListener("abort", onAbort, { once: true })
    watchdog = this.deps.setTimeoutFn(() => stop("watchdog"), watchdogMs)
    ;(watchdog as unknown as { unref?: () => void }).unref?.()

    try {
      // Conservatively count the request as dispatched before writing. A failed
      // write may still have delivered bytes, so this path is never replayed.
      dispatched = true
      const response = await this.send(state, request)
      if (response.ok !== true) {
        return {
          kind: "result",
          workerPid: state.pid,
          result: backendResult({
            ok: false,
            exitCode: 1,
            stdout: "",
            stderr: protocolErrorText(response),
          }),
        }
      }
      const result = response.result
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new Error("malformed fetch result")
      }
      const body = (result as Record<string, unknown>).body
      if (typeof body !== "string") throw new Error("fetch result omitted text body")
      return {
        kind: "result",
        workerPid: state.pid,
        result: backendResult({ ok: true, exitCode: 0, stdout: body, stderr: state.stderr }),
      }
    } catch (error) {
      if (!state.dead) this.killState(state, "SIGKILL", error as Error)
      const reason = abortReason
      return {
        kind: "result",
        workerPid: state.pid,
        result: backendResult({
          ok: false,
          exitCode: reason === "signal" ? 130 : 1,
          stdout: "",
          stderr:
            reason === "watchdog"
              ? `navigation_timeout: outer watchdog fired after ${watchdogMs}ms`
              : reason === "signal"
                ? "request aborted by signal"
                : `worker protocol failure after dispatch: ${(error as Error).message}`,
          aborted: reason ? true : undefined,
          abortReason: reason,
        }),
      }
    } finally {
      if (!dispatched && state.dead) this.state = null
      signal.removeEventListener("abort", onAbort)
      if (watchdog) this.deps.clearTimeoutFn(watchdog)
    }
  }

  private async ensureWorker(config: FetchConfig): Promise<WorkerState> {
    const expectedPath = resolvePersistentWorkerPath(
      config,
      process.env as Record<string, string | undefined>,
      this.deps.existsFn,
    )
    if (this.state && !this.state.dead) {
      if (this.state.workerPath === expectedPath) return this.state
      this.killState(this.state, "SIGKILL", new Error("worker configuration changed"))
    }
    this.state = null

    const workerPath = expectedPath
    if (!workerPath || !this.deps.existsFn(workerPath)) {
      throw new Error("persistent worker unavailable")
    }

    const spawn = this.deps.spawnFn ?? (Bun.spawn as unknown as PersistentSpawnFn)
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string") env[key] = value
    }
    env.OBSCURA_STEALTH = "1"
    env.OBSCURA_FETCH_WORKER_IDLE_TIMEOUT_SECS = String(
      config.backends.obscura?.workerIdleSec ?? 300,
    )
    if (config.proxy) env.OBSCURA_PROXY = config.proxy
    if (config.userAgent) env.OBSCURA_USER_AGENT = config.userAgent
    const extensions = config.backends.obscura?.extensions
    if (extensions && extensions.length > 0) {
      // Obscura currently supports one loaded extension per BrowserContext,
      // matching the one-shot CLI's "first extension wins" behavior.
      env.OBSCURA_FETCH_WORKER_EXTENSION = extensions[0]
    }

    let proc: PersistentSpawnedProcess
    try {
      proc = spawn([workerPath, "--fetch-protocol"], {
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      })
    } catch (error) {
      throw new Error(`persistent worker spawn failed: ${(error as Error).message}`, {
        cause: error,
      })
    }
    if (!proc.stdin || !proc.stdout) {
      try {
        proc.kill("SIGKILL")
      } catch {}
      throw new Error("persistent worker did not expose protocol streams")
    }

    const state: WorkerState = {
      proc,
      writer: protocolWriter(proc.stdin),
      pending: new Map(),
      stderr: "",
      workerPath,
      pid: proc.pid,
      dead: false,
      unsubscribeParentExit: () => {},
    }
    state.unsubscribeParentExit = this.deps.parentExitHook(() => {
      this.killState(state, "SIGKILL", new Error("parent exiting"))
    })
    this.state = state
    void this.readStdout(state)
    void this.readStderr(state)
    void proc.exited.then((code) => {
      this.invalidate(state, new Error(`worker exited with code ${code}`))
    })

    const helloId = String(this.nextId++)
    let timer: TimerHandle | undefined
    try {
      const helloPromise = this.send(state, { v: PROTOCOL_VERSION, id: helloId, op: "hello" })
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = this.deps.setTimeoutFn(
          () => reject(new Error("persistent worker hello timed out")),
          HELLO_TIMEOUT_MS,
        )
        ;(timer as unknown as { unref?: () => void }).unref?.()
      })
      const response = await Promise.race([helloPromise, timeoutPromise])
      if (response.ok !== true) throw new Error(protocolErrorText(response))
      const result = response.result
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new Error("malformed hello response")
      }
      const record = result as Record<string, unknown>
      if (record.protocol !== PROTOCOL_VERSION) throw new Error("unsupported worker protocol")
      if (!Array.isArray(record.operations) || !record.operations.includes("fetch")) {
        throw new Error("worker does not support fetch")
      }
      state.supportedFormats = Array.isArray(record.supported_formats)
        ? record.supported_formats.filter((format): format is string => typeof format === "string")
        : ["html", "text", "links", "markdown"]
      state.protocol = PROTOCOL_VERSION
      if (typeof record.pid === "number") state.pid = record.pid
      return state
    } catch (error) {
      this.killState(state, "SIGKILL", error as Error)
      throw error
    } finally {
      if (timer) this.deps.clearTimeoutFn(timer)
    }
  }

  private async send(state: WorkerState, message: object): Promise<ProtocolResponse> {
    if (state.dead) throw new Error("worker is not running")
    const id = (message as { id?: unknown }).id
    if (typeof id !== "string") throw new Error("protocol request id missing")
    const line = `${JSON.stringify(message)}\n`
    if (Buffer.byteLength(line) > 1024 * 1024) throw new Error("protocol request exceeds 1 MiB")

    const response = new Promise<ProtocolResponse>((resolveResponse, reject) => {
      state.pending.set(id, { resolve: resolveResponse, reject })
    })
    try {
      await state.writer.write(new TextEncoder().encode(line))
    } catch (error) {
      state.pending.delete(id)
      throw error
    }
    return response
  }

  private async readStdout(state: WorkerState): Promise<void> {
    const reader = state.proc.stdout?.getReader()
    if (!reader) return
    const decoder = new TextDecoder("utf-8", { fatal: true })
    let buffer = ""
    let bufferedBytes = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (!value) continue
        bufferedBytes += value.byteLength
        if (bufferedBytes > MAX_STDOUT_BYTES)
          throw new Error("worker stdout response exceeded limit")
        buffer += decoder.decode(value, { stream: true })
        while (true) {
          const newline = buffer.indexOf("\n")
          if (newline < 0) break
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          bufferedBytes = Buffer.byteLength(buffer)
          if (line.length === 0) continue
          const response = JSON.parse(line) as ProtocolResponse
          if (response.v !== PROTOCOL_VERSION || typeof response.id !== "string") {
            throw new Error("malformed worker response envelope")
          }
          const pending = state.pending.get(response.id)
          if (!pending) throw new Error("uncorrelated worker response")
          state.pending.delete(response.id)
          pending.resolve(response)
        }
      }
      if (buffer.length > 0) throw new Error("worker stdout ended mid-response")
      this.invalidate(state, new Error("worker stdout closed"))
    } catch (error) {
      this.killState(state, "SIGKILL", error as Error)
    }
  }

  private async readStderr(state: WorkerState): Promise<void> {
    const reader = state.proc.stderr?.getReader()
    if (!reader) return
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (value)
          state.stderr = appendBounded(state.stderr, decoder.decode(value), MAX_STDERR_BYTES)
      }
    } catch {
      // Diagnostics are best-effort and never affect protocol framing.
    }
  }

  private invalidate(state: WorkerState, error: Error): void {
    if (state.dead) return
    state.dead = true
    state.unsubscribeParentExit()
    try {
      state.writer.release()
    } catch {}
    for (const pending of state.pending.values()) pending.reject(error)
    state.pending.clear()
    if (this.state === state) this.state = null
  }

  private killState(state: WorkerState, signal: NodeJS.Signals, error: Error): void {
    if (!state.dead) killBackend(state.proc, signal)
    this.invalidate(state, error)
  }
}

let moduleClient: PersistentWorkerClient | null = null

/** Invoke the process-local lazy persistent worker. */
export function callPersistentBackend(
  config: FetchConfig,
  input: BackendCallInput,
  signal: AbortSignal,
): Promise<PersistentCallResult> {
  moduleClient ??= new PersistentWorkerClient()
  return moduleClient.call(config, input, signal)
}

/** Test/operator cleanup hook. The next eligible call starts a clean worker. */
export function shutdownPersistentWorker(): void {
  moduleClient?.shutdown()
  moduleClient = null
}

/** Return operator-visible worker liveness without starting it. */
export function persistentWorkerStatus(): PersistentWorkerStatus {
  return moduleClient?.status() ?? { running: false }
}
