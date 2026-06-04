/**
 * Backend dispatcher (the speech "mechanism" layer).
 *
 * Picks a backend script from `<packageDir>/backends/<config.backend>.ts`,
 * spawns it DETACHED as its own process-group leader, feeds the utterance on
 * stdin, and hands back a {@link SpeechController} (pid + `stop()`) plus an
 * `exited` promise the caller wires to the registry's reaper.
 *
 * This is the mirror image of a normal tool backend: the process is meant to
 * OUTLIVE the tool call (the audio keeps playing after `Speak` returns), so we
 * never block on `proc.exited` here. We return immediately and let the handler
 * decide whether to await (the `wait: true` path) or fire-and-forget.
 *
 * Backend swaps are a config + filename change: drop `backends/<name>.ts`,
 * set `plugins["ma-speak"].backend`, done. The handler and this dispatcher
 * stay backend-agnostic; only the backend script knows a specific speech CLI.
 *
 * Pure helpers (`resolveBackendPath`, `buildSpeechEnv`, `killGroup`,
 * `defaultParentExitHook`) are exported so tests exercise the logic without a
 * real subprocess. `spawnSpeech` takes an injectable `spawnFn`.
 *
 * @module lib/backend
 */

import { existsSync } from "node:fs"
import { join } from "node:path"

import type { BackendConfig, SpeakConfig } from "./config.ts"
import { BACKEND_NAME_PATTERN } from "./config.ts"
import type { SpeechController } from "./registry.ts"

/** Text plus the per-backend knobs needed to speak it. */
export interface SpeechRequest {
  /** The text to read aloud (fed to the backend on stdin). */
  text: string
}

/** Result of a {@link spawnSpeech} attempt. */
export interface SpawnSpeechResult {
  /** True iff the backend process started. When false, see the other fields. */
  ok: boolean
  /** Backend filename used (e.g. "macos-say.ts"). For transcript footers. */
  backend: string
  /** Set when the resolved backend script does not exist (misconfig). */
  scriptMissing?: boolean
  /** Set when the spawn itself threw (e.g. interpreter missing). */
  spawnError?: string
  /** Process control handle. Present iff `ok`. */
  controller?: SpeechController
  /** Resolves when the backend process exits. Present iff `ok`. The caller
   *  uses it to settle the registry job (done / failed). */
  exited?: Promise<SpeechExit>
}

/** Outcome of a finished backend process. */
export interface SpeechExit {
  /** Exit code (0 = clean). A negative value encodes "killed by signal". */
  code: number
  /** Captured stderr (diagnostics). Never shown raw to the model. */
  stderr: string
  /** True when the process was terminated by our own stop()/parent-exit. */
  killed: boolean
}

/** Minimal subset of `Bun.spawn`'s return value we depend on. */
export interface SpawnedProcess {
  readonly stdin: { write(s: string): void; end(): void } | null
  readonly stderr: ReadableStream<Uint8Array> | null
  readonly exited: Promise<number>
  /** PID for process-group signaling. Optional so test fakes need not set it. */
  readonly pid?: number
  kill(signal?: NodeJS.Signals | number): boolean
}

/** Minimal subset of `Bun.spawn`'s call signature. */
export type SpawnFn = (
  argv: string[],
  options: {
    env: Record<string, string>
    stdin: "pipe"
    stdout: "ignore"
    stderr: "pipe"
    /** Launch the child as its own process-group leader so a group-kill
     *  reaches any helper it forks (the backend's underlying speech CLI). */
    detached?: boolean
  },
) => SpawnedProcess

/** Injectable dependencies for {@link spawnSpeech}. */
export interface SpeechDeps {
  spawnFn?: SpawnFn
  existsFn?: (path: string) => boolean
  /**
   * Override the parent-exit hook registrar. Default subscribes to
   * `process.on("exit"|"SIGINT"|"SIGTERM"|"SIGHUP")` so an in-flight speech
   * process is killed when the agent itself goes away (macOS does not
   * propagate parent death to children). Returns an unsubscribe.
   */
  parentExitHook?: (onParentExit: () => void) => () => void
  /** Test seam for the SIGTERM→SIGKILL escalation timer. */
  setTimeoutFn?: (cb: () => void, ms: number) => TimerHandle
  /** Test seam paired with setTimeoutFn. */
  clearTimeoutFn?: (handle: TimerHandle) => void
  /** Grace period (ms) between SIGTERM and the SIGKILL escalation on stop.
   *  Default 1500. */
  killGraceMs?: number
}

type TimerHandle = ReturnType<typeof setTimeout>

/** Default SIGTERM→SIGKILL grace period on stop, in ms. */
export const DEFAULT_KILL_GRACE_MS = 1500

/** Process events we attach the shared shutdown fan-out to. */
const PARENT_EXIT_EVENTS = ["exit", "SIGINT", "SIGTERM", "SIGHUP"] as const

/**
 * One shared set of per-job exit callbacks plus a single fan-out listener per
 * process event. Installed lazily on the first subscribe, torn down when the
 * last subscriber unsubscribes. This is what keeps the listener count flat
 * (4 total, not 4 per spawned utterance), so N concurrent jobs never trip
 * Node's MaxListenersExceededWarning or stack N copies of a signal handler.
 */
const parentExitCallbacks = new Set<() => void>()
let parentExitDispatch: (() => void) | null = null

function installParentExitDispatch(): void {
  if (parentExitDispatch) return
  const dispatch = () => {
    // Snapshot: a callback may unsubscribe (mutating the set) as it runs.
    for (const cb of [...parentExitCallbacks]) {
      try {
        cb()
      } catch {
        // never let cleanup throw during shutdown
      }
    }
  }
  parentExitDispatch = dispatch
  for (const ev of PARENT_EXIT_EVENTS) process.on(ev, dispatch)
}

function removeParentExitDispatch(): void {
  if (!parentExitDispatch) return
  for (const ev of PARENT_EXIT_EVENTS) process.off(ev, parentExitDispatch)
  parentExitDispatch = null
}

/**
 * Default parent-exit hook: kill the child when the agent process exits.
 * Each call registers `onParentExit` on a shared callback set that a single
 * per-event listener fans out to, across `exit` and the common termination
 * signals, so any path out takes the speech process down with it. Returns an
 * unsubscribe that drops just this callback (and removes the shared listeners
 * once the set is empty).
 */
export function defaultParentExitHook(onParentExit: () => void): () => void {
  const wrapped = () => onParentExit()
  parentExitCallbacks.add(wrapped)
  installParentExitDispatch()
  return () => {
    parentExitCallbacks.delete(wrapped)
    if (parentExitCallbacks.size === 0) removeParentExitDispatch()
  }
}

/**
 * Signal a spawned backend. Tries the whole process group first (negative
 * pid) so any helper the backend forked gets the signal too, then falls back
 * to a single-pid kill. Never throws.
 *
 * Mirrors the group-kill pattern minimal-agent uses for Bash and the fetch
 * backend, where reaching the grandchild is load-bearing.
 */
export function killGroup(proc: SpawnedProcess, signal: NodeJS.Signals): void {
  if (typeof proc.pid === "number" && proc.pid > 0) {
    try {
      process.kill(-proc.pid, signal)
      return
    } catch {
      // ESRCH / EPERM / non-POSIX — fall through to single-pid kill.
    }
  }
  try {
    proc.kill(signal)
  } catch {
    // already exited, or not signalable — nothing more to do
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (testable without spawn)
// ---------------------------------------------------------------------------

/** Resolve the absolute path to the backend script for a given config. */
export function resolveBackendPath(packageDir: string, backend: string): string {
  if (!BACKEND_NAME_PATTERN.test(backend)) {
    throw new Error(`invalid backend name: ${backend}`)
  }
  return join(packageDir, "backends", `${backend}.ts`)
}

/**
 * Build the `MA_SPEAK_*` env block from per-backend config.
 *
 * Inherits `process.env` so the backend keeps PATH, HOME, etc. (lets bun find
 * itself and the speech CLI), then layers our `MA_SPEAK_*` block on top. The
 * utterance text is NOT here: it travels on stdin, which dodges argv length
 * limits and keeps the text out of `ps` output.
 *
 * Pure: takes already-validated inputs, returns a fresh dict.
 */
export function buildSpeechEnv(
  backendCfg: BackendConfig | undefined,
  baseEnv: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(baseEnv)) {
    if (typeof v === "string") env[k] = v
  }
  if (backendCfg?.bin && backendCfg.bin.length > 0) env.MA_SPEAK_BIN = backendCfg.bin
  if (backendCfg?.voice && backendCfg.voice.length > 0) env.MA_SPEAK_VOICE = backendCfg.voice
  if (typeof backendCfg?.rate === "number") env.MA_SPEAK_RATE = String(backendCfg.rate)
  return env
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Spawn the configured speech backend for one utterance.
 *
 * Returns immediately with a controller and an `exited` promise. Never throws:
 * a missing script or spawn failure is encoded in the result so the handler
 * can shape it into a `tool_result`.
 *
 * Lifecycle protections:
 *   - The child is spawned `detached` (its own process group) so `stop()` and
 *     the parent-exit hook reach the underlying speech CLI via a group-kill.
 *   - A parent-exit hook SIGKILLs the group if the agent exits, so a long
 *     utterance can't outlive the agent and keep talking to a dead terminal.
 *   - The hook is unsubscribed once the process exits, so finished jobs don't
 *     pin process-level listeners.
 */
export function spawnSpeech(
  packageDir: string,
  config: SpeakConfig,
  request: SpeechRequest,
  deps: SpeechDeps = {},
): SpawnSpeechResult {
  const exists = deps.existsFn ?? existsSync
  const spawn = deps.spawnFn ?? (Bun.spawn as unknown as SpawnFn)
  const parentExitHook = deps.parentExitHook ?? defaultParentExitHook
  const setTimeoutFn: (cb: () => void, ms: number) => TimerHandle =
    deps.setTimeoutFn ?? (setTimeout as unknown as (cb: () => void, ms: number) => TimerHandle)
  const clearTimeoutFn: (handle: TimerHandle) => void =
    deps.clearTimeoutFn ?? (clearTimeout as unknown as (handle: TimerHandle) => void)
  const killGraceMs = deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS

  const backendFile = `${config.backend}.ts`
  const scriptPath = resolveBackendPath(packageDir, config.backend)
  if (!exists(scriptPath)) {
    return { ok: false, backend: backendFile, scriptMissing: true }
  }

  const env = buildSpeechEnv(config.backends[config.backend])
  const argv = ["bun", scriptPath]

  let proc: SpawnedProcess
  try {
    proc = spawn(argv, {
      env,
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
      detached: true,
    })
  } catch (err) {
    return { ok: false, backend: backendFile, spawnError: (err as Error).message }
  }

  // Feed the utterance on stdin, then close it so the backend can proceed.
  try {
    proc.stdin?.write(request.text)
    proc.stdin?.end()
  } catch {
    // If the child died before we could write, `exited` resolves below and
    // the handler reports a failure. Nothing to do here.
  }

  let killed = false
  let escalation: TimerHandle | undefined

  // Parent-exit safety: SIGKILL the group if the agent itself exits.
  const unsubscribeParentExit = parentExitHook(() => {
    killed = true
    if (typeof proc.pid === "number" && proc.pid > 0) {
      try {
        process.kill(-proc.pid, "SIGKILL")
        return
      } catch {
        // fall through to single-pid
      }
    }
    try {
      proc.kill("SIGKILL")
    } catch {
      // already gone
    }
  })

  const controller: SpeechController = {
    pid: typeof proc.pid === "number" ? proc.pid : 0,
    stop() {
      killed = true
      killGroup(proc, "SIGTERM")
      // Escalate to SIGKILL if SIGTERM didn't land within the grace window.
      escalation = setTimeoutFn(() => killGroup(proc, "SIGKILL"), killGraceMs)
      ;(escalation as unknown as { unref?: () => void }).unref?.()
    },
  }

  const exited: Promise<SpeechExit> = (async () => {
    const [code, stderr] = await Promise.all([proc.exited, drainStream(proc.stderr)])
    if (escalation) clearTimeoutFn(escalation)
    unsubscribeParentExit()
    return { code, stderr, killed }
  })()

  return { ok: true, backend: backendFile, controller, exited }
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
