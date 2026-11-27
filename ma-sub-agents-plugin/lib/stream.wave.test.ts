/**
 * Lane fixture with a wave: one worker round with 3 concurrency-safe Fetch
 * calls that run at the same time. The stream is synthetic (the recorded
 * fixtures in `__fixtures__/lane/` have no wave). Its event order is the
 * order that core gives for a wave: all `item_started` events of the round
 * come first, then the `tool_result` events in CALL order (spec D4), also
 * when a later call ends first.
 *
 * This test records the CURRENT lane view. The lane keeps one `inFlight`
 * slot (the newest started call), so it does not show each running call of
 * a wave. A fix of that slot is out of scope (spec D12).
 *
 * @module stream.wave.test
 */

import { describe, expect, it } from "bun:test"

import { parseStream, streamEnded, streamProgress } from "./stream.ts"

const SID = "3c1d0a52-0000-4000-8000-000000000000"
const env = (seq: number, ts: number) => `"sessionId":"${SID}","seq":${seq},"ts":${ts}`

const fetchStarted = (n: number, seq: number, ts: number) =>
  `{"type":"item_started","itemType":"tool_use","id":"toolu_${n}","label":"Fetch","toolName":"Fetch","input":{"url":"https://example.test/${n}"},${env(seq, ts)}}`
const fetchCompleted = (n: number, seq: number, ts: number) =>
  `{"type":"item_completed","itemType":"tool_use","id":"toolu_${n}","text":"Fetch",${env(seq, ts)}}`
const fetchResult = (n: number, durationMs: number, seq: number, ts: number) =>
  `{"type":"tool_result","id":"toolu_${n}","name":"Fetch","isError":false,"inputSummary":"{}","outputSummary":"page ${n}","durationMs":${durationMs},${env(seq, ts)}}`

/**
 * A wave of 3 Fetch calls. Call 1 runs 3 s, calls 2 and 3 run 1 s, so calls
 * 2 and 3 end first. Core holds their results until call 1 ends, then
 * sends the 3 results in call order at about the same time.
 */
const HEAD = [
  `{"type":"session_started","streamVersion":1,"sessionId":"${SID}","resumedFrom":null,"model":"mock-model","provider":"anthropic","effort":null,"cwd":"/tmp","version":"0.1.0","outputFormat":"stream-json","seq":0,"ts":1000}`,
  `{"type":"turn_started","turn":1,${env(1, 1005)}}`,
  fetchStarted(1, 2, 2000),
  fetchCompleted(1, 3, 2000),
  fetchStarted(2, 4, 2000),
  fetchCompleted(2, 5, 2000),
  fetchStarted(3, 6, 2000),
  fetchCompleted(3, 7, 2000),
]
const RESULTS = [
  fetchResult(1, 3000, 8, 5000),
  fetchResult(2, 1000, 9, 5001),
  fetchResult(3, 1000, 10, 5002),
]
const TAIL = [
  `{"type":"turn_completed","turn":1,"stopReason":"tool_use","usage":{"inputTokens":10,"outputTokens":20,"cacheReadTokens":0,"cacheCreationTokens":0},${env(11, 5003)}}`,
  `{"type":"turn_started","turn":2,${env(12, 5004)}}`,
  `{"type":"item_started","itemType":"text","id":"2:0",${env(13, 5100)}}`,
  `{"type":"item_completed","itemType":"text","id":"2:0","text":"Read 3 pages.",${env(14, 5100)}}`,
  `{"type":"turn_completed","turn":2,"stopReason":"end_turn","usage":{"inputTokens":40,"outputTokens":5,"cacheReadTokens":0,"cacheCreationTokens":0},${env(15, 5101)}}`,
  `{"type":"run_finished","outcome":"completed",${env(16, 5102)}}`,
  `{"type":"result","text":"Read 3 pages.","usage":{"inputTokens":50,"outputTokens":25,"cacheReadTokens":0,"cacheWriteTokens":0},"stopReason":"end_turn","outcome":"completed","model":"mock-model","provider":"anthropic","durationMs":4102,${env(17, 5103)}}`,
]

const upTo = (lines: readonly string[]): string => lines.join("\n")

describe("lane view of a concurrent tool wave", () => {
  it("while the 3 calls run: phase tool, inFlightCount is 3 and inFlight shows newest call", () => {
    const s = parseStream(upTo(HEAD))
    const p = streamProgress(s)
    expect(p).toMatchObject({ tools: 3, phase: "tool", lastTool: "Fetch", toolSince: 2000 })
    expect(s.inFlightCount).toBe(3)
    expect(p?.lastActivity).toContain("example.test/3")
  })

  it("after the result of call 1: stays phase tool while calls 2 and 3 remain in flight", () => {
    const s = parseStream(upTo([...HEAD, ...RESULTS.slice(0, 1)]))
    const p = streamProgress(s)
    expect(p?.phase).toBe("tool")
    expect(s.inFlightCount).toBe(2)
    expect(p?.toolSince).toBe(2000)
    expect(s.inFlight?.id).toBe("toolu_3")
  })

  it("after all 3 results: the slot is empty and toolMs merges overlapping wave wall time", () => {
    const s = parseStream(upTo([...HEAD, ...RESULTS]))
    expect(s.inFlight).toBeUndefined()
    expect(s.inFlightCount).toBe(0)
    expect(s.phase).toBe("waiting")
    // All 3 started at ts=2000 and ended by ts=5002 (3002 ms wall span, not 5000 ms sum).
    expect(s.toolMs).toBe(3002)
    expect(s.toolErrors).toBe(0)
  })

  it("the full run ends as a normal run", () => {
    const s = parseStream(upTo([...HEAD, ...RESULTS, ...TAIL]))
    expect(streamEnded(s)).toBe(true)
    expect(s.tools).toBe(3)
    expect(s.turns).toBe(2)
    expect(s.outcome).toBe("completed")
    expect(streamProgress(s)?.phase).toBe("finished")
  })
})
