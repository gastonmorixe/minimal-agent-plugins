/**
 * Filesystem paths for intercom state. Pure path math, no IO.
 *
 * Everything lives under `~/.minimal-agent/intercom/` (honoring
 * `MINIMAL_AGENT_HOME`), separate from the session transcript tree so the
 * mesh is a self-contained, GC-able unit:
 *
 *   intercom/presence/<sid>.json    per-session presence record (rewritten each beat)
 *   intercom/inbox/<sid>.jsonl      per-RECIPIENT append-only message queue
 *   intercom/cursors/<sid>.json     recipient-owned high-water marks
 *
 * The sessions directory (`~/.minimal-agent/sessions/`) is ALSO used, read-only,
 * to reach other plugins' per-session sidecars (`<sid>.tasks.jsonl`, etc.) — see
 * `lib/sidecars.ts`. That math lives here too.
 *
 * @module lib/paths
 */

import { homedir } from "node:os"
import { join } from "node:path"

/**
 * The agent's home directory — the base of all intercom storage.
 *
 * The host is the source of truth: minimal-agent resolves its real home at
 * boot and PUBLISHES it into `process.env.MINIMAL_AGENT_HOME` (see core's
 * `src/agent-paths.ts: publishAgentHomeEnv`), which the loader threads into
 * every plugin context's `env`. So in a live agent this env var is always set
 * and authoritative — we never assume `~/.minimal-agent` and never hardcode a
 * location the host might have relocated.
 *
 * The `homedir()` fallback exists ONLY for running this plugin's own unit
 * tests outside a host process (where nobody published the var). It must never
 * be the path a real session uses; if you see writes landing under
 * `~/.minimal-agent` when the host relocated its home, the env signal wasn't
 * threaded through and that is the bug to fix, not this fallback.
 */
export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.MINIMAL_AGENT_HOME?.trim() || join(homedir(), ".minimal-agent")
}

/** The sessions directory (where every plugin colocates per-session sidecars). */
export function sessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(homeDir(env), "sessions")
}

/** The intercom root directory. */
export function intercomDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(homeDir(env), "intercom")
}

/** The presence subdirectory (`intercom/presence`). */
export function presenceDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(intercomDir(env), "presence")
}

/** The inbox subdirectory (`intercom/inbox`). */
export function inboxDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(intercomDir(env), "inbox")
}

/** The cursors subdirectory (`intercom/cursors`). */
export function cursorsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(intercomDir(env), "cursors")
}

/** Absolute path to one session's presence record. */
export function presencePath(sid: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(presenceDir(env), `${sid}.json`)
}

/** Absolute path to one recipient's inbox queue. */
export function inboxPath(sid: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(inboxDir(env), `${sid}.jsonl`)
}

/** Absolute path to one recipient's cursor file. */
export function cursorPath(sid: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(cursorsDir(env), `${sid}.json`)
}

/**
 * Absolute path to a session's transcript JSONL (`<sessions>/<sid>.jsonl`). We
 * read only its modification TIME (never its content) to derive a session's
 * busy/idle phase: a transcript touched within the last few seconds means a
 * turn is actively writing. Owned by core; read-only here.
 */
export function sessionLogPath(sid: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(sessionsDir(env), `${sid}.jsonl`)
}

/**
 * The sub-agents plugin's presence directory (`~/.minimal-agent/presence/`).
 * We merge it into the roster as a best-effort secondary source so sessions
 * that predate intercom (or run it disabled) still appear when they spawned a
 * fleet. Read-only; we never write it.
 */
export function subagentsPresenceDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(homeDir(env), "presence")
}
