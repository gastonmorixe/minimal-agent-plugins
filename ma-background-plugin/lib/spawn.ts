/**
 * The imperative shell around launching a runner process.
 *
 * Launching is funnelled through an injected {@link LaunchFn} so the service is
 * unit-testable with a fake (no real process). The production launcher
 * ({@link realLaunch}) is the one place that calls `Bun.spawn`: it starts the
 * runner DETACHED with `stdin: "pipe"`, and crucially KEEPS the write end open.
 * That open pipe is the harness-liveness link the runner watches for EOF.
 *
 * @module lib/spawn
 */

import { ENV } from "./runner-core.ts"
import { err, ok, type Result } from "./types.ts"

/** A handle to a launched runner: its pid + the still-open stdin write end. */
export interface RunnerHandle {
  /** The runner process id. */
  readonly pid: number
  /**
   * Close the runner's stdin write end. Calling this signals harness-death to
   * the runner (it sees EOF and tears the job down). Idempotent.
   */
  readonly closeStdin: () => void
}

/** Everything a launch needs. The runner reads these from its env. */
export interface LaunchSpec {
  /** Absolute path to `bin/runner.ts`. */
  readonly runnerPath: string
  /** How to invoke the agent runtime, e.g. `["bun", "run"]` or `[bunPath]`. */
  readonly runtime: readonly string[]
  readonly jobId: string
  readonly command: string
  readonly cwd: string
  readonly logPath: string
  readonly statusPath: string
  readonly timeoutMs: number
  /** Base env the runner inherits (PATH, HOME, ...). */
  readonly baseEnv: Record<string, string | undefined>
}

/** The injected launcher: start a runner, return its handle. May throw. */
export type LaunchFn = (spec: LaunchSpec) => RunnerHandle

/** Build the env block the runner reads. Pure. */
export function buildRunnerEnv(spec: LaunchSpec): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(spec.baseEnv)) {
    if (typeof v === "string") env[k] = v
  }
  env[ENV.JOB_ID] = spec.jobId
  env[ENV.COMMAND] = spec.command
  env[ENV.CWD] = spec.cwd
  env[ENV.LOG_PATH] = spec.logPath
  env[ENV.STATUS_PATH] = spec.statusPath
  env[ENV.TIMEOUT_MS] = String(spec.timeoutMs)
  return env
}

/** Build the argv to launch the runner. Pure. */
export function buildRunnerArgv(spec: LaunchSpec): string[] {
  return [...spec.runtime, spec.runnerPath]
}

/**
 * Launch a runner via the injected {@link LaunchFn}, wrapping failure in a
 * {@link Result} (no throw). Pure given the launcher.
 */
export function launchRunner(spec: LaunchSpec, launch: LaunchFn): Result<RunnerHandle> {
  try {
    return ok(launch(spec))
  } catch (e) {
    return err(`failed to launch runner: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * Production launcher: detached `Bun.spawn` with `stdin: "pipe"`. The returned
 * handle holds the FileSink so the caller (the registry) keeps the pipe open
 * for the job's lifetime, then `closeStdin()` to signal harness-death.
 *
 * NOTE: the runner's own stdout/stderr (diagnostics, not job output) are
 * ignored, the JOB's output goes to the log file the runner opens itself.
 */
export function realLaunch(spec: LaunchSpec): RunnerHandle {
  const env = buildRunnerEnv(spec)
  const argv = buildRunnerArgv(spec)
  const proc = (
    globalThis as unknown as {
      Bun: { spawn: (cmd: string[], o: object) => { pid: number; stdin: unknown } }
    }
  ).Bun.spawn(argv, {
    cwd: spec.cwd,
    env,
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
    // Detach the runner into its own process group: a user Ctrl-C (SIGINT to
    // the harness's group) must NOT kill the runner before it cleans up, the
    // runner exits via the stdin-EOF path instead, doing orderly teardown.
    detached: true,
  })
  let closed = false
  const sink = proc.stdin as { end?: () => void } | number | null
  return {
    pid: proc.pid,
    closeStdin: () => {
      if (closed) return
      closed = true
      try {
        if (sink && typeof sink !== "number" && typeof sink.end === "function") sink.end()
      } catch {
        // pipe already gone
      }
    },
  }
}
