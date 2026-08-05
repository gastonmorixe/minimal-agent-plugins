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
 *
 * This file is the imperative shell. Its logic lives in `lib/runner-core.ts`
 * (pure, unit-tested). It runs only as an executable, it exports nothing.
 *
 * @module bin/runner
 */

import { mkdirSync, openSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

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

async function main(): Promise<never> {
  const parsed = parseRunnerEnv(process.env as Record<string, string | undefined>)
  if (!parsed.ok) {
    process.stderr.write(`[ma-bg/runner] ${parsed.error}\n`)
    process.exit(2)
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
    env: process.env as Record<string, string>,
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

  // Escalate SIGTERM -> SIGKILL so a job ignoring SIGTERM still dies.
  let escalation: ReturnType<typeof setTimeout> | undefined
  const terminate = (): void => {
    killGroup("SIGTERM")
    escalation = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS)
    escalation.unref?.()
  }

  // The cleanup paths that pre-empt a natural exit. Each records its reason,
  // signals the job, and then lets the `proc.exited` await below resolve.
  const stopWith = (reason: string): void => {
    settle(stoppedSidecar(base, new Date().toISOString(), reason))
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
  if (deadline) clearTimeout(deadline)
  if (escalation) clearTimeout(escalation)
  clearInterval(ppidTimer)

  // If no cleanup path already settled, this is a natural exit.
  const signal = proc.signalCode ?? undefined
  settle(
    exitedSidecar(base, new Date().toISOString(), {
      ...(typeof exitCode === "number" ? { exitCode } : {}),
      ...(signal ? { signal } : {}),
    }),
  )

  process.exit(0)
}

if (import.meta.main) {
  await main()
}
