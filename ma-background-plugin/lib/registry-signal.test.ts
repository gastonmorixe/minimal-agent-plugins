/**
 * Real-signal tests for the shared parent-exit fan-out (leak F). Each case
 * runs `registry-signal.fixture.ts` in a child bun process, sends it SIGTERM,
 * and checks that the host still dies and that the fan-out ran exactly once.
 */

import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

const FIXTURE = join(import.meta.dir, "registry-signal.fixture.ts")

/** Every pid a test started, killed by exact pid. */
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

interface Outcome {
  /** Exit code, or null when the child died on a signal. */
  readonly exitCode: number | null
  /** Signal that ended the child, or null. */
  readonly signal: string | null
  /** True when the child ended within the time limit. */
  readonly exitedInTime: boolean
  /** Every stdout line the child wrote. */
  readonly lines: string[]
}

async function runCase(
  mode: string,
  sig: NodeJS.Signals = "SIGTERM",
  limitMs = 1000,
): Promise<Outcome> {
  const proc = Bun.spawn(["bun", "run", FIXTURE, mode], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  })
  startedPids.push(proc.pid)
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let text = ""
  // Read until the fixture says it is ready.
  while (!text.includes("ready\n")) {
    const chunk = await reader.read()
    if (chunk.done) break
    text += decoder.decode(chunk.value)
  }
  proc.kill(sig)
  const exitedInTime = await Promise.race([
    proc.exited.then(() => true),
    Bun.sleep(limitMs).then(() => false),
  ])
  if (exitedInTime) {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value)
    }
  }
  return {
    exitCode: exitedInTime ? proc.exitCode : null,
    signal: exitedInTime && proc.signalCode ? String(proc.signalCode) : null,
    exitedInTime,
    lines: text.split("\n").filter((l) => l !== ""),
  }
}

const count = (o: Outcome, line: string): number => o.lines.filter((l) => l === line).length
const fanouts = (o: Outcome): number => count(o, "fanout")
const reraises = (o: Outcome): number => o.lines.filter((l) => l.startsWith("reraise ")).length

describe("registry: parent-exit fan-out does not keep the host alive", () => {
  test("alone: SIGTERM still ends the host within 1 s, fan-out once", async () => {
    const o = await runCase("alone")
    expect(o.exitedInTime).toBe(true)
    expect(o.signal).toBe("SIGTERM")
    expect(fanouts(o)).toBe(1)
  }, 10000)

  test("other listener first (CLI order): exit 143, fan-out once", async () => {
    const o = await runCase("other-first")
    expect(o.exitedInTime).toBe(true)
    expect(o.exitCode).toBe(143)
    expect(fanouts(o)).toBe(1)
  }, 10000)

  test("other listener after: exit 143, fan-out once", async () => {
    const o = await runCase("other-after")
    expect(o.exitedInTime).toBe(true)
    expect(o.exitCode).toBe(143)
    expect(fanouts(o)).toBe(1)
  }, 10000)
})

// ma-background and ma-speak both hold a fan-out listener. Each fan-out must
// count only the listeners that are not a fan-out, or each one sees the other
// and none re-raises (review-4b finding 1).
describe("registry + ma-speak in one host: the shared fan-out still ends the host", () => {
  test("both, no other listener: SIGTERM ends the host within 1 s, each fan-out once", async () => {
    const o = await runCase("both", "SIGTERM")
    expect(o.exitedInTime).toBe(true)
    expect(o.signal).toBe("SIGTERM")
    expect(fanouts(o)).toBe(1)
    expect(count(o, "speak-fanout")).toBe(1)
  }, 10000)

  test("both, no other listener: SIGHUP ends the host within 1 s, each fan-out once", async () => {
    const o = await runCase("both", "SIGHUP")
    expect(o.exitedInTime).toBe(true)
    expect(o.signal).toBe("SIGHUP")
    expect(fanouts(o)).toBe(1)
    expect(count(o, "speak-fanout")).toBe(1)
  }, 10000)

  test("both plus a listener that exits 143: exit 143, each fan-out once, no re-raise", async () => {
    const o = await runCase("both-other", "SIGTERM")
    expect(o.exitedInTime).toBe(true)
    expect(o.exitCode).toBe(143)
    expect(fanouts(o)).toBe(1)
    expect(count(o, "speak-fanout")).toBe(1)
    expect(reraises(o)).toBe(0)
  }, 10000)
})
