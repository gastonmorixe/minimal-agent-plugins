/**
 * Summed output and thinking per worker. Context stays replace-not-accumulate
 * (see docs/fleet-token-count.md). Output and thinking are generated tokens:
 * each turn makes new ones, so summing them is the honest spend, on every
 * provider (Cursor reports output 0, so the sum stays 0 there).
 *
 * Numbers: worker c85b5171 (lead 0c54da75, 2026-11-15).
 */
import { describe, expect, it } from "bun:test"

import { parseProgress } from "./progress.ts"
import { fmtSpend } from "./style.ts"
import { fleetStats, type SubagentRecord, sessionId, subagentId } from "./types.ts"

function jsonl(...records: object[]): string {
  return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`
}

function turn(ctx: [number, number, number], output: number, thinking?: number) {
  return {
    kind: "assistant",
    content: [{ type: "tool_use", name: "WebSearch", input: { query: "q" } }],
    usage: {
      input_tokens: ctx[0],
      cache_read_input_tokens: ctx[1],
      cache_creation_input_tokens: ctx[2],
      output_tokens: output,
      ...(thinking !== undefined ? { output_tokens_details: { thinking_tokens: thinking } } : {}),
    },
  }
}

const A1 = jsonl(
  turn([4, 0, 51186], 587, 14),
  turn([2, 51186, 7773], 302, 47),
  turn([2, 51186, 10151], 1914, 0),
)

describe("parseProgress summed spend", () => {
  it("sums output and thinking over turns, keeps context as the last turn", () => {
    const p = parseProgress(A1)
    expect(p.tokens).toBe(61_339)
    expect(p.output).toBe(587 + 302 + 1914)
    expect(p.thinking).toBe(14 + 47 + 0)
  })

  it("leaves thinking out when no turn reports it", () => {
    const p = parseProgress(jsonl(turn([10, 0, 0], 5), turn([20, 0, 0], 7)))
    expect(p.output).toBe(12)
    expect(p.thinking).toBeUndefined()
  })
})

describe("fmtSpend", () => {
  it("shows context, output, and thinking", () => {
    expect(fmtSpend({ tokens: 61_339, output: 2803, thinking: 61 })).toBe(
      "ctx 61.3k · out 2.8k (thinking 61)",
    )
  })

  it("falls back to the old single figure when no output is known", () => {
    expect(fmtSpend({ tokens: 61_339 })).toBe("61.3k tok")
    expect(fmtSpend({ tokens: 61_339, output: 0 })).toBe("61.3k tok")
  })

  it("omits thinking when it is zero", () => {
    expect(fmtSpend({ tokens: 900, output: 120, thinking: 0 })).toBe("ctx 900 · out 120")
  })
})

describe("fleetStats summed output", () => {
  const base = {
    sid: sessionId("c85b5171-f937-4e71-9c91-44a02b369d29"),
    label: "w",
    type: "worker",
    model: "m",
    task: "t",
    isolation: "fresh",
    workspace: "inherit-cwd",
    spawnedAt: "2026-11-15T19:31:30.000Z",
    depth: 1,
    leadSid: sessionId("0c54da75-9681-4a82-a508-ec96ad8c6bf9"),
  } as const
  const records: SubagentRecord[] = [
    {
      ...base,
      id: subagentId("A1"),
      status: {
        kind: "done",
        endedAt: "x",
        result: { short: "s", tokens: 61_339, tools: 8, output: 2803, thinking: 61 },
      },
    },
    {
      ...base,
      id: subagentId("A2"),
      status: {
        kind: "running",
        pid: 1,
        startedAt: "x",
        progress: { tools: 2, tokens: 40_000, output: 500, thinking: 9 },
      },
    },
  ]

  it("sums output and thinking across workers", () => {
    const s = fleetStats(records)
    expect(s.output).toBe(3303)
    expect(s.thinking).toBe(70)
  })
})
