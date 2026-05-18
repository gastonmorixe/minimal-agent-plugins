/**
 * Backend dispatcher.
 *
 * Picks a backend script from `<packageDir>/backends/<config.backend>.ts`,
 * spawns it with an `MA_FETCH_*` env block, and shapes the captured
 * stdout/stderr/exit into a `BackendCallResult`. Backend swaps are a
 * config + filename change: no handler edit required.
 *
 * The pure helpers (`buildBackendEnv`, `resolveBackendPath`) are
 * exported so tests can exercise the bulk of the dispatch logic
 * without spawning a real subprocess. `callBackend` accepts a
 * `spawnFn` dependency for end-to-end mocking.
 *
 * @module lib/backend
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import type { FetchConfig, FetchFormat, WaitUntil } from "./config.ts"

export interface BackendCallInput {
  url: string
  format: FetchFormat
  waitUntil: WaitUntil
  timeoutSec: number
  selector?: string
  evalExpr?: string
}

export interface BackendCallResult {
  /** True iff exit code is 0 and the process wasn't aborted. */
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
  /** Backend filename used (e.g. "obscura.ts"). Useful for transcript footers. */
  backend: string
  /** Set when an abort signal fired. */
  aborted?: boolean
  /** Set when the resolved backend script doesn't exist. */
  scriptMissing?: boolean
}

/** Minimal subset of `Bun.spawn`'s return value we depend on. */
export interface SpawnedProcess {
  readonly stdout: ReadableStream<Uint8Array> | null
  readonly stderr: ReadableStream<Uint8Array> | null
  readonly exited: Promise<number>
  kill(signal?: NodeJS.Signals | number): boolean
}

/** Minimal subset of `Bun.spawn`'s call signature. */
export type SpawnFn = (
  argv: string[],
  options: {
    env: Record<string, string>
    stdin: "ignore"
    stdout: "pipe"
    stderr: "pipe"
  },
) => SpawnedProcess

export interface BackendDeps {
  spawnFn?: SpawnFn
  existsFn?: (path: string) => boolean
}

// ---------------------------------------------------------------------------
// Pure helpers (testable without spawn)
// ---------------------------------------------------------------------------

/** Resolve the absolute path to the backend script for a given config. */
export function resolveBackendPath(packageDir: string, backend: string): string {
  // `config.ts:parseFetchConfig` already restricts `backend` to a safe id,
  // but be defensive here too - this function may be reused.
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(backend)) {
    throw new Error(`invalid backend name: ${backend}`)
  }
  return join(packageDir, "backends", `${backend}.ts`)
}

/**
 * Build the `MA_FETCH_*` env block from config + per-call input.
 *
 * Inherits `process.env` so the backend keeps PATH, HOME, etc.; that
 * lets obscura find its own libraries and lets bun find itself. Then
 * layers our `MA_FETCH_*` block on top - these always win over any
 * pre-existing values.
 *
 * Pure: takes already-validated inputs, returns a fresh dict.
 */
export function buildBackendEnv(
  config: FetchConfig,
  input: BackendCallInput,
  baseEnv: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {}
  // Carry forward the base env, filtering out undefined entries (Node's
  // process.env may contain holes on some platforms).
  for (const [k, v] of Object.entries(baseEnv)) {
    if (typeof v === "string") env[k] = v
  }
  // Required fields.
  env.MA_FETCH_URL = input.url
  env.MA_FETCH_FORMAT = input.format
  env.MA_FETCH_WAIT_UNTIL = input.waitUntil
  env.MA_FETCH_TIMEOUT_SEC = String(input.timeoutSec)
  // Optional per-call fields.
  if (input.selector && input.selector.length > 0) env.MA_FETCH_SELECTOR = input.selector
  if (input.evalExpr && input.evalExpr.length > 0) env.MA_FETCH_EVAL = input.evalExpr
  // Plugin-config fields.
  if (config.userAgent) env.MA_FETCH_USER_AGENT = config.userAgent
  if (config.proxy) env.MA_FETCH_PROXY = config.proxy
  const bin = config.backends[config.backend]?.bin
  if (bin && bin.length > 0) env.MA_FETCH_BIN = bin
  return env
}

// ---------------------------------------------------------------------------
// IO orchestration
// ---------------------------------------------------------------------------

/**
 * Invoke the configured backend. Always resolves - failures are
 * encoded in the returned result (never thrown). The caller (handler)
 * decides how to shape them into a `tool_result`.
 *
 * Abort: when `signal` fires, sends SIGTERM and escalates to SIGKILL
 * after 2s. The returned result's `aborted` flag is set.
 */
export async function callBackend(
  packageDir: string,
  config: FetchConfig,
  input: BackendCallInput,
  signal: AbortSignal,
  deps: BackendDeps = {},
): Promise<BackendCallResult> {
  const exists = deps.existsFn ?? existsSync
  const spawn = deps.spawnFn ?? (Bun.spawn as unknown as SpawnFn)

  const scriptPath = resolveBackendPath(packageDir, config.backend)
  if (!exists(scriptPath)) {
    return {
      ok: false,
      exitCode: -1,
      stdout: "",
      stderr: `backend script not found: ${scriptPath}`,
      backend: `${config.backend}.ts`,
      scriptMissing: true,
    }
  }

  const env = buildBackendEnv(config, input)
  const argv = ["bun", scriptPath]

  let proc: SpawnedProcess
  try {
    proc = spawn(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  } catch (err) {
    return {
      ok: false,
      exitCode: -1,
      stdout: "",
      stderr: `failed to spawn backend: ${(err as Error).message}`,
      backend: `${config.backend}.ts`,
    }
  }

  let aborted = false
  let killEscalation: ReturnType<typeof setTimeout> | undefined
  const onAbort = () => {
    aborted = true
    try {
      proc.kill("SIGTERM")
    } catch {
      // ignore - process may have already exited
    }
    killEscalation = setTimeout(() => {
      try {
        proc.kill("SIGKILL")
      } catch {
        // ignore
      }
    }, 2000)
    // Avoid keeping the event loop alive just for the escalation timer.
    ;(killEscalation as unknown as { unref?: () => void }).unref?.()
  }

  if (signal.aborted) {
    onAbort()
  } else {
    signal.addEventListener("abort", onAbort, { once: true })
  }

  try {
    const [stdoutText, stderrText, exitCode] = await Promise.all([
      drainStream(proc.stdout),
      drainStream(proc.stderr),
      proc.exited,
    ])
    return {
      ok: exitCode === 0 && !aborted,
      exitCode,
      stdout: stdoutText,
      stderr: stderrText,
      backend: `${config.backend}.ts`,
      aborted: aborted || undefined,
    }
  } finally {
    signal.removeEventListener("abort", onAbort)
    if (killEscalation) clearTimeout(killEscalation)
  }
}

/** Drain a readable byte stream to a UTF-8 string. Empty string on null. */
async function drainStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return ""
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      total += value.byteLength
    }
  }
  const buf = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    buf.set(c, off)
    off += c.byteLength
  }
  return new TextDecoder("utf-8").decode(buf)
}
