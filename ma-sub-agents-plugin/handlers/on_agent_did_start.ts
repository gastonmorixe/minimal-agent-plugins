/**
 * `agent.didStart` broadcast handler: start the worker-side lead watch.
 *
 * The plugin loads in every CLI, lead and worker. Only a worker has
 * `MINIMAL_AGENT_LEAD_PID` in its env (the spawn plan stamps it), so a lead
 * starts nothing here. In a worker, the watch exits the process when the lead
 * is gone, also after a lead SIGKILL that ran no `agent.willStop`.
 *
 * `agent.didStart` fires once per session after plugins activate (core
 * `LifecyclePortAdapter.sessionStart`, called by the CLI after the session is
 * built, for both the REPL and `--prompt`).
 *
 * The call also deletes `MINIMAL_AGENT_LEAD_PID` and
 * `MINIMAL_AGENT_LEAD_WATCH_MS` from `process.env` after it reads them, so a
 * CLI that a tool in this worker starts does not watch the lead (fix-3i).
 *
 * @module sub-agents/handlers/on_agent_did_start
 */

import type { HookHandlerContext } from "../lib/host-types.ts"
import { startLeadWatchFromEnv } from "../lib/lead-watch.ts"

const handler = (_payload: unknown, ctx: HookHandlerContext): void => {
  startLeadWatchFromEnv(ctx.env)
}

export default handler
