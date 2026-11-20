/**
 * The wave golden (`wave-two-reads`): one model response with 2
 * concurrency-safe calls. With concurrency cap 2 the calls run as a wave.
 * With cap 1 they run one after another. The next request must be the
 * same bytes on the two paths: tool_use and tool_result blocks in call
 * order (spec D4).
 *
 * The wave check does not depend on which Read ends first. The core awaits
 * the toolView `started` event before the run, so the view holds call 1 at
 * `started` until call 2 starts. In a wave, call 2 starts while call 1
 * waits. On the serial path call 2 cannot start, the gate opens only at its
 * time limit, and the check fails.
 */

import { readFileSync } from "node:fs"

import { describe, expect, it } from "bun:test"

import { goldenPath, runScenario } from "./harness.ts"
import { WAVE_TWO_READS } from "./scenarios-gaps.ts"

/** The time limit of the gate. Only a serial run (or a hang) gets to it. */
const GATE_LIMIT_MS = 5_000

type ViewEvent = { type: string; tool: { id: string } }

/** One run of the scenario with `cap`: its golden text and its toolView events. */
async function runWithCap(
  cap: number,
  opts: { holdFirst?: boolean } = {},
): Promise<{ text: string; seen: string[]; call2StartedWhileHeld: boolean }> {
  const seen: string[] = []
  let held = false
  let call2StartedWhileHeld = false
  let openGate: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    openGate = resolve
  })
  const text = await runScenario({
    ...WAVE_TWO_READS,
    coreDeps: () => ({
      maxConcurrentToolCalls: cap,
      toolView: {
        onToolEvent: async (e: ViewEvent) => {
          if (e.type !== "started" && e.type !== "outcome") return
          seen.push(`${e.type}:${e.tool.id}`)
          if (e.type !== "started") return
          if (e.tool.id === "call-1-1") {
            if (held) call2StartedWhileHeld = true
            openGate()
          } else if (e.tool.id === "call-1-0" && opts.holdFirst === true) {
            held = true
            const limit = setTimeout(openGate, GATE_LIMIT_MS)
            await gate
            held = false
            clearTimeout(limit)
          }
        },
      },
    }),
  })
  return { text, seen, call2StartedWhileHeld }
}

const golden = (): string => readFileSync(goldenPath(WAVE_TWO_READS.name), "utf8")

describe("wave golden", () => {
  it("cap 2 runs the 2 calls as a wave: call 2 starts before call 1 runs", async () => {
    const wave = await runWithCap(2, { holdFirst: true })
    expect(wave.call2StartedWhileHeld).toBe(true)
    // Call 1 is held at `started`, so no call can end before call 2 starts.
    expect(wave.seen.slice(0, 2)).toEqual(["started:call-1-0", "started:call-1-1"])
    expect([...wave.seen.slice(2)].sort()).toEqual(["outcome:call-1-0", "outcome:call-1-1"])
    // The saved records and the tool_result blocks stay in call order.
    expect(wave.text).toBe(golden())
  }, 120_000)

  it("the gate check fails on the serial path (cap 1)", async () => {
    const serial = await runWithCap(1, { holdFirst: true })
    expect(serial.call2StartedWhileHeld).toBe(false)
    expect(serial.seen.slice(0, 2)).not.toEqual(["started:call-1-0", "started:call-1-1"])
  }, 120_000)

  it("cap 1 runs the calls one after another, with the same request bytes", async () => {
    const serial = await runWithCap(1)
    expect(serial.seen).toEqual([
      "started:call-1-0",
      "outcome:call-1-0",
      "started:call-1-1",
      "outcome:call-1-1",
    ])
    expect(serial.text).toBe(golden())
  }, 120_000)

  it("the results come back in call order", () => {
    const parsed = JSON.parse(golden()) as {
      requests: { messages: { role: string; content: Record<string, unknown>[] }[] }[]
    }
    const last = parsed.requests.at(-1)?.messages.at(-1)
    expect(last?.role).toBe("user")
    expect(last?.content.map((b) => [b.type, b.tool_use_id])).toEqual([
      ["tool_result", "call-1-0"],
      ["tool_result", "call-1-1"],
    ])
    expect(JSON.stringify(last?.content)).toContain("alpha")
  })
})
