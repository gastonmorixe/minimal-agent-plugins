import { describe, expect, it } from "bun:test"

import { COLD_SSE, drive, f, MARKED, recorder, usageSse } from "./__fixtures__/cache-test-kit.ts"
import {
  ANOMALY_SOURCE,
  CacheAnomalyDetector,
  isStreakMilestone,
  snapshotRequest,
} from "./detector.ts"
import onTargetSwitch from "./on_target_switch.ts"
import { detectorKeyOf, MAX_DETECTORS, resetAllDetectors, sessionKeyOf, start } from "./start.ts"
import {
  createWireWatch,
  extractCacheFacts,
  type WireObserver,
  type WireRequest,
} from "./wire-watch.ts"

describe("CacheAnomalyDetector", () => {
  it("a turn with cache markers and 0 cache reads gives exactly one warning", () => {
    const sink = recorder()
    const d = new CacheAnomalyDetector({ sink })
    expect(d.observe(f(0, 0))).toEqual(["markers_ignored_cold"])
    expect(sink.warnings).toHaveLength(1)
    expect(sink.warnings[0]?.source).toBe(ANOMALY_SOURCE)
    expect(sink.warnings[0]?.sd).toEqual({ code: "markers_ignored_cold" })
  })

  it("writes each cold code one time only", () => {
    const sink = recorder()
    const d = new CacheAnomalyDetector({ sink })
    d.observe(f(0, 0))
    d.observe(f(0, 0))
    expect(sink.warnings).toHaveLength(1)
  })

  it("a healthy cache gives no warning", () => {
    const sink = recorder()
    const d = new CacheAnomalyDetector({ sink })
    d.observe(f(0, 5000))
    d.observe(f(5000, 0))
    d.observe(f(5200, 100))
    expect(sink.warnings).toEqual([])
    expect(sink.infos).toEqual([])
  })

  it("a request without markers gives no warning", () => {
    const sink = recorder()
    const d = new CacheAnomalyDetector({ sink })
    d.observe({ ...f(0, 0), markers: 0 })
    expect(sink.warnings).toEqual([])
  })

  it("uses the injected per-model minimum for below_min_block_size", () => {
    const sink = recorder()
    const d = new CacheAnomalyDetector({ sink, minPrefixTokens: () => 10_000 })
    expect(d.observe(f(0, 0))).toEqual(["below_min_block_size"])
    expect(sink.warnings[0]?.message).toContain("10000-token cache minimum")
  })

  it("a read of 0 after a write, or after reads, is prefix_changed", () => {
    const sink = recorder()
    const d = new CacheAnomalyDetector({ sink })
    d.observe(f(0, 5000))
    expect(d.observe(f(0, 5000))).toEqual(["prefix_changed"])
    const e = new CacheAnomalyDetector({ sink: recorder() })
    e.observe(f(1, 0))
    e.observe(f(2, 0))
    expect(e.observe(f(0, 9))).toEqual(["prefix_changed"])
  })

  it("a miss after a gap longer than the TTL is ttl_expired, at info level", () => {
    // Frank's session, request 2: 485 s after request 1 ended, TTL 5m.
    const sink = recorder()
    const d = new CacheAnomalyDetector({ sink })
    d.observe(f(0, 22113, { ttlSeconds: 300, requestStartedAt: 0, respondedAt: 10_000 }))
    const codes = d.observe(
      f(0, 24585, { ttlSeconds: 300, requestStartedAt: 495_000, respondedAt: 500_000 }),
    )
    expect(codes).toEqual(["ttl_expired"])
    expect(sink.warnings).toEqual([])
    expect(sink.infos.map((w) => w.sd)).toEqual([
      { code: "ttl_expired", turn: 2, gapSec: 485, ttlSec: 300 },
    ])
    expect(sink.infos[0]?.message).toContain("expired: 485 s passed since turn 1 ended")
  })

  it("the same gap inside a 1h TTL is prefix_changed", () => {
    const sink = recorder()
    const d = new CacheAnomalyDetector({ sink })
    d.observe(f(0, 5000, { ttlSeconds: 3600, respondedAt: 0 }))
    expect(d.observe(f(0, 5000, { ttlSeconds: 3600, requestStartedAt: 485_000 }))).toEqual([
      "prefix_changed",
    ])
    expect(sink.warnings[0]?.message).toContain("inside the 3600 s TTL")
  })

  it("prints the server's miss reason", () => {
    const sink = recorder()
    const d = new CacheAnomalyDetector({ sink })
    d.observe(f(77741, 3000, { respondedAt: 1000 }))
    d.observe(
      f(0, 166690, {
        requestStartedAt: 1800,
        cacheMiss: { reason: "messages_changed", missedTokens: 155827 },
      }),
    )
    expect(sink.warnings).toHaveLength(1)
    expect(sink.warnings[0]?.message).toContain("turn 2 read 0 cached tokens, 0.8 s after turn 1")
    expect(sink.warnings[0]?.message).toContain(
      "The server says: messages_changed (server-reported miss size: 155827 tokens).",
    )
    expect(sink.warnings[0]?.message).toContain("wrote 166690 tokens to the cache")
    expect(sink.warnings[0]?.message).not.toContain("tokens missed")
    expect(sink.warnings[0]?.sd).toEqual({
      code: "prefix_changed",
      turn: 2,
      streak: 1,
      written: 166690,
      reason: "messages_changed",
      missedTokens: 155827,
    })
  })

  it("a partial read with a larger server miss is prefix_changed", () => {
    // Frank's R3 to R15: reads stay flat at an old anchor, the server says the rest missed.
    const sink = recorder()
    const d = new CacheAnomalyDetector({ sink })
    d.observe(f(22113, 30000))
    const miss = { reason: "messages_changed", missedTokens: 40000 }
    expect(d.observe(f(22113, 31000, { cacheMiss: miss }))).toEqual(["prefix_changed"])
    expect(sink.warnings[0]?.message).toContain(
      "read 22113 cached tokens, less than the server-reported miss size of 40000",
    )
    // A small miss next to a large read is normal growth: no warning.
    const e = new CacheAnomalyDetector({ sink: recorder() })
    e.observe(f(22113, 300))
    expect(e.observe(f(22413, 300, { cacheMiss: { reason: "x", missedTokens: 10 } }))).toEqual([])
  })

  it("warns again at 3, 10 and 30 misses in a row, with the tokens written", () => {
    const sink = recorder()
    const d = new CacheAnomalyDetector({ sink })
    d.observe(f(0, 1000))
    for (let i = 0; i < 30; i++) d.observe(f(0, 1000))
    expect(sink.warnings.map((w) => w.sd?.streak)).toEqual([1, 3, 10, 30])
    expect(sink.warnings[3]?.message).toContain(
      "30 misses in a row, 30000 tokens written to the cache since the first.",
    )
  })

  it("a healthy read ends the streak, so the next miss warns as the first again", () => {
    const sink = recorder()
    const d = new CacheAnomalyDetector({ sink })
    d.observe(f(0, 1000))
    d.observe(f(0, 1000))
    d.observe(f(0, 1000))
    d.observe(f(2000, 10))
    d.observe(f(0, 1000))
    expect(sink.warnings.map((w) => w.sd?.streak)).toEqual([1, 1])
  })

  it("counts turns past 3 (the old counter stopped at 4)", () => {
    const sink = recorder()
    const d = new CacheAnomalyDetector({ sink })
    for (let i = 0; i < 6; i++) d.observe(f(5000, 10))
    d.observe(f(0, 5000))
    expect(sink.warnings[0]?.sd?.turn).toBe(7)
    expect(sink.warnings[0]?.message).toContain("turn 7 read 0")
  })

  it("isStreakMilestone: 1, 3, 10, 30, 100, 300, 1000", () => {
    const hits = Array.from({ length: 1000 }, (_, i) => i + 1).filter(isStreakMilestone)
    expect(hits).toEqual([1, 3, 10, 30, 100, 300, 1000])
  })
})

describe("snapshotRequest", () => {
  it("counts markers in system, tools and nested blocks, and keeps the longest TTL", () => {
    const snap = snapshotRequest(
      {
        system: [{ type: "text", text: "abcd", cache_control: { type: "ephemeral" } }],
        tools: [{ name: "t", cache_control: { type: "ephemeral", ttl: "1h" } }],
        messages: [{ role: "user", content: [{ type: "text", text: "xy", cache_control: {} }] }],
      },
      "m",
    )
    expect(snap).toEqual({ markers: 3, approxPrefixChars: 6, model: "m", ttlSeconds: 3600 })
  })

  it("a marker without ttl is the 5 minute default; no marker gives no TTL", () => {
    expect(
      snapshotRequest({ system: [{ cache_control: { type: "ephemeral" } }] }, "m").ttlSeconds,
    ).toBe(300)
    expect(snapshotRequest({ system: [] }, "m").ttlSeconds).toBeUndefined()
  })
})

describe("extractCacheFacts", () => {
  it("reads message_start and message_delta usage from SSE, the last value wins", () => {
    const sse = [
      "event: message_start",
      'data: {"type":"message_start","message":{"usage":{"cache_read_input_tokens":0,"cache_creation_input_tokens":7}}}',
      "",
      "event: message_delta",
      'data: {"type":"message_delta","usage":{"cache_read_input_tokens":3}}',
      "",
    ].join("\n")
    expect(extractCacheFacts(sse)).toEqual({ read: 3, write: 7 })
  })

  it("reads the server's miss reason from message_start (the logged shape)", () => {
    // From research/2026-11-18-session-932e6ae3-cache-anomalies/evidence.
    const sse = [
      "event: message_start",
      'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":2,"cache_creation_input_tokens":166690,"cache_read_input_tokens":0,"output_tokens":4},"input_transformations":[],"diagnostics":{"cache_miss_reason":{"type":"messages_changed","cache_missed_input_tokens":155827}}}}',
      "",
    ].join("\n")
    expect(extractCacheFacts(sse)).toEqual({
      read: 0,
      write: 166690,
      cacheMiss: { reason: "messages_changed", missedTokens: 155827 },
    })
  })

  it("a null or empty diagnostics gives no miss reason", () => {
    const sse =
      'data: {"type":"message_start","message":{"usage":{"cache_read_input_tokens":5},"diagnostics":null}}\n'
    expect(extractCacheFacts(sse)).toEqual({ read: 5 })
    const prev =
      'data: {"type":"message_start","message":{"usage":{"cache_read_input_tokens":5},"diagnostics":{"previous_message_id":null}}}\n'
    expect(extractCacheFacts(prev)).toEqual({ read: 5 })
  })

  it("reads a JSON body, and gives undefined without usage", () => {
    expect(
      extractCacheFacts(
        '{"usage":{"cache_read_input_tokens":4},"diagnostics":{"cache_miss_reason":{"type":"model_changed"}}}',
      ),
    ).toEqual({ read: 4, cacheMiss: { reason: "model_changed" } })
    expect(extractCacheFacts("data: {}\n")).toBeUndefined()
  })
})

describe("createWireWatch", () => {
  it("a marked request with a 0-read response reaches the detector, plain or gzip", () => {
    for (const gzip of [false, true]) {
      const sink = recorder()
      const d = new CacheAnomalyDetector({ sink })
      drive(
        createWireWatch(() => d),
        { id: "r1", body: MARKED, sse: COLD_SSE, gzip },
      )
      expect(sink.warnings.map((w) => w.sd?.code)).toEqual(["markers_ignored_cold"])
    }
  })

  it("passes the server reason, the TTL and the times to the detector", () => {
    const sink = recorder()
    const d = new CacheAnomalyDetector({ sink })
    let t = 0
    const w = createWireWatch(
      () => d,
      () => 0,
      () => t,
    )
    const marked1h = {
      ...MARKED,
      system: [
        { type: "text", text: "x".repeat(20_000), cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
    }
    const missSse =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"cache_read_input_tokens":0,"cache_creation_input_tokens":9000},"diagnostics":{"cache_miss_reason":{"type":"messages_changed","cache_missed_input_tokens":8000}}}}\n\n'
    // Turn 1 writes. Turn 2 starts 600 s later: past 5m, inside the 1h TTL.
    drive(w, { id: "1", body: marked1h, sse: usageSse(0, 5000) })
    t = 600_000
    // The system text changed, so the miss is on the client side.
    const changed = { ...marked1h, system: [{ ...marked1h.system[0], text: "y".repeat(20_000) }] }
    drive(w, { id: "2", body: changed, sse: missSse })
    expect(sink.infos).toEqual([])
    expect(sink.warnings.map((x) => x.sd)).toEqual([
      {
        code: "prefix_changed",
        turn: 2,
        streak: 1,
        written: 9000,
        reason: "messages_changed",
        missedTokens: 8000,
        changed: "system",
      },
    ])
    expect(sink.warnings[0]?.message).toContain(
      "600.0 s after turn 1 ended (inside the 3600 s TTL)",
    )
  })

  it("a 5m marker and a 485 s gap is ttl_expired at info level", () => {
    const sink = recorder()
    const d = new CacheAnomalyDetector({ sink })
    let t = 0
    const w = createWireWatch(
      () => d,
      () => 0,
      () => t,
    )
    drive(w, { id: "1", body: MARKED, sse: usageSse(0, 22113) })
    t = 485_000
    drive(w, { id: "2", body: MARKED, sse: usageSse(0, 24585) })
    expect(sink.warnings).toEqual([])
    expect(sink.infos.map((x) => x.sd?.code)).toEqual(["ttl_expired"])
  })

  it("ignores requests without markers, and non-2xx responses", () => {
    const sink = recorder()
    const d = new CacheAnomalyDetector({ sink })
    const w = createWireWatch(() => d)
    drive(w, { id: "a", body: { model: "m", messages: [] }, sse: COLD_SSE })
    drive(w, { id: "b", body: MARKED, sse: COLD_SSE, status: 529 })
    expect(sink.warnings).toEqual([])
  })
})

describe("start", () => {
  it("does nothing without the network:observe capability", () => {
    expect(start({ log: recorder() })).toBeUndefined()
    expect(start({ log: recorder(), host: {} })).toBeUndefined()
  })

  it("keeps one detector per session and attaches one time per network API", () => {
    let observer: WireObserver | undefined
    let stops = 0
    const network = {
      observe(o: WireObserver) {
        observer = o
        return () => {
          stops++
        }
      },
    }
    const sink = recorder()
    const stop = start({ log: sink, host: { network } })
    expect(stop).toBeDefined()
    expect(start({ log: sink, host: { network } })).toBeUndefined()
    if (!observer) throw new Error("no observer")
    drive(observer, { id: "1", body: MARKED, sse: COLD_SSE, session: "s1" })
    drive(observer, { id: "2", body: MARKED, sse: COLD_SSE, session: "s2" })
    // Two sessions: each writes its own first warning.
    expect(sink.warnings).toHaveLength(2)
    stop?.()
    expect(stops).toBe(1)
  })

  it("the same body with a read of 0 is info server_miss through ctx.log.info", () => {
    let observer: WireObserver | undefined
    const sink = recorder()
    const stop = start({
      log: sink,
      host: { network: { observe: (o: WireObserver) => ((observer = o), () => {}) } },
    })
    if (!observer || !stop) throw new Error("no observer")
    drive(observer, { id: "1", body: MARKED, sse: usageSse(5000, 100), session: "s1" })
    drive(observer, {
      id: "2",
      body: MARKED,
      sse: usageSse(0, 5100),
      session: "s1",
      resHeaders: { "request-id": "req_L3" },
    })
    expect(sink.warnings).toEqual([])
    expect(sink.infos.map((x) => [x.source, x.sd?.code, x.sd?.requestId])).toEqual([
      [ANOMALY_SOURCE, "server_miss", "req_L3"],
    ])
    stop()
  })

  it("does not use a redacted session header as a key", () => {
    const base = { id: "x", method: "POST", url: "https://a.test/v1/messages", body: "" }
    expect(sessionKeyOf({ ...base, headers: { "x-session-id": "[REDACTED]" } })).toBe("")
    expect(sessionKeyOf({ ...base, headers: { "x-claude-code-session-id": "abc" } })).toBe("abc")
  })
})

/** A started plugin with a fake network API, and a function to send one turn. */
function startedPlugin() {
  let observer: WireObserver | undefined
  const sink = recorder()
  const stopWatch = start({
    log: sink,
    host: { network: { observe: (o: WireObserver) => ((observer = o), () => {}) } },
  })
  if (!observer || !stopWatch) throw new Error("no observer")
  const w = observer
  let n = 0
  // The system text changes on each turn, so a read of 0 inside the TTL is
  // a client-side miss (prefix_changed), not a server_miss.
  const turn = (model: string, read: number, create: number, url?: string) =>
    drive(w, {
      id: `t${++n}`,
      body: {
        ...MARKED,
        model,
        system: [{ ...MARKED.system[0], text: `${n} ${"x".repeat(20_000)}` }],
      },
      sse: usageSse(read, create),
      session: "s1",
      ...(url ? { url } : {}),
    })
  return { sink, turn, stop: stopWatch }
}

describe("target switch in one session", () => {
  it("a model switch does not warn for a healthy first turn on the new model", () => {
    const { sink, turn } = startedPlugin()
    // Model A: the cache reads on each turn (healthy).
    turn("model-a", 5000, 100)
    turn("model-a", 5100, 100)
    // Switch to model B: a cold cache. The first turn writes, the second reads.
    turn("model-b", 0, 5200)
    turn("model-b", 5200, 50)
    expect(sink.warnings).toEqual([])
  })

  it("a switch right after a cache write does not give prefix_changed", () => {
    const { sink, turn } = startedPlugin()
    turn("model-a", 0, 5000)
    turn("model-b", 0, 5000)
    expect(sink.warnings).toEqual([])
  })

  it("a provider switch with the same model id starts a new history", () => {
    const { sink, turn } = startedPlugin()
    turn("same-model", 5000, 0, "https://one.test/v1/messages")
    turn("same-model", 5000, 0, "https://one.test/v1/messages")
    turn("same-model", 0, 5000, "https://two.test/v1/messages")
    expect(sink.warnings).toEqual([])
  })

  it("still warns on the same model when the cache falls to 0", () => {
    const { sink, turn } = startedPlugin()
    turn("model-a", 5000, 0)
    turn("model-a", 5000, 0)
    turn("model-a", 0, 5000)
    expect(sink.warnings.map((w) => w.sd?.code)).toEqual(["prefix_changed"])
  })

  it("going back to an earlier model keeps that model's history", () => {
    const { sink, turn } = startedPlugin()
    turn("model-a", 0, 5000)
    turn("model-b", 0, 5000)
    // Back on A: A wrote on its last turn and reads 0 now, a real miss.
    turn("model-a", 0, 5000)
    expect(sink.warnings.map((w) => w.sd?.code)).toEqual(["prefix_changed"])
  })

  it("keys on session, model and origin, and keeps at most MAX_DETECTORS", () => {
    const req = {
      id: "x",
      method: "POST",
      url: "https://a.test/v1/messages?x=1",
      headers: { "x-session-id": "s" },
      body: "",
    }
    const snap = { markers: 1, approxPrefixChars: 1, model: "m" }
    expect(detectorKeyOf(req, snap)).toBe("s\u0000m\u0000https://a.test")
    expect(detectorKeyOf({ ...req, url: "not a url" }, snap)).toBe("s\u0000m\u0000")
    // Over the cap, the oldest model's history goes: model 0 writes, then
    // MAX_DETECTORS other models push it out, so its next 0-read turn is a
    // fresh start (no warning), not a prefix_changed.
    const { sink, turn } = startedPlugin()
    turn("m0", 0, 5000)
    for (let i = 1; i <= MAX_DETECTORS; i++) turn(`m${i}`, 0, 5000)
    turn("m0", 0, 5000)
    expect(sink.warnings).toEqual([])
  })
})

describe("target.didSwitch reset", () => {
  it("a credential switch on the same model and endpoint does not warn", () => {
    const { sink, turn, stop } = startedPlugin()
    turn("model-a", 5000, 0)
    turn("model-a", 5000, 0)
    // The quota wait ends with a switch to another credential: same provider,
    // same model, same endpoint. The host sends target.didSwitch.
    onTargetSwitch({ event: "target.didSwitch", payload: {} })
    turn("model-a", 0, 5000)
    turn("model-a", 5000, 0)
    expect(sink.warnings).toEqual([])
    stop()
  })

  it("without the event the same turns warn (the case the event fixes)", () => {
    const { sink, turn, stop } = startedPlugin()
    turn("model-a", 5000, 0)
    turn("model-a", 5000, 0)
    turn("model-a", 0, 5000)
    expect(sink.warnings.map((w) => w.sd?.code)).toEqual(["prefix_changed"])
    stop()
  })

  it("after a reset, a real miss on the new target still warns", () => {
    const { sink, turn, stop } = startedPlugin()
    turn("model-a", 5000, 0)
    resetAllDetectors()
    turn("model-a", 0, 5000)
    turn("model-a", 0, 5000)
    expect(sink.warnings.map((w) => w.sd?.code)).toEqual(["prefix_changed"])
    stop()
  })

  it("a stopped watcher is not reset any more", () => {
    const { stop } = startedPlugin()
    const before = resetAllDetectors()
    stop()
    expect(resetAllDetectors()).toBe(before - 1)
  })
})

describe("reset while a response is in flight", () => {
  /** Start a request, then stream its usage only when `finish` is called. */
  function inFlight(w: WireObserver, id: string, read: number, create: number) {
    const req: WireRequest = {
      id,
      method: "POST",
      url: "https://api.example.test/v1/messages",
      headers: { "x-claude-code-session-id": "s1" },
      body: JSON.stringify({ ...MARKED, model: "model-a" }),
    }
    w.onRequest?.(req)
    w.onResponse?.(req, { status: 200, headers: {} })
    return () => {
      w.onChunk?.(req, new TextEncoder().encode(usageSse(read, create)))
      w.onEnd?.(req)
    }
  }

  it("a response of the old target that ends after the reset is not counted", () => {
    let observer: WireObserver | undefined
    const sink = recorder()
    const stop = start({
      log: sink,
      host: { network: { observe: (o: WireObserver) => ((observer = o), () => {}) } },
    })
    if (!observer || !stop) throw new Error("no observer")
    const w = observer
    // Old credential: a warm cache that also writes a little.
    inFlight(w, "a1", 5000, 100)()
    // Request 2 of the old credential starts, then the switch comes mid-stream.
    const finishOld = inFlight(w, "a2", 5000, 100)
    onTargetSwitch({ event: "target.didSwitch", payload: {} })
    finishOld()
    // First turn on the new credential: a cold cache (0 read, a write). Correct.
    inFlight(w, "b1", 0, 5000)()
    expect(sink.warnings).toEqual([])
    stop()
  })
})
