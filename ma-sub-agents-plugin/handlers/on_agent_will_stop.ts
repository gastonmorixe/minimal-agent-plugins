/**
 * `agent.willStop` broadcast handler — reap the fleet before the lead exits.
 *
 * Without this, a clean lead shutdown (or a crash that still runs willStop)
 * leaves every still-running / lingering-after-ReportResult worker as an
 * orphan under launchd. Those orphans hold detached `obscura-worker`
 * children whose stdin stays open, so the workers never idle-exit.
 *
 * SIGKILL (not SIGTERM): Fetch's parent-exit hook historically swallowed
 * SIGTERM; SIGKILL always reaps the bun process and the worker follows via
 * stdin EOF.
 *
 * @module sub-agents/handlers/on_agent_will_stop
 */

import type { HookHandlerContext } from "../lib/host-types.ts"
import { resolveSessionsDir } from "../lib/runtime.ts"
import { stopAllAgents } from "../lib/service.ts"
import { SubagentStore } from "../lib/store.ts"

const handler = (_payload: unknown, ctx: HookHandlerContext): void => {
  const leadSid = ctx.agent?.sessionId
  if (!leadSid) return
  const store = new SubagentStore(leadSid, { dir: resolveSessionsDir(ctx.env) })
  stopAllAgents("lead shutting down", {
    store,
    kill: (pid) => {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        // already gone
      }
    },
    now: () => new Date(),
  })
}

export default handler
