/**
 * Build the injected deps for the Service Layer + reconcile from a live handler
 * context. This is the ONE place the plugin reaches for real OS collaborators
 * (`Bun.spawn` via the launcher, `process.kill`, `fs`), keeping every other
 * module pure and testable.
 *
 * @module lib/handler-deps
 */

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import type { BgConfig } from "./config.ts"
import type { AgentContext } from "./host-types.ts"
import { defaultSessionsDir, jobsDir, logPath, statusPath } from "./paths.ts"
import { getRegistry, type RunnerRegistry } from "./registry.ts"
import { type ReconcileIO, type ServiceDeps, type ServicePaths } from "./service.ts"
import { parseSidecar, type Sidecar } from "./sidecar.ts"
import { realLaunch } from "./spawn.ts"
import { BgJobStore } from "./store.ts"

/** Minimal slice of a handler/slot context this module needs. */
export interface DepsContext {
  readonly packageDir: string
  readonly cwd: string
  readonly env: Record<string, string>
  readonly agent?: AgentContext
}

/**
 * Resolve how to launch the runner: the bun runtime + the runner script path.
 * Honors `MINIMAL_AGENT_BIN` (space-separated argv) for packaged installs,
 * else uses this process's own runtime (`process.execPath`), so a dev checkout
 * and a built binary both spawn the runner the same way.
 */
export function resolveRuntime(env: Record<string, string>): string[] {
  const override = env.MINIMAL_AGENT_BG_RUNTIME?.trim()
  if (override) return override.split(/\s+/)
  // `process.execPath` is the bun binary running the agent.
  return [process.execPath]
}

/** Absolute path to `bin/runner.ts` inside the plugin package. */
export function runnerPathFor(packageDir: string): string {
  return join(packageDir, "bin", "runner.ts")
}

/** Build {@link ServicePaths} bound to a session. */
function pathsFor(
  packageDir: string,
  sessionsDir: string,
  sid: string,
  env: Record<string, string>,
): ServicePaths {
  return {
    runnerPath: runnerPathFor(packageDir),
    runtime: resolveRuntime(env),
    logPath: (id) => logPath(sessionsDir, sid, id),
    statusPath: (id) => statusPath(sessionsDir, sid, id),
    ensureJobsDir: () => {
      mkdirSync(jobsDir(sessionsDir, sid), { recursive: true })
    },
  }
}

/** Build {@link ServiceDeps} for a handler, or `null` when no session id is plumbed. */
export function serviceDepsFromCtx(ctx: DepsContext, config: BgConfig): ServiceDeps | null {
  const sid = ctx.agent?.sessionId
  if (!sid) return null
  const sessionsDir = defaultSessionsDir(ctx.env as NodeJS.ProcessEnv)
  return {
    store: new BgJobStore(sid, { sessionsDir }),
    registry: getRegistry(),
    config,
    paths: pathsFor(ctx.packageDir, sessionsDir, sid, ctx.env),
    launch: realLaunch,
    baseEnv: ctx.env,
    now: () => new Date(),
  }
}

/** A store bound to the session (for read-only handlers), or `null`. */
export function storeFromCtx(ctx: DepsContext): BgJobStore | null {
  const sid = ctx.agent?.sessionId
  if (!sid) return null
  return new BgJobStore(sid, { sessionsDir: defaultSessionsDir(ctx.env as NodeJS.ProcessEnv) })
}

/** The session id from a context, or `null`. */
export function sidFromCtx(ctx: DepsContext): string | null {
  return ctx.agent?.sessionId ?? null
}

/** The registry singleton (exposed so handlers and the heartbeat share it). */
export function registry(): RunnerRegistry {
  return getRegistry()
}

/** Real IO for the reconcile pass: pid-liveness + sidecar reads. */
export function realReconcileIO(): ReconcileIO {
  return {
    runnerAlive: (pid) => {
      if (!Number.isFinite(pid) || pid <= 0) return false
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    },
    readSidecar: (path) => readSidecarFile(path),
  }
}

/** Read + parse a sidecar file, or `undefined`. */
export function readSidecarFile(path: string): Sidecar | undefined {
  try {
    if (!existsSync(path)) return undefined
    return parseSidecar(JSON.parse(readFileSync(path, "utf-8")))
  } catch {
    return undefined
  }
}

/** Read a file's UTF-8 contents, or `undefined`. */
export function readFileMaybe(path: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined
    return readFileSync(path, "utf-8")
  } catch {
    return undefined
  }
}

/** Byte size of a file, or `undefined`. */
export function fileSize(path: string): number | undefined {
  try {
    return statSync(path).size
  } catch {
    return undefined
  }
}
