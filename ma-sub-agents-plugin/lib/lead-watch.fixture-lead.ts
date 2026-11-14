/**
 * Fake lead for `lead-watch.integration.test.ts`. It spawns the fake worker
 * (path in argv[2], given by the test) the same way `realSpawnDeps` spawns a
 * real one (not detached, stdin `ignore`), with `MINIMAL_AGENT_LEAD_PID` set
 * to its own pid and a short watch interval. When the worker says `ready`,
 * the lead prints `worker <pid>` and stays alive until the test SIGKILLs it.
 *
 * @module sub-agents/lib/lead-watch.fixture-lead
 */

import { writeSync } from "node:fs"

const workerPath = process.argv[2]
if (!workerPath) {
  writeSync(2, "usage: lead-watch.fixture-lead.ts <worker-fixture-path>\n")
  process.exit(2)
}

const worker = Bun.spawn(["bun", "run", workerPath], {
  env: {
    ...process.env,
    MINIMAL_AGENT_LEAD_PID: String(process.pid),
    MINIMAL_AGENT_LEAD_WATCH_MS: process.env.FIXTURE_WATCH_MS ?? "200",
  },
  stdin: "ignore",
  stdout: "pipe",
  stderr: "ignore",
})

const reader = worker.stdout.getReader()
const decoder = new TextDecoder()
let text = ""
while (!text.includes("ready\n")) {
  const chunk = await reader.read()
  if (chunk.done) break
  text += decoder.decode(chunk.value)
}
reader.releaseLock()

writeSync(1, `worker ${worker.pid}\n`)

setInterval(() => {}, 1000)
