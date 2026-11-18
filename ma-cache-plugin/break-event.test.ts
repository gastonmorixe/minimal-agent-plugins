import { describe, expect, it } from "bun:test"

import { CACHE_DID_BREAK, type CacheBreakPayload } from "@minimal-agent/core/plugin-api"

import {
  drive,
  f,
  MARKED,
  missSse,
  REQ_086,
  REQ_087,
  recorder,
  TOOLS,
  usageSse,
} from "./__fixtures__/cache-test-kit.ts"
import { CacheAnomalyDetector } from "./detector.ts"
import { start } from "./start.ts"
import { createWireWatch, fingerprintRequest, type WireObserver } from "./wire-watch.ts"

/** A detector with a recording sink and a list of break events. */
function detector() {
  const sink = recorder()
  const breaks: CacheBreakPayload[] = []
  const d = new CacheAnomalyDetector({
    sink,
    onBreak: (p) => breaks.push(p),
    history: { sessionId: "s1", model: "m", origin: "https://api.example.test" },
  })
  return { sink, breaks, d }
}

/** A watcher on one detector, with a settable clock. */
function watched() {
  const { sink, breaks, d } = detector()
  let t = 0
  const w = createWireWatch(
    () => d,
    () => 0,
    () => t,
  )
  return {
    sink,
    breaks,
    w,
    at: (ms: number) => {
      t = ms
    },
  }
}

const MIN = 60_000

describe("cache.didBreak events", () => {
  it("an idle gap and changed tools is prefix_changed, idle, and warns", () => {
    const { sink, breaks, w, at } = watched()
    drive(w, { id: "1", body: REQ_086, sse: usageSse(211_620, 1_021) })
    at(63 * MIN)
    const body = { ...REQ_087, tools: [...TOOLS, { name: "Bash", input_schema: {} }] }
    drive(w, { id: "2", body, sse: usageSse(0, 9000), resHeaders: { "request-id": "req_2" } })
    expect(sink.infos).toEqual([])
    expect(sink.warnings.map((x) => [x.sd?.code, x.sd?.changed, x.sd?.idle])).toEqual([
      ["prefix_changed", "tools", true],
    ])
    expect(sink.warnings[0]?.message).toContain("above the 300 s TTL")
    expect(sink.warnings[0]?.message).toContain("The session was also idle for 63 min")
    expect(breaks).toHaveLength(1)
    expect(breaks[0]).toMatchObject({
      v: 1,
      sessionId: "s1",
      model: "m",
      origin: "https://api.example.test",
      turn: 2,
      prevTurn: 1,
      cause: "prefix_changed",
      changed: "tools",
      idle: true,
      gapSec: 3780,
      ttlSec: 300,
      expectedRead: 212_641,
      read: 0,
      written: 9000,
      lost: 212_641,
      requestId: "req_2",
      actionable: true,
      streak: 1,
      streakLost: 212_641,
      at: 63 * MIN,
    })
    expect(breaks[0]?.message).toContain("the tools changed since turn 1; also idle 63 min")
  })

  it("an idle gap and an unchanged prefix is ttl_expired, lost = previous read + write", () => {
    const { sink, breaks, w, at } = watched()
    drive(w, { id: "1", body: REQ_086, sse: usageSse(40_000, 8_213) })
    at(63 * MIN)
    drive(w, { id: "2", body: REQ_086, sse: usageSse(0, 49_000) })
    expect(sink.warnings).toEqual([])
    expect(sink.infos.map((x) => x.sd)).toEqual([
      { code: "ttl_expired", turn: 2, gapSec: 3780, ttlSec: 300, written: 49_000, lost: 48_213 },
    ])
    expect(breaks).toHaveLength(1)
    expect(breaks[0]).toMatchObject({
      cause: "ttl_expired",
      idle: true,
      expectedRead: 48_213,
      lost: 48_213,
      written: 49_000,
      actionable: false,
    })
    expect(breaks[0]?.changed).toBeUndefined()
    expect(breaks[0]?.message).toBe(
      "cache broke on turn 2: 48,213 tokens rewritten (idle 63 min > 5 min TTL)",
    )
  })

  it("an idle gap after the expected thinking removal is ttl_expired, not lookback", () => {
    const { sink, breaks, w, at } = watched()
    drive(w, { id: "1", body: REQ_086, sse: usageSse(77_741, 83_338) })
    at(63 * MIN)
    drive(w, { id: "2", body: REQ_087, sse: missSse(0, 166_690, "messages_changed", 127_843) })
    expect(sink.warnings).toEqual([])
    expect(sink.infos.map((x) => x.sd?.code)).toEqual(["ttl_expired"])
    expect(breaks.map((b) => b.cause)).toEqual(["ttl_expired"])
  })

  it("a server_miss is a warn diagnostic with the request id, and an actionable break", () => {
    const { sink, breaks, w, at } = watched()
    drive(w, { id: "1", body: REQ_086, sse: usageSse(211_620, 1_021) })
    at(1000)
    drive(w, {
      id: "2",
      body: REQ_087,
      sse: usageSse(0, 213_492),
      resHeaders: { "request-id": "req_s" },
    })
    expect(sink.infos).toEqual([])
    expect(sink.warnings.map((x) => [x.sd?.code, x.sd?.requestId])).toEqual([
      ["server_miss", "req_s"],
    ])
    expect(breaks.map((b) => [b.cause, b.requestId, b.actionable, b.idle])).toEqual([
      ["server_miss", "req_s", true, false],
    ])
  })

  it("a messages_changed partial read with a small write is a break, with no warning", () => {
    const { sink, breaks, d } = detector()
    const p086 = fingerprintRequest(REQ_086)
    const p087 = fingerprintRequest(REQ_087)
    const changed = fingerprintRequest({ ...REQ_087, system: [{ type: "text", text: "z" }] })
    d.observe(f(211_620, 1_021, { prefix: changed }))
    // A prefix_changed miss (the system changed) starts the warning streak.
    expect(d.observe(f(0, 5000, { prefix: p086 }))).toEqual(["prefix_changed"])
    // The small-write thinking case: no code, no diagnostic, but a break.
    const miss = { reason: "messages_changed", missedTokens: 300_000 }
    expect(d.observe(f(4000, 100, { prefix: p087, cacheMiss: miss }))).toEqual([])
    expect(sink.warnings.map((w) => w.sd?.code)).toEqual(["prefix_changed"])
    expect(sink.infos).toEqual([])
    expect(breaks.map((b) => [b.cause, b.actionable, b.lost, b.streak])).toEqual([
      ["prefix_changed", true, 212_641, 1],
      ["thinking_older_entry", false, 1000, 2],
    ])
    expect(breaks[1]?.changedIndex).toBe(3)
    expect(breaks[1]?.message).toContain("expected")
  })

  it("the small-write case keeps the prefix_changed streak as before (it ends it)", () => {
    const { sink, d } = detector()
    const p086 = fingerprintRequest(REQ_086)
    const p087 = fingerprintRequest(REQ_087)
    const miss = { reason: "messages_changed", missedTokens: 300_000 }
    d.observe(f(211_620, 1_021, { prefix: p086 }))
    d.observe(f(0, 5000))
    d.observe(f(0, 5000))
    d.observe(f(211_620, 6_404, { prefix: p086 }))
    d.observe(f(211_620, 6_404, { prefix: p087, cacheMiss: miss }))
    d.observe(f(0, 5000))
    expect(sink.warnings.map((w) => w.sd?.streak)).toEqual([1, 1])
  })

  it("5 prefix_changed misses in a row give 5 break events, and warn at 1 and 3", () => {
    const { sink, breaks, d } = detector()
    d.observe(f(0, 1000))
    for (let i = 0; i < 5; i++) d.observe(f(0, 1000))
    expect(sink.warnings.map((w) => w.sd?.streak)).toEqual([1, 3])
    expect(breaks.map((b) => [b.turn, b.streak, b.streakLost])).toEqual([
      [2, 1, 1000],
      [3, 2, 2000],
      [4, 3, 3000],
      [5, 4, 4000],
      [6, 5, 5000],
    ])
  })

  it("a turn that reads fully gives no event, and ends the break streak", () => {
    const { breaks, d } = detector()
    d.observe(f(0, 5000))
    d.observe(f(5000, 100))
    expect(breaks).toEqual([])
    d.observe(f(0, 5000))
    d.observe(f(5100, 0))
    d.observe(f(0, 5000))
    expect(breaks.map((b) => b.streak)).toEqual([1, 1])
  })

  it("a ttl_expired break also counts in the break streak", () => {
    const { breaks, d } = detector()
    d.observe(f(0, 1000, { respondedAt: 0 }))
    d.observe(f(0, 1000, { requestStartedAt: 400_000, respondedAt: 401_000 }))
    d.observe(f(0, 1000))
    expect(breaks.map((b) => [b.cause, b.streak])).toEqual([
      ["ttl_expired", 1],
      ["unknown", 2],
    ])
  })
})

describe("server_miss warning milestones", () => {
  const p086 = fingerprintRequest(REQ_086)
  const same = (read: number, write: number) => f(read, write, { prefix: p086 })

  it("10 server misses in a row: 10 breaks, warnings at 1, 3 and 10", () => {
    const { sink, breaks, d } = detector()
    d.observe(same(5000, 100))
    for (let i = 0; i < 10; i++) expect(d.observe(same(0, 5100))).toEqual(["server_miss"])
    expect(breaks.map((b) => b.cause)).toEqual(Array(10).fill("server_miss"))
    expect(sink.warnings.map((w) => [w.level, w.sd?.code, w.sd?.streak])).toEqual([
      ["warn", "server_miss", undefined],
      ["warn", "server_miss", 3],
      ["warn", "server_miss", 10],
    ])
    expect(sink.warnings[0]?.message).not.toContain("in a row")
    expect(sink.warnings[1]?.message).toContain("3 server misses in a row.")
    expect(sink.warnings[2]?.message).toContain("10 server misses in a row.")
  })

  it("a clean read, a ttl_expired and another break cause each end the count", () => {
    const { sink, breaks, d } = detector()
    const changed = fingerprintRequest({ ...REQ_086, system: [{ type: "text", text: "z" }] })
    d.observe(same(5000, 100))
    d.observe(same(0, 5100)) // server_miss 1
    d.observe(same(0, 5100)) // server_miss 2
    d.observe(same(5100, 0)) // clean read
    d.observe(same(0, 5100)) // server_miss 1 again
    d.observe(same(0, 5100)) // server_miss 2
    d.observe(f(0, 5100, { prefix: p086, respondedAt: 0 })) // server_miss 3
    d.observe(f(0, 5100, { prefix: p086, requestStartedAt: 400_000, respondedAt: 401_000 }))
    d.observe(same(0, 5100)) // server_miss 1 after ttl_expired
    d.observe(f(0, 5100, { prefix: changed })) // prefix_changed
    d.observe(f(0, 5100, { prefix: p086 })) // prefix_changed back
    d.observe(same(0, 5100)) // server_miss 1 after another cause
    expect(breaks.map((b) => b.cause)).toEqual([
      "server_miss",
      "server_miss",
      "server_miss",
      "server_miss",
      "server_miss",
      "ttl_expired",
      "server_miss",
      "prefix_changed",
      "prefix_changed",
      "server_miss",
    ])
    expect(
      sink.warnings.filter((w) => w.sd?.code === "server_miss").map((w) => w.sd?.streak ?? 1),
    ).toEqual([1, 1, 3, 1, 1])
  })
})

describe("breaks with no diagnostic cause", () => {
  it("a turn with no marker after a warm turn is one unknown break, with no warning", () => {
    const { sink, breaks, d } = detector()
    d.observe(f(5000, 100, { respondedAt: 1000 }))
    expect(d.observe(f(0, 300, { markers: 0, requestStartedAt: 3000, respondedAt: 4000 }))).toEqual(
      [],
    )
    expect(sink.warnings).toEqual([])
    expect(sink.infos).toEqual([])
    expect(breaks).toHaveLength(1)
    expect(breaks[0]).toMatchObject({
      cause: "unknown",
      turn: 2,
      prevTurn: 1,
      expectedRead: 5100,
      read: 0,
      written: 300,
      lost: 5100,
      gapSec: 2,
      idle: false,
      actionable: true,
    })
    expect(breaks[0]?.message).toContain("the request had no cache_control markers")
    // The turn with no marker is the new previous turn: the next turn is
    // compared with it (expectedRead 300), not with turn 1.
    d.observe(f(0, 5000))
    expect(breaks.map((b) => [b.prevTurn, b.expectedRead])).toEqual([
      [1, 5100],
      [2, 300],
    ])
  })

  it("a no-marker turn that reads and writes 0 is a cold previous turn", () => {
    const { breaks, d } = detector()
    d.observe(f(5000, 100))
    d.observe(f(0, 0, { markers: 0 }))
    d.observe(f(0, 5000))
    expect(breaks.map((b) => b.turn)).toEqual([2])
  })

  it("a turn with no marker after a cold turn, or that reads, is not a break", () => {
    const { breaks, d } = detector()
    d.observe({ ...f(0, 0), markers: 0 })
    d.observe({ ...f(0, 0), markers: 0 })
    d.observe(f(5000, 100))
    d.observe(f(5000, 0, { markers: 0 }))
    expect(breaks).toEqual([])
  })

  it("markers, 0 read and 0 write after a warm turn: one unknown break and the cold warning once", () => {
    const { sink, breaks, d } = detector()
    d.observe(f(5000, 100))
    expect(d.observe(f(0, 0))).toEqual(["markers_ignored_cold"])
    expect(breaks).toHaveLength(1)
    expect(breaks[0]).toMatchObject({
      cause: "unknown",
      expectedRead: 5100,
      read: 0,
      written: 0,
      lost: 5100,
      actionable: true,
    })
    expect(breaks[0]?.message).toContain("the server neither read nor wrote the cache")
    expect(breaks[0]?.message).toContain("5,100 cached tokens not read")
    // The next cold turn has a cold previous turn: no break.
    d.observe(f(0, 0))
    expect(breaks).toHaveLength(1)
    // A second warm-then-cold pair is a second break, and no second warning.
    d.observe(f(0, 5000))
    d.observe(f(0, 0))
    expect(breaks.map((b) => [b.cause, b.written])).toEqual([
      ["unknown", 0],
      ["unknown", 0],
    ])
    expect(sink.warnings.map((w) => w.sd?.code)).toEqual(["markers_ignored_cold"])
  })

  it("the below-minimum cold case after a warm turn is also one break", () => {
    const sink = recorder()
    const breaks: CacheBreakPayload[] = []
    const d = new CacheAnomalyDetector({
      sink,
      minPrefixTokens: () => 100_000,
      onBreak: (p) => breaks.push(p),
    })
    d.observe(f(5000, 100))
    expect(d.observe(f(0, 0))).toEqual(["below_min_block_size"])
    expect(breaks.map((b) => b.cause)).toEqual(["unknown"])
    expect(sink.warnings.map((w) => w.sd?.code)).toEqual(["below_min_block_size"])
  })
})

describe("start wires cache.didBreak to ctx.emit", () => {
  it("emits one payload with the session, model and origin of the history", () => {
    let observer: WireObserver | undefined
    const emitted: [string, unknown][] = []
    const stop = start({
      log: recorder(),
      emit: (channel, payload) => emitted.push([channel, payload]),
      host: { network: { observe: (o: WireObserver) => ((observer = o), () => {}) } },
    })
    if (!observer || !stop) throw new Error("no observer")
    drive(observer, { id: "1", body: MARKED, sse: usageSse(5000, 100), session: "sess-e" })
    drive(observer, { id: "2", body: MARKED, sse: usageSse(0, 5100), session: "sess-e" })
    expect(emitted).toHaveLength(1)
    expect(emitted[0]?.[0]).toBe(CACHE_DID_BREAK)
    expect(emitted[0]?.[1]).toMatchObject({
      sessionId: "sess-e",
      model: MARKED.model,
      origin: "https://api.example.test",
      cause: "server_miss",
      lost: 5100,
    })
    stop()
  })

  it("a host without ctx.emit still works", () => {
    let observer: WireObserver | undefined
    const sink = recorder()
    const stop = start({
      log: sink,
      host: { network: { observe: (o: WireObserver) => ((observer = o), () => {}) } },
    })
    if (!observer || !stop) throw new Error("no observer")
    drive(observer, { id: "1", body: MARKED, sse: usageSse(5000, 100), session: "s" })
    drive(observer, { id: "2", body: MARKED, sse: usageSse(0, 5100), session: "s" })
    expect(sink.warnings.map((w) => w.sd?.code)).toEqual(["server_miss"])
    stop()
  })
})
