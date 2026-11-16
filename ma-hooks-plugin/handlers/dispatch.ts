/**
 * HookBus entry point for every channel in the manifest. One engine per cwd
 * (bounded cache) turns each emit into a chain result. Async output is per session.
 *
 * The config is read from `process.env` (the handler runs in the agent
 * process), not from `ctx.env`, which strips `MINIMAL_AGENT_*`
 * (core `src/plugins/loader/handler-env.ts:31-36`).
 *
 * @module handlers/dispatch
 */

import { statSync } from "node:fs"

import type { HookHandlerContext } from "@minimal-agent/core/plugin-api/types/plugin"

import { AsyncHookQueue } from "../engine/async-queue.ts"
import { hooksConfigPath, loadHooksConfig } from "../engine/config.ts"
import { type EngineChainResult, HooksEngine } from "../engine/engine.ts"
import { SessionNotices, untrustedNotice } from "../engine/notice.ts"

/** Max cached engines (one per cwd). The oldest is dropped first. */
export const MAX_ENGINES = 16

const engines = new Map<string, HooksEngine>()
/**
 * One async queue for the process with one lane per session id (bounded).
 * `maxAsync` caps each session, not the process (SPEC.md, review MAJOR 1).
 * Sessions that share a cwd never drain each other's output, and a cwd
 * change (a new engine) keeps the queued output of the session. A config
 * change, `resetEngine` or `agent.willStop` aborts the async runs.
 */
let queue: AsyncHookQueue | null = null
/** Which untrusted hooks each session was told about (bounded, keyed by sid). */
const notices = new SessionNotices()
/** Signature of the plugin config file the cached engines were built from. */
let configSig: string | null = null

/** Path, mtime and size of the plugin config file (review MINOR 3). */
function configSignature(): string {
  const p = hooksConfigPath(process.env)
  try {
    const st = statSync(p)
    return `${p}:${st.mtimeMs}:${st.size}`
  } catch {
    return `${p}:-`
  }
}

/** Drop the cached engines and abort every async run (config change, reset). */
function dropAll(): void {
  engines.clear()
  queue?.abortAll()
  queue = null
}

/** Get (or build) the engine for `cwd`, from a bounded cache. */
export function engineFor(
  cwd: string,
  log?: (msg: string) => void,
  debug?: (msg: string) => void,
): HooksEngine {
  const sig = configSignature()
  if (sig !== configSig) {
    dropAll()
    configSig = sig
  }
  const hit = engines.get(cwd)
  if (hit) {
    engines.delete(cwd)
    engines.set(cwd, hit)
    return hit
  }
  const config = loadHooksConfig(process.env)
  queue ??= new AsyncHookQueue(config.maxAsync)
  const eng = new HooksEngine({
    cwd,
    config,
    asyncQueue: queue,
    ...(log ? { log } : {}),
    ...(debug ? { debug } : {}),
  })
  engines.set(cwd, eng)
  while (engines.size > MAX_ENGINES) {
    const oldest = engines.keys().next().value
    if (oldest === undefined) break
    engines.delete(oldest)
  }
  return eng
}

/** Drop the cached engines, the async queue and the notice memory (tests). */
export function resetEngine(): void {
  dropAll()
  configSig = null
  notices.clear()
}

/** The async queue of the cached engines, if one was built (tests, diagnostics). */
export function asyncQueue(): AsyncHookQueue | null {
  return queue
}

/** Session key the engine uses for a payload: `payload.sid`, else the context sid. */
function sessionKey(payload: unknown, sid: string): string {
  const p = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {}
  return typeof p.sid === "string" && p.sid.length > 0 ? p.sid : sid
}

/**
 * Show one notice per session that names the untrusted hooks that are
 * skipped (SPEC.md "Trust"). It goes to `notification.emit`, the host
 * channel for a user-visible notice (core `src/plugins/hooks/channels.ts:451-469`,
 * CLI listener `minimal-agent-cli/src/repl-live-area.ts:812-819`). A hook
 * that is new or changed later in the session gives one more notice.
 * Never throws.
 */
function noticeUntrusted(eng: HooksEngine, sid: string, ctx: HookHandlerContext): void {
  try {
    const fresh = notices.take(sid, eng.untrustedHooks())
    const notice = untrustedNotice(fresh)
    if (notice) ctx.emit("notification.emit", notice)
  } catch {
    // a notice failure never breaks a hook
  }
}

/** Default export: the HookBus listener for every hooks-plugin channel. */
export default async function dispatch(
  payload: unknown,
  ctx: HookHandlerContext,
): Promise<EngineChainResult> {
  const log = (msg: string) => {
    try {
      ctx.log.warn("hooks", msg)
    } catch {
      // a logger failure never breaks a hook
    }
  }
  const debug = (msg: string) => {
    try {
      ctx.log.debug("hooks", msg)
    } catch {
      // a logger failure never breaks a hook
    }
  }
  const eng = engineFor(ctx.cwd, log, debug)
  const sid = ctx.agent?.sessionId ?? ""
  noticeUntrusted(eng, sid, ctx)
  // Session end: kill the async runs of this session (process group) now,
  // not at their timeout. Async hooks of agent.willStop itself start in a
  // fresh lane; the runner's exit cleanup kills them at process exit.
  if (ctx.channel === "agent.willStop") queue?.abort(sessionKey(payload, sid))
  return eng.dispatch(ctx.channel, payload, {
    cwd: ctx.cwd,
    abort: ctx.abort,
    ...(sid ? { sid } : {}),
  })
}
