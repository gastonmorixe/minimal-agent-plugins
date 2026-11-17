import { gzipSync } from "node:zlib"

import { describe, expect, it } from "bun:test"

import {
  ANOMALY_SOURCE,
  CacheAnomalyDetector,
  type CacheWarnSink,
  snapshotRequest,
} from "./detector.ts"
import { detectorKeyOf, MAX_DETECTORS, sessionKeyOf, start } from "./start.ts"
import { createWireWatch, extractUsage, type WireObserver, type WireRequest } from "./wire-watch.ts"

interface Warning {
  source: string
  message: string
  sd?: Readonly<Record<string, string | number | boolean>>
}

function recorder(): CacheWarnSink & { warnings: Warning[] } {
  const warnings: Warning[] = []
  return {
    warnings,
    warn(source, message, sd) {
      warnings.push({ source, message, ...(sd ? { sd } : {}) })
    },
  }
}

const BIG = { breakpoints: 2, approxPrefixChars: 20_000, model: "m" }

describe("CacheAnomalyDetector", () => {
  it("a turn with cache markers and 0 cache reads gives exactly one warning", () => {
    const sink = recorder()
    const d = new CacheAnomalyDetector({ sink })
    expect(d.observe({ cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, BIG)).toEqual([
      "markers_ignored_cold",
    ])
    expect(sink.warnings).toHaveLength(1)
    expect(sink.warnings[0]?.source).toBe(ANOMALY_SOURCE)
    expect(sink.warnings[0]?.sd).toEqual({ code: "markers_ignored_cold" })
  })

  it("writes each code one time only", () => {
    const sink = recorder()
    const d = new CacheAnomalyDetector({ sink })
    d.observe({}, BIG)
    d.observe({}, BIG)
    expect(sink.warnings).toHaveLength(1)
  })

  it("a healthy cache gives no warning", () => {
    const sink = recorder()
    const d = new CacheAnomalyDetector({ sink })
    d.observe({ cache_creation_input_tokens: 5000 }, BIG)
    d.observe({ cache_read_input_tokens: 5000 }, BIG)
    d.observe({ cache_read_input_tokens: 5200, cache_creation_input_tokens: 100 }, BIG)
    expect(sink.warnings).toEqual([])
  })

  it("a request without markers gives no warning", () => {
    const sink = recorder()
    const d = new CacheAnomalyDetector({ sink })
    d.observe({}, { ...BIG, breakpoints: 0 })
    expect(sink.warnings).toEqual([])
  })

  it("uses the injected per-model minimum for below_min_block_size", () => {
    const sink = recorder()
    const d = new CacheAnomalyDetector({ sink, minPrefixTokens: () => 10_000 })
    expect(d.observe({}, BIG)).toEqual(["below_min_block_size"])
    expect(sink.warnings[0]?.message).toContain("10000-token cache minimum")
  })

  it("finds no_read_after_write and cache_evicted", () => {
    const sink = recorder()
    const d = new CacheAnomalyDetector({ sink })
    d.observe({ cache_creation_input_tokens: 5000 }, BIG)
    expect(d.observe({ cache_creation_input_tokens: 5000 }, BIG)).toEqual(["no_read_after_write"])
    const e = new CacheAnomalyDetector({ sink: recorder() })
    e.observe({ cache_read_input_tokens: 1 }, BIG)
    e.observe({ cache_read_input_tokens: 2 }, BIG)
    expect(e.observe({ cache_creation_input_tokens: 9 }, BIG)).toContain("cache_evicted")
  })
})

describe("snapshotRequest", () => {
  it("counts markers in system, tools and nested blocks", () => {
    const snap = snapshotRequest(
      {
        system: [{ type: "text", text: "abcd", cache_control: { type: "ephemeral" } }],
        tools: [{ name: "t", cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: [{ type: "text", text: "xy", cache_control: {} }] }],
      },
      "m",
    )
    expect(snap).toEqual({ breakpoints: 3, approxPrefixChars: 6, model: "m" })
  })
})

describe("extractUsage", () => {
  it("reads message_start and message_delta usage from SSE, the last value wins", () => {
    const sse = [
      "event: message_start",
      'data: {"type":"message_start","message":{"usage":{"cache_read_input_tokens":0,"cache_creation_input_tokens":7}}}',
      "",
      "event: message_delta",
      'data: {"type":"message_delta","usage":{"cache_read_input_tokens":3}}',
      "",
    ].join("\n")
    expect(extractUsage(sse)).toEqual({
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 7,
    })
  })

  it("reads a JSON body, and gives undefined without usage", () => {
    expect(extractUsage('{"usage":{"cache_read_input_tokens":4}}')).toEqual({
      cache_read_input_tokens: 4,
    })
    expect(extractUsage("data: {}\n")).toBeUndefined()
  })
})

/** One Messages request through a watcher. */
function drive(
  w: WireObserver,
  opts: {
    id: string
    body: unknown
    status?: number
    sse: string
    gzip?: boolean
    session?: string
    url?: string
  },
): void {
  const req: WireRequest = {
    id: opts.id,
    url: opts.url ?? "https://api.example.test/v1/messages",
    method: "POST",
    headers: opts.session ? { "x-claude-code-session-id": opts.session } : {},
    body: JSON.stringify(opts.body),
  }
  w.onRequest?.(req)
  w.onResponse?.(req, { status: opts.status ?? 200, headers: {} })
  const bytes = new TextEncoder().encode(opts.sse)
  const payload = opts.gzip ? gzipSync(bytes) : bytes
  // Two chunks, so a split usage line is joined again.
  const mid = Math.floor(payload.byteLength / 2)
  w.onChunk?.(req, payload.slice(0, mid))
  w.onChunk?.(req, payload.slice(mid))
  w.onEnd?.(req)
}

const MARKED = {
  model: "m",
  system: [{ type: "text", text: "x".repeat(20_000), cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: "hi" }],
}
const COLD_SSE =
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n\n'

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

  it("does not use a redacted session header as a key", () => {
    const base = { id: "x", method: "POST", url: "https://a.test/v1/messages", body: "" }
    expect(sessionKeyOf({ ...base, headers: { "x-session-id": "[REDACTED]" } })).toBe("")
    expect(sessionKeyOf({ ...base, headers: { "x-claude-code-session-id": "abc" } })).toBe("abc")
  })
})

/** One SSE response with these cache counts. */
function usageSse(read: number, create: number): string {
  return `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":${read},"cache_creation_input_tokens":${create}}}}\n\n`
}

/** A started plugin with a fake network API, and a function to send one turn. */
function startedPlugin() {
  let observer: WireObserver | undefined
  const sink = recorder()
  start({
    log: sink,
    host: { network: { observe: (o: WireObserver) => ((observer = o), () => {}) } },
  })
  if (!observer) throw new Error("no observer")
  const w = observer
  let n = 0
  const turn = (model: string, read: number, create: number, url?: string) =>
    drive(w, {
      id: `t${++n}`,
      body: { ...MARKED, model },
      sse: usageSse(read, create),
      session: "s1",
      ...(url ? { url } : {}),
    })
  return { sink, turn }
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

  it("a switch right after a cache write does not give no_read_after_write", () => {
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
    expect(sink.warnings.map((w) => w.sd?.code)).toEqual(["cache_evicted"])
  })

  it("going back to an earlier model keeps that model's history", () => {
    const { sink, turn } = startedPlugin()
    turn("model-a", 0, 5000)
    turn("model-b", 0, 5000)
    // Back on A: A wrote on its last turn and reads 0 now, a real miss.
    turn("model-a", 0, 5000)
    expect(sink.warnings.map((w) => w.sd?.code)).toEqual(["no_read_after_write"])
  })

  it("keys on session, model and origin, and keeps at most MAX_DETECTORS", () => {
    const req = {
      id: "x",
      method: "POST",
      url: "https://a.test/v1/messages?x=1",
      headers: { "x-session-id": "s" },
      body: "",
    }
    const snap = { breakpoints: 1, approxPrefixChars: 1, model: "m" }
    expect(detectorKeyOf(req, snap)).toBe("s\u0000m\u0000https://a.test")
    expect(detectorKeyOf({ ...req, url: "not a url" }, snap)).toBe("s\u0000m\u0000")
    // Over the cap, the oldest model's history goes: model 0 writes, then
    // MAX_DETECTORS other models push it out, so its next 0-read turn is a
    // fresh start (no warning), not a no_read_after_write.
    const { sink, turn } = startedPlugin()
    turn("m0", 0, 5000)
    for (let i = 1; i <= MAX_DETECTORS; i++) turn(`m${i}`, 0, 5000)
    turn("m0", 0, 5000)
    expect(sink.warnings).toEqual([])
  })
})
