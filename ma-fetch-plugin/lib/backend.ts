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
import { isAbsolute, join } from "node:path"

import type { FetchConfig, FetchFormat, WaitUntil } from "./config.ts"

export interface BackendCallInput {
  url: string
  format: FetchFormat
  waitUntil: WaitUntil
  timeoutSec: number
  selector?: string
  evalExpr?: string
  /** Absolute directory under which the backend persists this call's
   *  session (cookies + localStorage). Already resolved + sandboxed by
   *  the handler — backends receive it verbatim, no further validation.
   *  Omitted → stateless one-shot fetch (default). */
  storageDir?: string
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
  /**
   * Why the call was aborted, when `aborted` is true. Lets the handler tell a
   * user-initiated cancel apart from an internal wall-clock watchdog kill (the
   * backend wedged past its own `--timeout`) and surface the right message.
   */
  abortReason?: "signal" | "watchdog" | "parent-exit"
  /** Set when the resolved backend script doesn't exist. */
  scriptMissing?: boolean
  /**
   * Set when no managed (or operator-overridden) binary could be resolved for
   * the backend. The dispatcher refuses to spawn rather than fall back to a
   * bare `PATH` lookup. The handler maps this to the same generic
   * `engine-unavailable` message as {@link scriptMissing}. See
   * {@link resolveBackendBin}.
   */
  binUnavailable?: boolean
}

/** Minimal subset of `Bun.spawn`'s return value we depend on. */
export interface SpawnedProcess {
  readonly stdout: ReadableStream<Uint8Array> | null
  readonly stderr: ReadableStream<Uint8Array> | null
  readonly exited: Promise<number>
  /** PID for process-group signaling. Optional so test fakes need not synthesize one. */
  readonly pid?: number
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
    /**
     * When true, the child is launched as its own process-group leader
     * (pgid=pid). Required for `process.kill(-pid, sig)` group-kill to
     * reach any helpers the backend may fork (e.g. a CDP-driven Chromium
     * subprocess). Bun honors this on POSIX; on Windows it's ignored.
     */
    detached?: boolean
  },
) => SpawnedProcess

export interface BackendDeps {
  spawnFn?: SpawnFn
  existsFn?: (path: string) => boolean
  /**
   * Test seam: override the parent-exit hook registrar. Default subscribes
   * to `process.on("exit"|"SIGINT"|"SIGTERM"|"SIGHUP")` so a wedged backend
   * gets killed when the agent itself goes away. Returns an unsubscribe.
   *
   * Without this hook the 2026-05-19 orphan obscura postmortem reproduces:
   * agent exits normally, backend keeps spinning, gets adopted by launchd
   * (PPID=1), burns 100% CPU until manually killed.
   */
  parentExitHook?: (onParentExit: () => void) => () => void
  /**
   * Outer wall-clock cap, in seconds, ADDED to `input.timeoutSec`. The
   * backend's own `--timeout` only gates navigation; this is the agent-side
   * defense against backend bugs that wedge past their own timeout.
   * Default 30s.
   */
  watchdogSlackSec?: number
  /** Test seam for the outer-watchdog timer (default: setTimeout). */
  setTimeoutFn?: (cb: () => void, ms: number) => TimerHandle
  /** Test seam paired with setTimeoutFn (default: clearTimeout). */
  clearTimeoutFn?: (handle: TimerHandle) => void
}

/**
 * Opaque handle returned by `setTimeout` and consumed by `clearTimeout`.
 * Aliased once at file scope so the type resolution is stable across
 * the file (both Bun's `Timer` and Node's `Timeout` are in scope through
 * `bun-types` + its transitive `@types/node`, and the same
 * `ReturnType<typeof setTimeout>` resolved repeatedly can pick different
 * overloads in different positions). Using one alias forces a single resolution.
 */
type TimerHandle = ReturnType<typeof setTimeout>

/** Default outer wall-clock slack added on top of `input.timeoutSec`. */
export const DEFAULT_WATCHDOG_SLACK_SEC = 30

/**
 * Default parent-exit hook: kill the child if the agent process itself is
 * exiting. Registers across `exit` and the common termination signals so
 * any path out (normal exit, SIGINT, SIGTERM, SIGHUP) takes the backend
 * down with it. Returns an unsubscribe to remove all handlers.
 */
export function defaultParentExitHook(onParentExit: () => void): () => void {
  const wrapped = () => {
    try {
      onParentExit()
    } catch {
      // never let our cleanup throw during shutdown
    }
  }
  process.on("exit", wrapped)
  process.on("SIGINT", wrapped)
  process.on("SIGTERM", wrapped)
  process.on("SIGHUP", wrapped)
  return () => {
    process.off("exit", wrapped)
    process.off("SIGINT", wrapped)
    process.off("SIGTERM", wrapped)
    process.off("SIGHUP", wrapped)
  }
}

/**
 * Kill a spawned backend. Tries the whole process group first (so any
 * children the backend forked get the signal too), falls back to a
 * single-pid kill via the SpawnedProcess.kill method.
 *
 * Mirrors the pattern in minimal-agent's own `src/tools.ts:execBash`
 * (commit 5e6bddf, memory #mp5cj7gt-11f1) where group-kill turned out
 * to be load-bearing for ever returning from `await proc.exited`.
 */
export function killBackend(proc: SpawnedProcess, signal: NodeJS.Signals): void {
  if (typeof proc.pid === "number" && proc.pid > 0) {
    try {
      process.kill(-proc.pid, signal)
      return
    } catch {
      // ESRCH / EPERM / non-POSIX - fall through to single-pid kill
    }
  }
  try {
    proc.kill(signal)
  } catch {
    // already exited, or no permission - nothing more we can do
  }
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
 * Resolve the absolute path to the backend's binary, fail-closed.
 *
 * The plugin NEVER runs a binary off the user's `PATH`: an `obscura` a user
 * happens to have installed is not the build this plugin pins, and silently
 * executing it is both a correctness and a supply-chain hazard. We only ever
 * run the copy the AGENT manages. Resolution order:
 *
 *   1. **Operator override.** `config.backends[backend].bin` (from
 *      `plugins["ma-fetch"].<backend>.bin`). An absolute path the operator
 *      deliberately set wins outright, including a local dev build. Used
 *      verbatim, presence not checked here (the operator owns that path).
 *   2. **Managed dir.** `<MINIMAL_AGENT_BIN_DIR>/<backend>`, where the env var
 *      is advertised by the host at boot and points at the directory the host
 *      provisions binaries into (`~/.minimal-agent/bin`). The plugin learns the
 *      location ONLY from this env var: it never hard-codes a home path and
 *      never scans the filesystem, because the home dir differs per install and
 *      the agent is the single party that knows where it installed things. We
 *      require the file to exist (the host provisions it before first use); a
 *      missing file resolves to `null` so the caller fails closed.
 *
 * Returns `null` when neither source yields a usable path. The caller turns
 * that into an `engine-unavailable` error rather than spawning a bare name and
 * letting the OS resolve it off `PATH`.
 *
 * Pure: no spawn, no env mutation. `existsFn` is injectable for tests.
 */
export function resolveBackendBin(
  config: FetchConfig,
  baseEnv: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  existsFn: (path: string) => boolean = existsSync,
): string | null {
  // (1) Operator override wins, verbatim.
  const override = config.backends[config.backend]?.bin
  if (override && override.length > 0) return override

  // (2) Managed dir advertised by the host. Absolute + present, or nothing.
  const binDir = baseEnv.MINIMAL_AGENT_BIN_DIR?.trim()
  if (!binDir || !isAbsolute(binDir)) return null
  const candidate = join(binDir, config.backend)
  return existsFn(candidate) ? candidate : null
}

/**
 * Build the `MA_FETCH_*` env block from config + per-call input.
 *
 * Inherits `process.env` so the backend keeps PATH, HOME, etc.; that
 * lets obscura find its own libraries and lets bun find itself. Then
 * layers our `MA_FETCH_*` block on top - these always win over any
 * pre-existing values.
 *
 * `MA_FETCH_BIN` is set from {@link resolveBackendBin}. When that returns
 * `null` (no override AND no managed binary) the var is LEFT UNSET on purpose,
 * so the backend's own "bin required" guard fires instead of falling back to a
 * bare `PATH` lookup. The dispatcher's `binUnavailable` pre-check normally
 * short-circuits before we ever spawn, so an unset var here is belt-and-braces.
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
  if (input.storageDir && input.storageDir.length > 0) {
    env.MA_FETCH_STORAGE_DIR = input.storageDir
  }
  // Plugin-config fields.
  if (config.userAgent) env.MA_FETCH_USER_AGENT = config.userAgent
  if (config.proxy) env.MA_FETCH_PROXY = config.proxy
  // Resolve the managed (or operator-overridden) binary path. Left unset when
  // neither is available so the backend refuses to run rather than reaching for
  // a `PATH` obscura. See resolveBackendBin.
  const bin = resolveBackendBin(config, baseEnv)
  if (bin && bin.length > 0) env.MA_FETCH_BIN = bin
  // Backend-specific extension paths. Joined by `\n` because newline is the
  // one byte POSIX paths cannot legally contain — safer than `:` (used in
  // PATH-style lists, would collide with `file:` or absolute paths
  // containing colons on weird filesystems). Backends that don't care about
  // extensions (anything non-obscura today) ignore this var.
  const extensions = config.backends[config.backend]?.extensions
  if (extensions && extensions.length > 0) {
    env.MA_FETCH_EXTENSIONS = extensions.join("\n")
  }
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
 * Three independent kill paths protect against orphan/wedge bugs:
 *
 *   1. **Caller AbortSignal** — Ctrl+C / mode-toggle / agent-side abort
 *      bus. Sends SIGTERM (group), escalates to SIGKILL after 2s.
 *   2. **Outer wall-clock watchdog** — agent-side cap at
 *      `input.timeoutSec + DEFAULT_WATCHDOG_SLACK_SEC`. If the backend
 *      blows past its own `--timeout` (its bug, not ours), we still
 *      reclaim the slot. `aborted` is reported as `"watchdog"` in
 *      stderr for postmortem clarity. Defense in depth for the
 *      2026-05-19 obscura wedge: a runaway V8 microtask loop made the
 *      backend ignore its own 30s timeout for 2½ hours.
 *   3. **Parent-exit hook** — `process.on("exit"|SIG{INT,TERM,HUP})`
 *      sends SIGKILL (group) to the backend. POSIX does not propagate
 *      parent death to children by default on macOS (no PR_SET_PDEATHSIG),
 *      so without this the backend gets reparented to launchd and
 *      keeps spinning.
 *
 * The backend is spawned with `detached: true` so it becomes its own
 * process-group leader; group-signaling reaches any helpers it forks.
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
  const parentExitHook = deps.parentExitHook ?? defaultParentExitHook
  // `setTimeout` / `clearTimeout` have two overloaded signatures in scope
  // (Bun's Timer-returning + Node's Timeout-returning, since `bun-types`
  // re-exports `@types/node`). `ReturnType<typeof setTimeout>` resolves
  // to different types at different positions, so we coerce the fallback
  // through `unknown` to match the deps' typed shape and keep the rest
  // of the function consistent.
  const setTimeoutFn: (cb: () => void, ms: number) => TimerHandle =
    deps.setTimeoutFn ?? (setTimeout as unknown as (cb: () => void, ms: number) => TimerHandle)
  const clearTimeoutFn: (handle: TimerHandle) => void =
    deps.clearTimeoutFn ?? (clearTimeout as unknown as (handle: TimerHandle) => void)
  const watchdogSlackSec = deps.watchdogSlackSec ?? DEFAULT_WATCHDOG_SLACK_SEC

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

  // Fail closed if the managed binary isn't resolvable. We NEVER spawn a bare
  // backend name and let it pick up a `PATH` obscura. Only the agent-managed
  // (or operator-overridden) binary is allowed to run. Checked here, before any
  // spawn, so the failure is a clean typed result instead of an opaque ENOENT
  // from deep inside the backend subprocess.
  if (!resolveBackendBin(config, process.env as Record<string, string | undefined>, exists)) {
    return {
      ok: false,
      exitCode: -1,
      stdout: "",
      stderr: `no managed binary resolved for backend "${config.backend}"`,
      backend: `${config.backend}.ts`,
      binUnavailable: true,
    }
  }

  const env = buildBackendEnv(config, input)
  const argv = ["bun", scriptPath]

  let proc: SpawnedProcess
  try {
    proc = spawn(argv, {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    })
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
  let abortReason: "signal" | "watchdog" | "parent-exit" | undefined
  let killEscalation: TimerHandle | undefined

  const doKill = (reason: "signal" | "watchdog" | "parent-exit") => {
    if (aborted) return
    aborted = true
    abortReason = reason
    killBackend(proc, "SIGTERM")
    killEscalation = setTimeoutFn(() => {
      killBackend(proc, "SIGKILL")
    }, 2000)
    // Avoid keeping the event loop alive just for the escalation timer.
    ;(killEscalation as unknown as { unref?: () => void }).unref?.()
  }

  // (1) Caller AbortSignal.
  const onAbort = () => doKill("signal")
  if (signal.aborted) {
    onAbort()
  } else {
    signal.addEventListener("abort", onAbort, { once: true })
  }

  // (2) Outer wall-clock watchdog.
  const watchdogMs = (input.timeoutSec + watchdogSlackSec) * 1000
  const watchdogHandle = setTimeoutFn(() => doKill("watchdog"), watchdogMs)
  ;(watchdogHandle as unknown as { unref?: () => void }).unref?.()

  // (3) Parent-exit hook. Synchronously SIGKILL on parent shutdown - we
  // don't have time for graceful SIGTERM-then-SIGKILL in an exit handler.
  const unsubscribeParentExit = parentExitHook(() => {
    if (typeof proc.pid === "number" && proc.pid > 0) {
      try {
        process.kill(-proc.pid, "SIGKILL")
      } catch {
        try {
          proc.kill("SIGKILL")
        } catch {}
      }
    } else {
      try {
        proc.kill("SIGKILL")
      } catch {}
    }
  })

  try {
    const [stdoutText, stderrText, exitCode] = await Promise.all([
      drainStream(proc.stdout),
      drainStream(proc.stderr),
      proc.exited,
    ])
    const watchdogAnnotation =
      abortReason === "watchdog"
        ? `\n[ma-fetch: outer watchdog fired at ${input.timeoutSec + watchdogSlackSec}s — backend wedged past its own --timeout]`
        : ""
    return {
      ok: exitCode === 0 && !aborted,
      exitCode,
      stdout: stdoutText,
      stderr: stderrText + watchdogAnnotation,
      backend: `${config.backend}.ts`,
      aborted: aborted || undefined,
      abortReason,
    }
  } finally {
    signal.removeEventListener("abort", onAbort)
    if (killEscalation) clearTimeoutFn(killEscalation)
    clearTimeoutFn(watchdogHandle)
    unsubscribeParentExit()
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
