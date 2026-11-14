/**
 * Real-process test for the lead watch (fix-3d). A fake lead bun process
 * spawns a fake worker bun process (both fixtures, no CLI, no LLM). The worker
 * loads only `lead-watch.ts` with a 200 ms interval. The test SIGKILLs the
 * lead, so no lead cleanup code runs, and checks that the worker ends by
 * itself within 2 s.
 *
 * Cleanup kills only the exact pids this test started (the lead) or that
 * the lead reported (the worker).
 */

import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

const LEAD = join(import.meta.dir, "lead-watch.fixture-lead.ts")
// Passed to the lead as argv so the fixtures hold no `import.meta` path
// lookups (tests/embed-safety.test.ts scans non-test plugin sources).
const WORKER = join(import.meta.dir, "lead-watch.fixture-worker.ts")

/** True while `pid` exists (signal 0 probe, no signal is sent). */
function exists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

let startedPids: number[] = []
afterEach(() => {
  for (const pid of startedPids) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // already gone
    }
  }
  startedPids = []
})

/** Start the fake lead and wait until it reports its worker pid. */
async function startLead(): Promise<{ lead: Bun.Subprocess<"ignore", "pipe">; workerPid: number }> {
  const lead = Bun.spawn(["bun", "run", LEAD, WORKER], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  })
  startedPids.push(lead.pid)
  const reader = lead.stdout.getReader()
  const decoder = new TextDecoder()
  let text = ""
  let match: RegExpMatchArray | null = null
  while (!match) {
    const chunk = await reader.read()
    if (chunk.done) break
    text += decoder.decode(chunk.value)
    match = text.match(/worker (\d+)\n/)
  }
  reader.releaseLock()
  if (!match?.[1]) throw new Error(`fake lead gave no worker pid: ${JSON.stringify(text)}`)
  const workerPid = Number(match[1])
  startedPids.push(workerPid)
  return { lead, workerPid }
}

/** Poll until `pid` is gone or `limitMs` passes. Returns true when gone. */
async function goneWithin(pid: number, limitMs: number): Promise<boolean> {
  const end = Date.now() + limitMs
  while (Date.now() < end) {
    if (!exists(pid)) return true
    await Bun.sleep(50)
  }
  return !exists(pid)
}

describe("lead watch: worker exits when its lead is SIGKILLed", () => {
  test("worker stays alive while the lead lives", async () => {
    const { workerPid } = await startLead()
    // Three watch ticks at 200 ms.
    await Bun.sleep(700)
    expect(exists(workerPid)).toBe(true)
  }, 15000)

  test("worker is gone within 2 s after SIGKILL of the lead", async () => {
    const { lead, workerPid } = await startLead()
    expect(exists(workerPid)).toBe(true)
    lead.kill("SIGKILL")
    await lead.exited
    expect(await goneWithin(workerPid, 2000)).toBe(true)
  }, 15000)
})
