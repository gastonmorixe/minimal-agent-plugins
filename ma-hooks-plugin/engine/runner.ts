/**
 * Process and HTTP runner for config hooks.
 *
 * Command hooks run in their own process group (`detached: true` calls
 * `setsid()`, Bun docs: https://bun.com/docs/api/spawn), with the project dir
 * as cwd. The runner writes the stdin JSON and then closes stdin (EOF). On a
 * timeout it sends SIGKILL to the whole group (negative pid, POSIX kill(2):
 * https://man7.org/linux/man-pages/man2/kill.2.html), so grandchildren die
 * too. Same pattern as `ma-skills-plugin/lib/tool-registry.ts:204-221`.
 *
 * @module engine/runner
 */

import { childEnv } from "@minimal-agent/core/plugin-api/utils/self-spawn"

import type { CommandHandler, HookHandlerSpec, HttpHandler, RunOutcome } from "./types.ts"

/** Inputs of one run. */
export interface RunRequest {
  handler: HookHandlerSpec
  stdin: string
  /** Extra env from the adapter. Merged over the parent env. */
  env: Record<string, string>
  cwd: string
  timeoutMs: number
  /** Base env. Default `process.env`. */
  baseEnv?: Readonly<Record<string, string | undefined>>
  abort?: AbortSignal
}

/**
 * Pids of live hook groups, killed on host exit, SIGINT, SIGTERM and SIGHUP
 * (review MINOR 8).
 *
 * Core has a child registry (`minimal-agent-core/src/infra/child-registry.ts:159`)
 * but it covers `exit` only (same file, :18-24) and the plugin API does not
 * export it (core `package.json:108-141`, no `child-registry` entry). So the
 * plugin keeps its own set.
 */
const liveGroups = new Set<number>()
let cleanupInstalled = false

/** Pids of the hook groups that run now (tests and diagnostics). */
export function liveGroupPids(): number[] {
  return [...liveGroups]
}

/** SIGKILL every live hook group. Synchronous, never throws. */
export function killLiveGroups(): void {
  for (const pid of liveGroups) killGroup(pid)
  liveGroups.clear()
}

/** Signals that kill the live hook groups. SIGHUP covers a closed terminal. */
export const CLEANUP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const

/** One of {@link CLEANUP_SIGNALS}. */
export type CleanupSignal = (typeof CLEANUP_SIGNALS)[number]

/**
 * Shared marker on every plugin signal fan-out listener. `Symbol.for` gives
 * the same symbol in every module, so ma-background, ma-speak and ma-hooks
 * see each other's tag without an import. Keep the name identical to
 * `ma-background-plugin/lib/registry.ts`.
 */
export const FANOUT: unique symbol = Symbol.for("minimal-agent.signal-fanout")

/** A signal listener that may carry the {@link FANOUT} tag. */
type FanOutListener = ((...args: unknown[]) => void) & { [FANOUT]?: true }

/** True when a listener is not a fan-out, so it owns the signal. */
function isOwner(l: unknown): boolean {
  return (l as FanOutListener)[FANOUT] !== true
}

/**
 * The SIGINT/SIGTERM/SIGHUP path. It kills the live groups and then keeps
 * the host's handling of the signal. Fan-out listeners (tagged with
 * {@link FANOUT}, this one included) never count as owners:
 *
 * 1. An untagged listener exists: that listener owns the signal (for example
 *    the CLI cancels the turn). This function does nothing more.
 * 2. Only fan-out listeners exist: a listener turns off the default action
 *    (https://nodejs.org/api/process.html#signal-events), so this function
 *    removes itself and raises the signal again. Each fan-out does the same,
 *    and once all are gone the default action ends the process.
 *
 * It never calls `process.exit`.
 *
 * @param sig - The signal.
 * @param raise - Raise the signal again (tests pass a fake).
 */
export function onCleanupSignal(
  sig: CleanupSignal,
  raise: (sig: CleanupSignal) => void = (s) => process.kill(process.pid, s),
): void {
  const owners = process.listeners(sig).filter(isOwner).length
  killLiveGroups()
  if (owners > 0) return
  process.removeListener(sig, signalListeners[sig])
  raise(sig)
}

function tagged(fn: () => void): () => void {
  const l: FanOutListener = fn
  l[FANOUT] = true
  return l
}

const signalListeners: Record<CleanupSignal, () => void> = {
  SIGINT: tagged(() => onCleanupSignal("SIGINT")),
  SIGTERM: tagged(() => onCleanupSignal("SIGTERM")),
  SIGHUP: tagged(() => onCleanupSignal("SIGHUP")),
}

/**
 * Install the exit, SIGINT, SIGTERM and SIGHUP listeners once. A signal listener does
 * not keep the event loop alive (checked: a Bun script with only a SIGTERM
 * listener exits at once).
 */
export function installCleanup(): void {
  if (cleanupInstalled) return
  cleanupInstalled = true
  process.once("exit", killLiveGroups)
  for (const sig of CLEANUP_SIGNALS) process.on(sig, signalListeners[sig])
}

/** Test seam: remove the listeners so the next spawn installs them again. */
export function uninstallCleanup(): void {
  cleanupInstalled = false
  process.removeListener("exit", killLiveGroups)
  for (const sig of CLEANUP_SIGNALS) process.removeListener(sig, signalListeners[sig])
}

/** Test seam: the listener installed for `sig`. */
export function cleanupListener(sig: CleanupSignal): () => void {
  return signalListeners[sig]
}

/** SIGKILL a process group by leader pid, then the single pid. Never throws. */
export function killGroup(pid: number): void {
  if (pid <= 0) return
  try {
    process.kill(-pid, "SIGKILL")
    return
  } catch {
    // not a group leader, or already gone
  }
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    // already gone
  }
}

/** Build argv for a command handler: shell form or exec form. */
export function commandArgv(h: CommandHandler): string[] {
  if (h.args && h.args.length > 0) return [h.command, ...h.args]
  return [h.shell === "bash" ? "bash" : "sh", "-c", h.command]
}

/** Grace period for open pipes after the main hook process exits. */
export const STDOUT_GRACE_MS = 250

/** Read a stream in the background. `text()` gives what was read so far. */
function collect(stream: ReadableStream<Uint8Array>): { done: Promise<void>; text: () => string } {
  const dec = new TextDecoder()
  let acc = ""
  const done = (async () => {
    try {
      for await (const chunk of stream) acc += dec.decode(chunk, { stream: true })
      acc += dec.decode()
    } catch {
      // the group was killed: keep what was read
    }
  })()
  return { done, text: () => acc }
}

/** Run one hook handler. Never throws. */
export function runHandler(req: RunRequest): Promise<RunOutcome> {
  return req.handler.type === "http" ? runHttp(req, req.handler) : runCommand(req, req.handler)
}

async function runCommand(req: RunRequest, h: CommandHandler): Promise<RunOutcome> {
  const started = Date.now()
  const env = { ...childEnv(req.baseEnv ?? process.env), ...h.env, ...req.env }
  let proc: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>
  try {
    proc = Bun.spawn(commandArgv(h), {
      cwd: req.cwd,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    })
  } catch (e) {
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      error: `spawn failed: ${e instanceof Error ? e.message : String(e)}`,
      durationMs: Date.now() - started,
    }
  }
  installCleanup()
  liveGroups.add(proc.pid)
  let timedOut = false
  const kill = () => killGroup(proc.pid)
  const timer = setTimeout(() => {
    timedOut = true
    kill()
  }, req.timeoutMs)
  const onAbort = () => kill()
  req.abort?.addEventListener("abort", onAbort, { once: true })
  if (req.abort?.aborted) kill()
  try {
    await proc.stdin.write(req.stdin)
    await proc.stdin.end()
  } catch {
    // the hook closed stdin early: fine
  }
  const out = collect(proc.stdout)
  const err = collect(proc.stderr)
  const exitCode = await proc.exited
  clearTimeout(timer)
  // A background child can keep the pipes open after the main process
  // exits. Wait a short grace period, then kill the group and use what was
  // read. This is not a timeout (review MINOR 7).
  const drained = Promise.all([out.done, err.done]).then(() => true)
  const inGrace = await Promise.race([drained, Bun.sleep(STDOUT_GRACE_MS).then(() => false)])
  if (!inGrace) kill()
  req.abort?.removeEventListener("abort", onAbort)
  liveGroups.delete(proc.pid)
  const stdout = out.text()
  const stderr = err.text()
  return {
    exitCode: timedOut ? null : exitCode,
    stdout,
    stderr,
    timedOut,
    ...(timedOut ? { error: `timed out after ${req.timeoutMs} ms` } : {}),
    durationMs: Date.now() - started,
  }
}

async function runHttp(req: RunRequest, h: HttpHandler): Promise<RunOutcome> {
  const started = Date.now()
  const base = req.baseEnv ?? process.env
  const allowed = new Set(h.allowedEnvVars ?? [])
  // Header values may reference $VAR / ${VAR}. Only allowed vars resolve,
  // an unlisted reference becomes "" (Claude hooks-reference.md:513).
  const headers: Record<string, string> = { "content-type": "application/json" }
  for (const [k, v] of Object.entries(h.headers ?? {})) {
    headers[k] = v.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (_m, braced: string | undefined, bare: string | undefined) => {
        const name = braced ?? bare ?? ""
        return allowed.has(name) ? (base[name] ?? "") : ""
      },
    )
  }
  const ctl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ctl.abort()
  }, req.timeoutMs)
  try {
    const res = await fetch(h.url, {
      method: "POST",
      headers,
      body: req.stdin,
      signal: req.abort ? AbortSignal.any([ctl.signal, req.abort]) : ctl.signal,
    })
    const body = await res.text()
    return {
      exitCode: res.ok ? 0 : 1,
      stdout: res.ok ? body : "",
      stderr: res.ok ? "" : body,
      timedOut: false,
      ...(res.ok ? {} : { error: `http status ${res.status}` }),
      durationMs: Date.now() - started,
    }
  } catch (e) {
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut,
      error: timedOut
        ? `timed out after ${req.timeoutMs} ms`
        : `http failed: ${e instanceof Error ? e.message : String(e)}`,
      durationMs: Date.now() - started,
    }
  } finally {
    clearTimeout(timer)
  }
}
