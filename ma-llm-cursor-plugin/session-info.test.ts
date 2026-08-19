/**
 * Cursor quota-window mapping + cache refresh.
 */

import { afterEach, describe, expect, test } from "bun:test"

import { authUsageUrl, currentPeriodUsageUrl } from "./connect/hosts.ts"
import type { NetworkClient } from "./lib/net-types.ts"
import {
  _resetCursorPrimeInFlight,
  clearCursorQuotaCache,
  fetchCursorSessionInfo,
  getCursorQuotaCache,
  parseCursorAuthUsage,
  parseCursorPeriodUsage,
  refreshCursorPeriodUsage,
} from "./session-info.ts"

const LIVE_SHAPED = {
  billingCycleEnd: "1789344277000",
  planUsage: {
    includedSpend: 2000,
    limit: 2000,
    totalPercentUsed: 27.5,
  },
  spendLimitUsage: {
    individualLimit: 100,
    individualRemaining: 100,
    limitType: "user",
  },
  displayMessage: "You've used 95% of your included usage",
}

afterEach(() => {
  clearCursorQuotaCache()
  _resetCursorPrimeInFlight()
})

describe("parseCursorPeriodUsage", () => {
  test("maps included spend to month and on-demand cap to ondemand", () => {
    const snapshot = parseCursorPeriodUsage(LIVE_SHAPED)
    expect(snapshot.windows.map((w) => w.id)).toEqual(["month", "ondemand"])
    expect(snapshot.windows[0]?.utilization).toBe(1)
    expect(snapshot.windows[0]?.resetAtMs).toBe(1_789_344_277_000)
    expect(snapshot.windows[1]?.utilization).toBe(0)
    expect(snapshot.overage).toEqual({ active: true })
  })

  test("does not parse displayMessage or totalPercentUsed", () => {
    const snapshot = parseCursorPeriodUsage({
      planUsage: { includedSpend: 500, limit: 2000, totalPercentUsed: 99 },
      displayMessage: "You've used 99% of your included usage",
    } as typeof LIVE_SHAPED)
    expect(snapshot.windows).toHaveLength(1)
    expect(snapshot.windows[0]?.utilization).toBeCloseTo(0.25, 6)
  })

  test("omits month when included limit is zero", () => {
    const snapshot = parseCursorPeriodUsage({
      planUsage: { includedSpend: 0, limit: 0 },
    })
    expect(snapshot.windows).toEqual([])
    expect(snapshot.overage).toBeUndefined()
  })

  test("derives included spend from remaining when includedSpend is absent", () => {
    const snapshot = parseCursorPeriodUsage({
      planUsage: { limit: 400, remaining: 100 },
    })
    expect(snapshot.windows[0]?.utilization).toBeCloseTo(0.75, 6)
  })

  test("omits ondemand when individualLimit is missing", () => {
    const snapshot = parseCursorPeriodUsage({
      planUsage: { includedSpend: 10, limit: 100 },
    })
    expect(snapshot.windows.map((w) => w.id)).toEqual(["month"])
    expect(snapshot.overage).toBeUndefined()
  })
})

describe("parseCursorAuthUsage", () => {
  test("maps gpt-4 request bucket to req when maxRequestUsage is set", () => {
    const snapshot = parseCursorAuthUsage({
      "gpt-4": { numRequests: 25, maxRequestUsage: 100 },
      startOfMonth: "2026-08-14T00:04:37.000Z",
    })
    expect(snapshot.windows).toHaveLength(1)
    expect(snapshot.windows[0]?.id).toBe("req")
    expect(snapshot.windows[0]?.utilization).toBeCloseTo(0.25, 6)
    expect(snapshot.windows[0]?.resetAtMs).toBeGreaterThan(Date.parse("2026-08-14T00:04:37.000Z"))
  })

  test("skips null maxRequestUsage (Pro / cents plans)", () => {
    const snapshot = parseCursorAuthUsage({
      "gpt-4": { numRequests: 0, maxRequestUsage: null },
      startOfMonth: "2026-08-14T00:04:37.000Z",
    })
    expect(snapshot.windows).toEqual([])
  })
})

describe("fetchCursorSessionInfo", () => {
  test("is cache-only and returns quota after a refresh", async () => {
    const calls: string[] = []
    const networkClient = {
      async request(input: { url: string }) {
        calls.push(input.url)
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          body: new ReadableStream(),
          transport: { id: "test" },
          text: async () => JSON.stringify(LIVE_SHAPED),
          json: async () => LIVE_SHAPED,
        }
      },
    } as unknown as NetworkClient

    expect(await fetchCursorSessionInfo({ modelId: "cursor-auto" })).toEqual({})
    await refreshCursorPeriodUsage("tok", { networkClient })
    expect(calls).toEqual([currentPeriodUsageUrl()])
    const info = await fetchCursorSessionInfo({ modelId: "cursor-auto" })
    expect(info?.quota?.windows?.map((w) => w.id)).toEqual(["month", "ondemand"])
    expect(getCursorQuotaCache()?.snapshot.overage).toEqual({ active: true })
  })

  test("falls back to GET /auth/usage when planUsage.limit is missing", async () => {
    const calls: string[] = []
    const networkClient = {
      async request(input: { url: string }) {
        calls.push(input.url)
        if (input.url === currentPeriodUsageUrl()) {
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            body: new ReadableStream(),
            transport: { id: "test" },
            text: async () => JSON.stringify({ planUsage: {} }),
            json: async () => ({ planUsage: {} }),
          }
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          body: new ReadableStream(),
          transport: { id: "test" },
          text: async () =>
            JSON.stringify({
              "gpt-4": { numRequests: 10, maxRequestUsage: 50 },
            }),
          json: async () => ({ "gpt-4": { numRequests: 10, maxRequestUsage: 50 } }),
        }
      },
    } as unknown as NetworkClient

    await refreshCursorPeriodUsage("tok", { networkClient })
    expect(calls).toEqual([currentPeriodUsageUrl(), authUsageUrl()])
    const info = await fetchCursorSessionInfo({ modelId: "cursor-auto" })
    expect(info?.quota?.windows).toEqual([{ id: "req", utilization: 0.2 }])
  })
})
