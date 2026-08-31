import { describe, expect, it } from "bun:test"

import {
  accountInfoFromBag,
  decodeGetMeResponse,
  fetchCursorAccountEnrichment,
  hasAccountMetadata,
  parseCursorPeriodUsageInfo,
  withAccountMetadata,
} from "./account.ts"

/** Encode a minimal GetMeResponse protobuf payload. */
function encodeGetMe(fields: Array<{ no: number; str?: string; int?: number; bool?: boolean }>) {
  const out: number[] = []
  const varint = (value: number) => {
    let v = value
    for (;;) {
      const b = v & 0x7f
      v >>>= 7
      out.push(v === 0 ? b : b | 0x80)
      if (v === 0) break
    }
  }
  for (const f of fields) {
    if (f.str !== undefined) {
      const bytes = Array.from(new TextEncoder().encode(f.str))
      varint((f.no << 3) | 2)
      varint(bytes.length)
      out.push(...bytes)
    } else if (f.int !== undefined) {
      varint((f.no << 3) | 0)
      varint(f.int)
    } else if (f.bool !== undefined) {
      varint((f.no << 3) | 0)
      varint(f.bool ? 1 : 0)
    }
  }
  return new Uint8Array(out)
}

describe("decodeGetMeResponse", () => {
  it("decodes all known fields", () => {
    const buf = encodeGetMe([
      { no: 1, str: "auth0|user_abc" },
      { no: 2, int: 383037133 },
      { no: 3, str: "gmorixe@asu.edu" },
      { no: 4, str: "Javier" },
      { no: 5, str: "Juan" },
      { no: 6, str: "user_01KX" },
      { no: 7, int: 42 },
      { no: 8, str: "2026-07-09T19:46:10.273Z" },
      { no: 9, bool: false },
      { no: 10, str: "Team" },
      { no: 11, str: "education" },
      { no: 12, str: "US" },
    ])
    expect(decodeGetMeResponse(buf)).toEqual({
      authId: "auth0|user_abc",
      userId: 383037133,
      email: "gmorixe@asu.edu",
      firstName: "Javier",
      lastName: "Juan",
      workosId: "user_01KX",
      teamId: 42,
      createdAt: "2026-07-09T19:46:10.273Z",
      isEnterpriseUser: false,
      teamName: "Team",
      emailDomainType: "education",
      country: "US",
    })
  })

  it("tolerates unknown fields and empty payloads", () => {
    expect(decodeGetMeResponse(new Uint8Array(0))).toEqual({})
    // Unknown field 99 (len-delim) must not throw.
    const buf = encodeGetMe([
      { no: 99, str: "future" },
      { no: 2, int: 7 },
    ])
    expect(decodeGetMeResponse(buf)).toEqual({ userId: 7 })
  })
})

describe("parseCursorPeriodUsageInfo", () => {
  it("flattens plan + spend-limit windows (cents)", () => {
    expect(
      parseCursorPeriodUsageInfo({
        billingCycleStart: "1785358531000",
        billingCycleEnd: "1788036931000",
        planUsage: {
          totalSpend: 91_788,
          includedSpend: 7000,
          bonusSpend: 84_788,
          limit: 7000,
          totalPercentUsed: 100,
        },
        spendLimitUsage: {
          individualLimit: 500,
          individualUsed: 331,
          individualRemaining: 169,
        },
        displayMessage: "You've used 98% of your included usage",
      }),
    ).toEqual({
      billingCycleStartMs: 1_785_358_531_000,
      billingCycleEndMs: 1_788_036_931_000,
      totalSpendCents: 91_788,
      includedSpendCents: 7000,
      bonusSpendCents: 84_788,
      planLimitCents: 7000,
      totalPercentUsed: 100,
      onDemandLimitCents: 500,
      onDemandUsedCents: 331,
      onDemandRemainingCents: 169,
      displayMessage: "You've used 98% of your included usage",
    })
  })

  it("handles a free/trial body with missing sections", () => {
    expect(
      parseCursorPeriodUsageInfo({
        planUsage: { bonusSpend: 225 },
        spendLimitUsage: { individualLimit: 0 },
      }),
    ).toEqual({ bonusSpendCents: 225, onDemandLimitCents: 0 })
  })
})

describe("secret bag codec", () => {
  it("merges enrichment into an existing bag without touching tokens", () => {
    const bag = { tokenType: "oauth", accessToken: "at", refreshToken: "rt" }
    const merged = withAccountMetadata(bag, {
      account: { userId: 5, email: "a@b.c" },
      periodUsage: { planLimitCents: 2000, totalPercentUsed: 40 },
    })
    expect(merged.tokenType).toBe("oauth")
    expect(merged.accessToken).toBe("at")
    expect(merged.userId).toBe(5)
    expect(merged.email).toBe("a@b.c")
    expect(merged.planLimitCents).toBe(2000)
  })

  it("round-trips through accountInfoFromBag and never leaks token keys", () => {
    const bag = withAccountMetadata(
      { accessToken: "at" },
      { account: { userId: 5, email: "a@b.c", country: "us" }, periodUsage: {} },
    )
    expect(hasAccountMetadata(bag as Record<string, never>)).toBe(true)
    const info = accountInfoFromBag(bag as Record<string, never>)
    expect(info.userId).toBe(5)
    expect(info.email).toBe("a@b.c")
    expect("accessToken" in info).toBe(false)
  })

  it("reports bags without metadata", () => {
    expect(hasAccountMetadata({ accessToken: "at" })).toBe(false)
  })
})

describe("fetchCursorAccountEnrichment", () => {
  it("probes both endpoints and merges results", async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url
      if (href.includes("GetMe")) {
        return new Response(
          encodeGetMe([
            { no: 2, int: 123 },
            { no: 3, str: "x@y.z" },
          ]),
          { status: 200, headers: { "content-type": "application/proto" } },
        )
      }
      return new Response(
        JSON.stringify({ billingCycleEnd: "1788036931000", planUsage: { limit: 7000 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as unknown as typeof fetch
    try {
      const result = await fetchCursorAccountEnrichment("token-redacted")
      expect(result.account?.userId).toBe(123)
      expect(result.account?.email).toBe("x@y.z")
      expect(result.periodUsage?.planLimitCents).toBe(7000)
      expect(result.periodUsage?.billingCycleEndMs).toBe(1_788_036_931_000)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it("never throws when both endpoints fail", async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch
    try {
      const result = await fetchCursorAccountEnrichment("token-redacted")
      expect(result).toEqual({})
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
