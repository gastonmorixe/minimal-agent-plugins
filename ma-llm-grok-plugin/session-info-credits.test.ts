/**
 * Weekly unified-billing credits (`/v1/billing?format=credits`) tests.
 *
 * Payload shape captured live 2026-08-21 from cli-chat-proxy with an OAuth
 * session token: `config.creditUsagePercent` (0-100),
 * `config.currentPeriod.type=USAGE_PERIOD_TYPE_WEEKLY`, `productUsage[]`.
 *
 * @module llm/providers/grok/session-info-credits.test
 */

import { describe, expect, it } from "bun:test"

import type { NetworkClient } from "./lib/net-types.ts"
import {
  clearGrokSessionCaches,
  getGrokWeeklyCredits,
  parseGrokQuotaWindows,
  refreshGrokWeeklyCredits,
} from "./session-info.ts"
import { CLI_BILLING_CREDITS_URL } from "./wire-constants.ts"

const LIVE_CREDITS_BODY = JSON.stringify({
  config: {
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2026-08-20T22:30:08.351328+00:00",
      end: "2026-08-27T22:30:08.351328+00:00",
    },
    creditUsagePercent: 20.0,
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    productUsage: [{ product: "GrokBuild", usagePercent: 20.0 }],
    isUnifiedBillingUser: true,
    prepaidBalance: { val: 0 },
    topUpMethod: "TOP_UP_METHOD_SAVED_PAYMENT_METHOD",
    billingPeriodStart: "2026-08-20T22:30:08.351328+00:00",
    billingPeriodEnd: "2026-08-27T22:30:08.351328+00:00",
  },
})

function clientReturning(body: string): NetworkClient {
  return {
    async request() {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        body: new ReadableStream(),
        transport: { id: "test" },
        text: async () => body,
        json: async () => JSON.parse(body),
      }
    },
  } as unknown as NetworkClient
}

describe("llm-grok weekly credits billing", () => {
  it("refreshGrokWeeklyCredits parses ?format=credits and caches week window", async () => {
    clearGrokSessionCaches()
    const calls: Array<{ url: string; headers?: Record<string, string> }> = []
    const networkClient = {
      async request(input: { url: string; headers?: Record<string, string> }) {
        calls.push({ url: input.url, headers: input.headers })
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          body: new ReadableStream(),
          transport: { id: "test" },
          text: async () => LIVE_CREDITS_BODY,
          json: async () => JSON.parse(LIVE_CREDITS_BODY),
        }
      },
    } as unknown as NetworkClient

    await refreshGrokWeeklyCredits(networkClient, "oauth-token-xyz")
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(CLI_BILLING_CREDITS_URL)
    expect(calls[0]!.headers?.authorization).toBe("Bearer oauth-token-xyz")
    expect(calls[0]!.headers?.["x-xai-token-auth"]).toBe("xai-grok-cli")

    const cached = getGrokWeeklyCredits()
    expect(cached?.usagePercent).toBe(20.0)
    expect(cached?.periodEndMs).toBe(Date.parse("2026-08-27T22:30:08.351328+00:00"))

    const windows = parseGrokQuotaWindows(new Map())
    expect(windows.map((w) => w.id)).toEqual(["week"])
    expect(windows[0]!.utilization).toBeCloseTo(0.2, 6)
  })

  it("clamps usagePercent above 100", async () => {
    clearGrokSessionCaches()
    const over = JSON.stringify({
      config: { creditUsagePercent: 137.5, currentPeriod: { end: "2026-08-27T22:30:08Z" } },
    })
    await refreshGrokWeeklyCredits(clientReturning(over), "tok")
    expect(getGrokWeeklyCredits()?.usagePercent).toBe(100)

    const windows = parseGrokQuotaWindows(new Map())
    expect(windows[0]!.utilization).toBe(1)
  })

  it("ignores payloads without creditUsagePercent", async () => {
    clearGrokSessionCaches()
    await refreshGrokWeeklyCredits(clientReturning('{"config":{}}'), "tok")
    expect(getGrokWeeklyCredits()).toBeNull()

    // month-only billing body must not produce a week window
    await refreshGrokWeeklyCredits(
      clientReturning(JSON.stringify({ config: { monthlyLimit: { val: 5 }, used: { val: 1 } } })),
      "tok",
    )
    expect(getGrokWeeklyCredits()).toBeNull()
    expect(parseGrokQuotaWindows(new Map())).toEqual([])
  })
})
