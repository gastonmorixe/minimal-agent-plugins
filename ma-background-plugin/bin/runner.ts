#!/usr/bin/env bun
/**
 * The supervised background-job runner.
 *
 * One runner process per job, launched DETACHED by the harness (the plugin
 * handler) with `stdin: "pipe"`. The harness holds the write end of that pipe
 * open and never writes to it. This file:
 *
 *   1. spawns the real `bash -c "<command>"` as a child in its OWN process group
 *      (detached) so we can group-kill its descendants,
 *   2. streams combined stdout+stderr to the durable log file (raw bytes, ANSI
 *      preserved),
 *   3. writes a `<jobId>.status.json` sidecar on every transition,
 *   4. enforces the timeout (SIGTERM, then a grace period, then SIGKILL),
 *   5. watches its OWN stdin: when the harness dies by ANY means (including
 *      SIGKILL), the OS closes the write end, stdin emits `end`/`close`, and the
 *      runner group-kills the job and exits.
 *
 * Layered cleanup (defense in depth):
 *   - stdin EOF  : foolproof, survives a harness SIGKILL (no JS needed there).
 *   - ppid poll  : if reparented to init (ppid === 1), self-terminate.
 *   - own signals: SIGTERM/SIGINT/SIGHUP forwarded to the job, recorded as a stop.
 *   - group drain: when the leader exits (by itself or on a stop), the runner
 *     signals the rest of its group (SIGTERM, grace, SIGKILL) and exits only
 *     when the group is empty. So a `cmd &` daemon dies with the job. A job
 *     that wants a survivor must start it with `setsid` (out of our reach).
 *
 * This file is the imperative shell. Its logic lives in `lib/runner-core.ts`
 * (pure, unit-tested). It exports only {@link main}, so a compiled binary can
 * dispatch it (`<binary> __run ma-bg/runner`) from its embedded script
 * map. Run directly (`bun bin/runner.ts`), the `import.meta.main` guard below
 * calls `main` and exits with its code. The caller must `process.exit` with
 * the returned code: the stdin watcher keeps the event loop alive.
 *
 * @module bin/runner
 */

import { mkdirSync, openSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import { childEnv } from "@minimal-agent/core/plugin-api/utils/self-spawn"

import {
  buildJobArgv,
  exitedSidecar,
  parseRunnerEnv,
  runningSidecar,
  type SidecarBase,
  STOP_REASON,
  stoppedSidecar,
  timedoutSidecar,
} from "../lib/runner-core.ts"
import { type Sidecar, serializeSidecar } from "../lib/sidecar.ts"

const KILL_GRACE_MS = 2000
const PPID_POLL_MS = 1000
const GROUP_POLL_MS = 50

/**
 * Run one supervised job. Configuration comes from the environment
 * (`parseRunnerEnv`), not `argv`, which is accepted for the shared
 * entry-script contract and ignored.
 *
 * @param _argv - Arguments after the script (unused).
 * @returns The process exit code: 2 on a bad environment, 0 once the job ended.
 */
export async function main(_argv: string[] = []): Promise<number> {
  const parsed = parseRunnerEnv(process.env as Record<string, string | undefined>)
  if (!parsed.ok) {
    process.stderr.write(`[ma-bg/runner] ${parsed.error}\n`)
    return 2
  }
  const cfg = parsed.value
  const startedAt = new Date().toISOString()

  // Open the log file (append) and make sure its directory exists.
  mkdirSync(dirname(cfg.logPath), { recursive: true })
  const logFd = openSync(cfg.logPath, "a")

  // Spawn the job in its OWN process group so we can group-kill descendants.
  // stdout + stderr both go to the same fd so the log is a faithful combined
  // stream with ANSI preserved. stdin is closed (background jobs are non-
  // interactive, matching the foreground Bash tool).
  const proc = Bun.spawn(buildJobArgv(cfg.command), {
    cwd: cfg.cwd,
    // `childEnv` drops BUN_BE_BUN: the user command must never inherit it, or
    // a `minimal-agent` it starts would boot as the plain `bun` CLI.
    env: childEnv(process.env),
    stdin: "ignore",
    stdout: logFd,
    stderr: logFd,
    detached: true,
  })
  const jobPid = proc.pid

  const base: SidecarBase = { jobId: cfg.jobId, startedAt, jobPid }
  const writeSidecar = (s: Sidecar): void => {
    try {
      writeFileSync(cfg.statusPath, serializeSidecar(s))
    } catch {
      // best-effort, a missing sidecar reconciles as orphaned, never crashes
    }
  }

  // Settle-once guard so the racing cleanup paths record exactly one outcome.
  let settled = false
  const settle = (s: Sidecar): void => {
    if (settled) return
    settled = true
    writeSidecar(s)
  }

  // Group-kill helper: negative pid hits the whole group, fall back to single.
  const killGroup = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-jobPid, sig)
      return
    } catch {
      // fall through
    }
    try {
      proc.kill(sig)
    } catch {
      // already gone
    }
  }

  // True while any process is still in the job group. Only ESRCH means empty:
  // EPERM or another error counts as alive, so the grace wait still runs.
  const groupAlive = (): boolean => {
    try {
      process.kill(-jobPid, 0)
      return true
    } catch (err) {
      return (err as NodeJS.ErrnoException).code !== "ESRCH"
    }
  }

  // Poll until the group is empty or `untilMs` (epoch ms) passes.
  const waitGroupEmpty = async (untilMs: number): Promise<void> => {
    while (groupAlive() && Date.now() < untilMs) await Bun.sleep(GROUP_POLL_MS)
  }

  // Escalate SIGTERM -> SIGKILL so a job ignoring SIGTERM still dies. The
  // timer stays ref'd (leak E2): the runner must not exit before it fires
  // while a descendant that ignores SIGTERM is still in the group.
  let escalation: ReturnType<typeof setTimeout> | undefined
  let termSentAt: number | undefined
  const terminate = (): void => {
    termSentAt ??= Date.now()
    killGroup("SIGTERM")
    escalation ??= setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS)
  }

  // Set once the leader has exited. A stop path after that point only signals
  // the rest of the group: the leader exit code is the outcome to record.
  let leaderDone = false

  // The cleanup paths that pre-empt a natural exit. Each records its reason,
  // signals the job, and then lets the `proc.exited` await below resolve.
  const stopWith = (reason: string): void => {
    if (!leaderDone) settle(stoppedSidecar(base, new Date().toISOString(), reason))
    terminate()
  }

  // Install EVERY stop path BEFORE publishing `running`. The integration suite
  // (and BackgroundStop) wait on the sidecar: if SIGTERM arrives in the window
  // after `running` is visible but before handlers are registered, Bun's default
  // disposition kills us and the sidecar stays stuck at `running` forever.
  // --- Layer 1: stdin EOF (harness death, foolproof, survives -9) ---
  // The harness holds the write end. Any harness exit closes it -> we see EOF.
  const onStdinGone = (): void => stopWith(STOP_REASON.HARNESS_EXIT)
  process.stdin.on("end", onStdinGone)
  process.stdin.on("close", onStdinGone)
  // `error` can fire if the pipe is torn down abruptly, treat it as gone too.
  process.stdin.on("error", onStdinGone)
  process.stdin.resume()

  // --- Layer 2: our own termination signals (e.g. BackgroundStop group-kill) ---
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => stopWith(STOP_REASON.SIGNALLED))
  }

  // --- Layer 3: ppid poll (reparented to init means the harness is gone) ---
  const originalPpid = process.ppid
  const ppidTimer = setInterval(() => {
    if (process.ppid !== originalPpid || process.ppid === 1) {
      stopWith(STOP_REASON.ORPHANED)
    }
  }, PPID_POLL_MS)
  ppidTimer.unref?.()

  // --- Timeout deadline (0 = no deadline) ---
  let deadline: ReturnType<typeof setTimeout> | undefined
  if (cfg.timeoutMs > 0) {
    deadline = setTimeout(() => {
      settle(timedoutSidecar(base, new Date().toISOString(), cfg.timeoutMs))
      terminate()
    }, cfg.timeoutMs)
    deadline.unref?.()
  }

  // Publish `running` only once stop paths are armed.
  writeSidecar(runningSidecar(base))

  // Wait for the job to exit (whether naturally or because a path killed it).
  const exitCode = await proc.exited
  leaderDone = true
  const endedAt = new Date().toISOString()
  const signal = proc.signalCode ? String(proc.signalCode) : undefined
  if (deadline) clearTimeout(deadline)
  clearInterval(ppidTimer)

  // The leader is gone, but a `cmd &` child (leak E1) or a descendant that
  // ignores SIGTERM (leak E2) can still be in the group. Empty the group
  // before we record and exit: SIGTERM, wait the grace time, then SIGKILL.
  // A process that called setsid is in another group and is not reached.
  if (groupAlive()) {
    terminate()
    await waitGroupEmpty((termSentAt ?? Date.now()) + KILL_GRACE_MS)
    if (groupAlive()) {
      killGroup("SIGKILL")
      await waitGroupEmpty(Date.now() + KILL_GRACE_MS)
    }
  }
  if (escalation) clearTimeout(escalation)

  // If no cleanup path already settled, this is a natural exit.
  settle(
    exitedSidecar(base, endedAt, {
      ...(typeof exitCode === "number" ? { exitCode } : {}),
      ...(signal ? { signal } : {}),
    }),
  )

  return 0
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)))
}
