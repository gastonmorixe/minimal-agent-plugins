/**
 * `CloudPush` — manually flush this session's new records to the cloud teleport
 * store. Also the shared flush entry point the live-area uploader slot calls.
 *
 * Thin shell: wires real `fetch` + the session-file reader to the pure
 * {@link flushSession} core, supplying the live session id from `ctx.agent`.
 *
 * @module handlers/push
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type { TUIContext, TUIResult } from "../lib/host-types.ts"
import { cloudConfig } from "../lib/login.ts"
import { type FlushDeps, type FlushOutcome, flushSession } from "../lib/uploader.ts"

/** Resolve the agent home like the rest of minimal-agent. */
function homeDir(env: NodeJS.ProcessEnv): string {
  return env.MINIMAL_AGENT_HOME?.trim() || join(homedir(), ".minimal-agent")
}

/** Read a session's local JSONL transcript text, or null when absent. */
function readSessionText(sid: string, env: NodeJS.ProcessEnv): string | null {
  const path = join(homeDir(env), "sessions", `${sid}.jsonl`)
  if (!existsSync(path)) return null
  try {
    return readFileSync(path, "utf-8")
  } catch {
    return null
  }
}

/** Build {@link FlushDeps} from a plugin env (the production wiring). */
export function flushDepsFromEnv(env: NodeJS.ProcessEnv): FlushDeps {
  return {
    graphqlUrl: cloudConfig(env).graphqlUrl,
    readSessionText: (sid) => readSessionText(sid, env),
    fetch: (...a: Parameters<typeof fetch>) => fetch(...a),
    env,
  }
}

/** Flush the given session, returning the outcome. Shared by the tool + slot. */
export function flushForSession(sid: string, env: NodeJS.ProcessEnv): Promise<FlushOutcome> {
  return flushSession(sid, flushDepsFromEnv(env))
}

/** Tool handler for `CloudPush`. */
export default async function cloudPush(ctx: TUIContext): Promise<TUIResult> {
  if (ctx.trigger.type !== "tool") {
    return { kind: "tool_result", content: "CloudPush: unexpected trigger", is_error: true }
  }
  const sid = ctx.agent?.sessionId?.trim()
  if (!sid) {
    return { kind: "tool_result", content: "CloudPush: no session id available.", is_error: true }
  }

  const outcome = await flushForSession(sid, ctx.env)
  if (!outcome.ok) {
    return {
      kind: "tool_result",
      content: `CloudPush: upload failed — ${outcome.reason}. Your session is safe locally; it will retry on the next push.`,
      is_error: true,
    }
  }
  switch (outcome.status) {
    case "uploaded":
      return {
        kind: "tool_result",
        content: `CloudPush: uploaded ${outcome.sent} record(s); cloud is caught up through line ${outcome.acceptedThroughClientLine}${outcome.headSeq !== undefined ? ` (headSeq ${outcome.headSeq})` : ""}.`,
      }
    case "nothing-new":
      return {
        kind: "tool_result",
        content: "CloudPush: already up to date — nothing new to upload.",
      }
    case "skipped":
      return {
        kind: "tool_result",
        content:
          `CloudPush: skipped — ${outcome.reason}. ${outcome.reason === "not logged in" ? "Run CloudLogin first." : ""}`.trim(),
      }
  }
}
