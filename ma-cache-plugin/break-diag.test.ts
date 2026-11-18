import { describe, expect, it } from "bun:test"

import type { CacheBreakPayload } from "@minimal-agent/core/plugin-api"

import { drive, MARKED, recorder, usageSse } from "./__fixtures__/cache-test-kit.ts"
import type { CacheDiagData } from "./detector.ts"
import { BREAK_SOURCE, breakDiagData, start } from "./start.ts"
import type { WireObserver } from "./wire-watch.ts"

describe("start writes one cache.break notice diagnostic per break", () => {
  it("a break writes exactly one notice with the payload message and scalar fields", () => {
    let observer: WireObserver | undefined
    const emitted: CacheBreakPayload[] = []
    const notices: { source: string; message: string; sd?: CacheDiagData }[] = []
    const stop = start({
      log: {
        ...recorder(),
        notice: (source, message, sd) => notices.push({ source, message, ...(sd ? { sd } : {}) }),
      },
      emit: (_channel, payload) => emitted.push(payload as CacheBreakPayload),
      host: { network: { observe: (o: WireObserver) => ((observer = o), () => {}) } },
    })
    if (!observer || !stop) throw new Error("no observer")
    drive(observer, { id: "1", body: MARKED, sse: usageSse(5000, 100), session: "s" })
    drive(observer, {
      id: "2",
      body: MARKED,
      sse: usageSse(0, 5100),
      session: "s",
      resHeaders: { "request-id": "req_2" },
    })
    expect(emitted).toHaveLength(1)
    expect(notices).toHaveLength(1)
    const p = emitted[0] as CacheBreakPayload
    expect(notices[0]?.source).toBe(BREAK_SOURCE)
    expect(notices[0]?.message).toBe(p.message)
    const sd = notices[0]?.sd ?? {}
    expect(sd).toEqual(breakDiagData(p))
    expect(sd).toMatchObject({
      cause: "server_miss",
      turn: p.turn,
      prevTurn: p.prevTurn,
      read: 0,
      written: 5100,
      lost: 5100,
      expectedRead: 5100,
      ttlSec: p.ttlSec,
      idle: false,
      requestId: "req_2",
      streak: 1,
      streakLost: 5100,
      actionable: true,
    })
    // Only scalar fields; no message, session, model, origin, version or time.
    for (const k of ["message", "sessionId", "model", "origin", "v", "at"]) {
      expect(k in sd).toBe(false)
    }
    for (const v of Object.values(sd)) expect(["string", "number", "boolean"]).toContain(typeof v)
    // A turn that reads its prefix writes no more break notice.
    drive(observer, { id: "3", body: MARKED, sse: usageSse(5100, 0), session: "s" })
    expect(notices).toHaveLength(1)
    stop()
  })

  it("breakDiagData keeps the optional fields that are set and drops the absent ones", () => {
    const p: CacheBreakPayload = {
      v: 1,
      sessionId: "s",
      model: "m",
      origin: "o",
      turn: 5,
      prevTurn: 4,
      expectedRead: 100,
      read: 0,
      written: 100,
      lost: 100,
      gapSec: 3800,
      ttlSec: 300,
      idle: true,
      cause: "prefix_changed",
      changed: "message",
      changedIndex: 2,
      serverReason: "r",
      serverMissedTokens: 7,
      streak: 2,
      streakLost: 150,
      actionable: true,
      message: "m",
      at: 1,
    }
    expect(breakDiagData(p)).toEqual({
      cause: "prefix_changed",
      turn: 5,
      prevTurn: 4,
      read: 0,
      written: 100,
      lost: 100,
      expectedRead: 100,
      gapSec: 3800,
      ttlSec: 300,
      idle: true,
      changed: "message",
      changedIndex: 2,
      serverReason: "r",
      serverMissedTokens: 7,
      streak: 2,
      streakLost: 150,
      actionable: true,
    })
  })
})
