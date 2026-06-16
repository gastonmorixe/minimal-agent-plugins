/**
 * Pure logic for the supervised runner (`bin/runner.ts`).
 *
 * The runner is a tiny detached process the harness launches per job. It owns
 * the job's log + status sidecar and is the thing whose lifetime is tied to the
 * harness by the stdin-EOF link. This module holds the PURE pieces: parsing the
 * env contract, building the job argv, and constructing each sidecar snapshot.
 * The executable wires these to real spawn / timers / fs.
 *
 * Env contract (harness to runner), all `MA_BG_*`:
 *   MA_BG_JOB_ID       the job handle ("j2")
 *   MA_BG_COMMAND      the shell command to run via `bash -c`
 *   MA_BG_CWD          working directory
 *   MA_BG_LOG_PATH     absolute path for the raw combined-output log
 *   MA_BG_STATUS_PATH  absolute path for the status sidecar
 *   MA_BG_TIMEOUT_MS   deadline in ms, "0" means no deadline
 *
 * @module lib/runner-core
 */

import type { Sidecar, SidecarPhase } from "./sidecar.ts"
import { err, ok, type Result } from "./types.ts"

/** Parsed, validated runner configuration. */
export interface RunnerConfig {
  readonly jobId: string
  readonly command: string
  readonly cwd: string
  readonly logPath: string
  readonly statusPath: string
  /** Deadline in ms; `0` means no deadline. */
  readonly timeoutMs: number
}

/** Env keys the harness stamps and the runner reads. */
export const ENV = {
  JOB_ID: "MA_BG_JOB_ID",
  COMMAND: "MA_BG_COMMAND",
  CWD: "MA_BG_CWD",
  LOG_PATH: "MA_BG_LOG_PATH",
  STATUS_PATH: "MA_BG_STATUS_PATH",
  TIMEOUT_MS: "MA_BG_TIMEOUT_MS",
} as const

/** Parse + validate the runner env contract. Pure. */
export function parseRunnerEnv(env: Record<string, string | undefined>): Result<RunnerConfig> {
  const jobId = env[ENV.JOB_ID]?.trim()
  if (!jobId) return err(`${ENV.JOB_ID} is required`)
  const command = env[ENV.COMMAND]
  if (command === undefined || command.length === 0) return err(`${ENV.COMMAND} is required`)
  const cwd = env[ENV.CWD]?.trim()
  if (!cwd) return err(`${ENV.CWD} is required`)
  const logPath = env[ENV.LOG_PATH]?.trim()
  if (!logPath) return err(`${ENV.LOG_PATH} is required`)
  const statusPath = env[ENV.STATUS_PATH]?.trim()
  if (!statusPath) return err(`${ENV.STATUS_PATH} is required`)

  const rawTimeout = env[ENV.TIMEOUT_MS]?.trim() ?? "0"
  const timeoutMs = Number.parseInt(rawTimeout, 10)
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    return err(`${ENV.TIMEOUT_MS} must be a non-negative integer, got "${rawTimeout}"`)
  }

  return ok({ jobId, command, cwd, logPath, statusPath, timeoutMs })
}

/** Build the argv for the job process. Pure. */
export function buildJobArgv(command: string): string[] {
  return ["bash", "-c", command]
}

/** Inputs shared by every sidecar snapshot. */
export interface SidecarBase {
  readonly jobId: string
  readonly startedAt: string
  readonly jobPid?: number
  readonly bytesLogged?: number
}

/** Build the `running` sidecar (written before/at job start). Pure. */
export function runningSidecar(base: SidecarBase): Sidecar {
  return sidecarOf("running", base, {})
}

/** Build the `exited` sidecar from a process result. Pure. */
export function exitedSidecar(
  base: SidecarBase,
  endedAt: string,
  result: { exitCode?: number; signal?: string },
): Sidecar {
  return sidecarOf("exited", base, {
    endedAt,
    ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
    ...(result.signal !== undefined ? { signal: result.signal } : {}),
  })
}

/** Build the `timedout` sidecar. Pure. */
export function timedoutSidecar(base: SidecarBase, endedAt: string, timeoutMs: number): Sidecar {
  return sidecarOf("timedout", base, { endedAt, timeoutMs })
}

/** Build the `stopped` sidecar (harness exit, or an explicit stop). Pure. */
export function stoppedSidecar(base: SidecarBase, endedAt: string, reason: string): Sidecar {
  return sidecarOf("stopped", base, { endedAt, reason })
}

/** Internal: assemble a sidecar with only the defined fields. */
function sidecarOf(
  phase: SidecarPhase,
  base: SidecarBase,
  extra: Partial<Pick<Sidecar, "endedAt" | "exitCode" | "signal" | "timeoutMs" | "reason">>,
): Sidecar {
  return {
    v: 1,
    id: base.jobId,
    phase,
    startedAt: base.startedAt,
    ...(base.jobPid !== undefined ? { jobPid: base.jobPid } : {}),
    ...(base.bytesLogged !== undefined ? { bytesLogged: base.bytesLogged } : {}),
    ...(extra.endedAt !== undefined ? { endedAt: extra.endedAt } : {}),
    ...(extra.exitCode !== undefined ? { exitCode: extra.exitCode } : {}),
    ...(extra.signal !== undefined ? { signal: extra.signal } : {}),
    ...(extra.timeoutMs !== undefined ? { timeoutMs: extra.timeoutMs } : {}),
    ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
  }
}

/** Reasons the runner records when it stops a job. */
export const STOP_REASON = {
  /** The harness process went away (stdin pipe closed). */
  HARNESS_EXIT: "harness exited (stdin closed)",
  /** The runner received an explicit termination signal (BackgroundStop). */
  SIGNALLED: "stopped by request",
  /** The runner was reparented (ppid changed): harness gone, EOF missed. */
  ORPHANED: "harness gone (reparented)",
} as const
