/**
 * Fake worker for `lead-watch.integration.test.ts`. It is NOT the CLI and
 * calls no LLM. It loads only `lead-watch.ts`, starts the watch from its env
 * (`MINIMAL_AGENT_LEAD_PID`, `MINIMAL_AGENT_LEAD_WATCH_MS`), prints `ready`,
 * and then stays alive on purpose. Only the lead watch (or a kill by the test)
 * can end it.
 *
 * @module sub-agents/lib/lead-watch.fixture-worker
 */

import { writeSync } from "node:fs"

import { startLeadWatchFromEnv } from "./lead-watch.ts"

startLeadWatchFromEnv(process.env)
writeSync(1, "ready\n")

// A ref'd timer, like a busy worker event loop.
setInterval(() => {}, 1000)
