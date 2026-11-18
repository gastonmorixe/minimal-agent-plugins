import { describe, expect, it } from "bun:test"

import {
  drive,
  f,
  missSse,
  REQ_086,
  REQ_087,
  recorder,
  SYSTEM,
  TOOLS,
  thinking,
  toolResult,
  toolUse,
  usageSse,
} from "./__fixtures__/cache-test-kit.ts"
import { CacheAnomalyDetector, comparePrefix } from "./detector.ts"
import { createWireWatch, fingerprintRequest } from "./wire-watch.ts"

describe("prefix fingerprint", () => {
  it("ignores cache_control and assistant thinking, and keeps the last marker index", () => {
    const a = fingerprintRequest(REQ_086)
    const b = fingerprintRequest(REQ_087)
    expect(a.lastMarkerIndex).toBe(4)
    expect(b.lastMarkerIndex).toBe(6)
    expect(b.messages.slice(0, 5)).toEqual([...a.messages])
    expect(a.thinkingAt).toEqual([3])
    expect(b.thinkingAt).toEqual([5])
    // The thinking of message 3 (the previous latest assistant message) was removed.
    expect(comparePrefix(a, b)).toEqual({ kind: "same", upTo: 4, strippedAt: 3 })
    // No removal: no strippedAt.
    expect(comparePrefix(a, a)).toEqual({ kind: "same", upTo: 4 })
  })

  it("names a changed system, changed tools, and the first changed message", () => {
    const a = fingerprintRequest(REQ_086)
    const sys = fingerprintRequest({ ...REQ_087, system: [{ ...SYSTEM[0], text: "y" }] })
    expect(comparePrefix(a, sys)).toEqual({ kind: "system" })
    const tools = fingerprintRequest({ ...REQ_087, tools: [...TOOLS, { name: "Bash" }] })
    expect(comparePrefix(a, tools)).toEqual({ kind: "tools" })
    const msgs = REQ_087.messages.slice()
    msgs[2] = { role: "user", content: [toolResult("edited")] }
    expect(comparePrefix(a, fingerprintRequest({ ...REQ_087, messages: msgs }))).toEqual({
      kind: "message",
      index: 2,
      removed: false,
    })
    const both = fingerprintRequest({
      ...REQ_087,
      tools: [...TOOLS, { name: "Bash" }],
      system: [{ ...SYSTEM[0], text: "y" }],
    })
    expect(comparePrefix(a, both)).toEqual({ kind: "tools_system" })
  })

  it("a shorter history is a removed message", () => {
    const a = fingerprintRequest(REQ_086)
    const short = fingerprintRequest({ ...REQ_086, messages: REQ_086.messages.slice(0, 3) })
    expect(comparePrefix(a, short)).toEqual({ kind: "message", index: 3, removed: true })
  })

  it("hashes the request options and the sorted anthropic-beta header, not the volatile fields", () => {
    const a = fingerprintRequest(
      { ...REQ_086, max_tokens: 1, stream: true, metadata: { u: 1 }, diagnostics: { p: "a" } },
      { "anthropic-beta": "b-2,a-1" },
    )
    const same = fingerprintRequest(
      { ...REQ_086, max_tokens: 2, stream: false, metadata: { u: 2 }, diagnostics: { p: "b" } },
      { "Anthropic-Beta": "a-1, b-2" },
    )
    expect(same.options).toBe(a.options as string)
    expect(comparePrefix(a, same)).toEqual({ kind: "same", upTo: 4 })
    const beta = fingerprintRequest(REQ_086, { "anthropic-beta": "a-1,b-2,c-3" })
    expect(comparePrefix(a, beta)).toEqual({ kind: "options" })
    const thinkingCfg = fingerprintRequest(
      { ...REQ_086, thinking: { type: "adaptive" } },
      { "anthropic-beta": "a-1,b-2" },
    )
    expect(comparePrefix(a, thinkingCfg)).toEqual({ kind: "options" })
  })

  it("only the removal at the previous latest thinking is expected", () => {
    // Thinking at 1 and 3. The removal at 3 is expected; at 1 it is a change.
    const msgs = REQ_086.messages.slice()
    msgs[1] = { role: "assistant", content: [thinking("old"), toolUse("a")] }
    const prev = fingerprintRequest({ ...REQ_086, messages: msgs })
    expect(prev.thinkingAt).toEqual([1, 3])
    const strip1 = msgs.slice()
    strip1[1] = { role: "assistant", content: [toolUse("a")] }
    expect(comparePrefix(prev, fingerprintRequest({ ...REQ_086, messages: strip1 }))).toEqual({
      kind: "thinking",
      index: 1,
    })
    const strip3 = msgs.slice()
    strip3[3] = { role: "assistant", content: [toolUse("b")] }
    expect(comparePrefix(prev, fingerprintRequest({ ...REQ_086, messages: strip3 }))).toEqual({
      kind: "same",
      upTo: 4,
      strippedAt: 3,
    })
  })
})

describe("server_miss and prefix_changed attribution", () => {
  /** A watcher on one detector, with a clock that moves 1 s for each call. */
  function watched() {
    const sink = recorder()
    const d = new CacheAnomalyDetector({ sink })
    let t = 0
    const w = createWireWatch(
      () => d,
      () => 0,
      () => (t += 1000),
    )
    return { sink, w }
  }

  it("the 087 shape (read 0, prefix unchanged) is server_miss at info, with the request id", () => {
    const { sink, w } = watched()
    drive(w, { id: "086", body: REQ_086, sse: usageSse(211_620, 1_021) })
    drive(w, {
      id: "087",
      body: REQ_087,
      sse: missSse(0, 213_492, "messages_changed", 167_395),
      resHeaders: { "request-id": "req_087" },
    })
    expect(sink.warnings).toEqual([])
    expect(sink.infos.map((x) => x.sd)).toEqual([
      {
        code: "server_miss",
        turn: 2,
        written: 213_492,
        lastMarkerIndex: 4,
        gapSec: 1,
        reason: "messages_changed",
        missedTokens: 167_395,
        requestId: "req_087",
      },
    ])
    const msg = sink.infos[0]?.message ?? ""
    expect(msg).toContain(
      "likely a server-side miss: the prefix up to the previous marker is unchanged and the previous request read its cache",
    )
    expect(msg).not.toContain("did not find")
    expect(msg).toContain("server-reported miss size: 167395 tokens")
    expect(msg).toContain("Request id: req_087.")
    expect(msg).not.toContain("tokens missed")
  })

  it("server_miss does not start or extend the prefix_changed streak", () => {
    const sink = recorder()
    const d = new CacheAnomalyDetector({ sink })
    const p086 = fingerprintRequest(REQ_086)
    const p087 = fingerprintRequest(REQ_087)
    const changed = fingerprintRequest({ ...REQ_087, system: [{ type: "text", text: "z" }] })
    d.observe(f(5000, 100, { prefix: p086 }))
    expect(d.observe(f(0, 5000, { prefix: p087 }))).toEqual(["server_miss"])
    expect(d.observe(f(0, 5000, { prefix: changed }))).toEqual(["prefix_changed"])
    expect(d.observe(f(0, 5000, { prefix: changed }))).toEqual(["server_miss"])
    expect(d.observe(f(0, 5000, { prefix: p087 }))).toEqual(["prefix_changed"])
    expect(sink.warnings.map((w) => [w.sd?.streak, w.sd?.written])).toEqual([[1, 5000]])
    expect(sink.infos.map((w) => w.sd?.code)).toEqual(["server_miss", "server_miss"])
  })

  it("a changed system is prefix_changed and the text says so", () => {
    const { sink, w } = watched()
    drive(w, { id: "1", body: REQ_086, sse: usageSse(211_620, 1_021) })
    const body = { ...REQ_087, system: [{ ...SYSTEM[0], text: "changed" }] }
    drive(w, { id: "2", body, sse: missSse(0, 9000, "system_changed", 8000) })
    expect(sink.infos).toEqual([])
    expect(sink.warnings.map((x) => [x.sd?.code, x.sd?.changed])).toEqual([
      ["prefix_changed", "system"],
    ])
    expect(sink.warnings[0]?.message).toContain("The system prompt changed since turn 1.")
  })

  it("changed tools are prefix_changed and the text says so", () => {
    const { sink, w } = watched()
    drive(w, { id: "1", body: REQ_086, sse: usageSse(211_620, 1_021) })
    const body = { ...REQ_087, tools: [...TOOLS, { name: "Bash", input_schema: {} }] }
    drive(w, { id: "2", body, sse: usageSse(0, 9000) })
    expect(sink.warnings.map((x) => [x.sd?.code, x.sd?.changed])).toEqual([
      ["prefix_changed", "tools"],
    ])
    expect(sink.warnings[0]?.message).toContain("The tools changed since turn 1.")
  })

  it("a changed older message is prefix_changed with the first changed index", () => {
    const { sink, w } = watched()
    drive(w, { id: "1", body: REQ_086, sse: usageSse(211_620, 1_021) })
    const messages = REQ_087.messages.slice()
    messages[1] = { role: "assistant", content: [toolUse("edited")] }
    drive(w, {
      id: "2",
      body: { ...REQ_087, messages },
      sse: missSse(0, 9000, "messages_changed", 8000),
    })
    expect(sink.warnings.map((x) => x.sd)).toEqual([
      {
        code: "prefix_changed",
        turn: 2,
        streak: 1,
        written: 9000,
        reason: "messages_changed",
        missedTokens: 8000,
        changed: "message",
        changedIndex: 1,
      },
    ])
    expect(sink.warnings[0]?.message).toContain("Message 1 changed since turn 1")
  })

  it("a partial read after only a thinking removal with a small write gives no diagnostic", () => {
    // bba2ddf4/088: read 211,620, write 6,404 (3% of the prompt), the server says messages_changed.
    const { sink, w } = watched()
    drive(w, { id: "1", body: REQ_086, sse: usageSse(211_620, 1_021) })
    drive(w, {
      id: "2",
      body: REQ_087,
      sse: missSse(211_620, 6_404, "messages_changed", 300_000),
    })
    expect(sink.warnings).toEqual([])
    expect(sink.infos).toEqual([])
  })

  it("a partial read after a thinking removal with a large write is prefix_changed", () => {
    // 932e6ae3/R8: read 77,741, write 46,846 (38% of the prompt).
    const { sink, w } = watched()
    drive(w, { id: "1", body: REQ_086, sse: usageSse(77_741, 29_257) })
    drive(w, { id: "2", body: REQ_087, sse: missSse(77_741, 46_846, "messages_changed", 85_685) })
    expect(sink.infos).toEqual([])
    expect(sink.warnings.map((x) => x.sd)).toEqual([
      {
        code: "prefix_changed",
        turn: 2,
        streak: 1,
        written: 46_846,
        reason: "messages_changed",
        missedTokens: 85_685,
        changed: "thinking_older_entry",
        changedIndex: 3,
      },
    ])
    expect(sink.warnings[0]?.message).toContain(
      "Thinking removal; the read stays on an older entry",
    )
  })

  it("a read of 0 after a thinking removal and a low previous read is prefix_changed", () => {
    // 932e6ae3/R16: the previous request read 77,741 of 161,079 (48%).
    const { sink, w } = watched()
    drive(w, { id: "1", body: REQ_086, sse: usageSse(77_741, 83_338) })
    drive(w, { id: "2", body: REQ_087, sse: missSse(0, 166_690, "messages_changed", 127_843) })
    expect(sink.infos).toEqual([])
    expect(sink.warnings.map((x) => [x.sd?.code, x.sd?.changed, x.sd?.changedIndex])).toEqual([
      ["prefix_changed", "thinking_lookback", 3],
    ])
    expect(sink.warnings[0]?.message).toContain(
      "Thinking removal + cache lookback: no reachable cache entry.",
    )
  })

  it("a read of 0 with no thinking removed is server_miss even after a write-only turn", () => {
    // 932e6ae3/R2: the previous request only wrote, and no thinking was removed.
    const { sink, w } = watched()
    drive(w, { id: "1", body: REQ_086, sse: usageSse(0, 22_113) })
    drive(w, { id: "2", body: REQ_086, sse: usageSse(0, 24_585) })
    expect(sink.warnings).toEqual([])
    expect(sink.infos.map((x) => x.sd?.code)).toEqual(["server_miss"])
    expect(sink.infos[0]?.message).toContain("unchanged and no thinking was removed")
  })

  it("a thinking removal from an older message is prefix_changed", () => {
    const { sink, w } = watched()
    const msgs = REQ_086.messages.slice()
    msgs[1] = { role: "assistant", content: [thinking("old"), toolUse("a")] }
    drive(w, { id: "1", body: { ...REQ_086, messages: msgs }, sse: usageSse(211_620, 1_021) })
    const next = REQ_087.messages.slice()
    next[3] = { role: "assistant", content: [thinking("plan"), toolUse("b")] }
    drive(w, { id: "2", body: { ...REQ_087, messages: next }, sse: usageSse(0, 213_492) })
    expect(sink.warnings.map((x) => [x.sd?.code, x.sd?.changed, x.sd?.changedIndex])).toEqual([
      ["prefix_changed", "thinking", 1],
    ])
    expect(sink.warnings[0]?.message).toContain("Thinking removed from message 1 since turn 1")
  })

  it("a changed anthropic-beta header with a read of 0 is prefix_changed (options)", () => {
    const { sink, w } = watched()
    const beta = (v: string) => ({ "anthropic-beta": v })
    drive(w, { id: "1", body: REQ_086, sse: usageSse(211_620, 1_021), reqHeaders: beta("x,y") })
    drive(w, { id: "2", body: REQ_087, sse: usageSse(0, 9000), reqHeaders: beta("x,y,z") })
    expect(sink.infos).toEqual([])
    expect(sink.warnings.map((x) => [x.sd?.code, x.sd?.changed])).toEqual([
      ["prefix_changed", "options"],
    ])
    expect(sink.warnings[0]?.message).toContain("The request options changed since turn 1")
  })

  it("reads the request-id header in any letter case", () => {
    const { sink, w } = watched()
    drive(w, { id: "1", body: REQ_086, sse: usageSse(211_620, 1_021) })
    drive(w, {
      id: "2",
      body: REQ_087,
      sse: usageSse(0, 213_492),
      resHeaders: { "Request-Id": "req_upper" },
    })
    expect(sink.infos.map((x) => [x.sd?.code, x.sd?.requestId])).toEqual([
      ["server_miss", "req_upper"],
    ])
  })

  it("a turn where only one side has a fingerprint uses the old text", () => {
    const p086 = fingerprintRequest(REQ_086)
    for (const [a, b] of [
      [{ prefix: p086 }, {}],
      [{}, { prefix: fingerprintRequest(REQ_087) }],
    ] as const) {
      const sink = recorder()
      const d = new CacheAnomalyDetector({ sink })
      d.observe(f(211_620, 1_021, a))
      expect(d.observe(f(0, 213_492, b))).toEqual(["prefix_changed"])
      expect(sink.infos).toEqual([])
      expect(sink.warnings[0]?.sd?.changed).toBeUndefined()
      expect(sink.warnings[0]?.message).toContain("The request prefix likely changed between turns")
    }
  })

  it("the 932e6ae3 shape: stuck partial reads, then reads of 0, warns at the milestones", () => {
    // Each turn removes the thinking of the previous latest assistant message
    // and adds a pair. The read stays at 77,741 for 13 turns (a large write
    // each time), then falls to 0 when the old entry is out of the lookback.
    const conv = (n: number) => {
      const messages: unknown[] = [{ role: "user", content: "start" }]
      for (let j = 1; j <= n; j++) {
        messages.push({
          role: "assistant",
          content: j === n ? [thinking(`t${j}`), toolUse(`u${j}`)] : [toolUse(`u${j}`)],
        })
        messages.push({ role: "user", content: [toolResult(`u${j}`, j === n)] })
      }
      return { model: "m", tools: TOOLS, system: SYSTEM, messages }
    }
    const { sink, w } = watched()
    drive(w, { id: "0", body: conv(1), sse: usageSse(77_741, 11_897) })
    for (let k = 1; k <= 13; k++) {
      const write = 40_000 + k * 3_000
      drive(w, {
        id: `p${k}`,
        body: conv(1 + k),
        sse: missSse(77_741, write, "messages_changed", 77_741 + write - 5_000),
      })
    }
    for (let k = 1; k <= 17; k++) {
      drive(w, {
        id: `z${k}`,
        body: conv(14 + k),
        sse: missSse(0, 166_690 + k * 1_000, "messages_changed", 127_843),
      })
    }
    expect(sink.infos).toEqual([])
    expect(sink.warnings.map((x) => [x.sd?.streak, x.sd?.changed])).toEqual([
      [1, "thinking_older_entry"],
      [3, "thinking_older_entry"],
      [10, "thinking_older_entry"],
      [30, "thinking_lookback"],
    ])
    expect(sink.warnings[3]?.message).toContain(
      "Thinking removal + cache lookback: no reachable cache entry.",
    )
  })
})
