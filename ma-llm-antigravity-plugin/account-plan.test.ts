/**
 * Tests for the Antigravity `fetchAccountPlan` probe.
 *
 * The fixtures are reduced copies of the captured `loadCodeAssist` and
 * `retrieveUserQuotaSummary` responses. The email, the account id and the
 * project id are fake values.
 *
 * @module antigravity.account-plan.test
 */

import { beforeEach, describe, expect, it } from "bun:test"

import type { NetworkClient, NetworkRequestInput } from "@minimal-agent/core/plugin-api/net/types"

import {
  buildAntigravityAccountPlan,
  fetchAntigravityAccountPlan,
  type PlanLoadCodeAssist,
} from "./account-plan.ts"
import { antigravityProviderPlugin } from "./adapter.ts"
import { clearAntigravityLiveModelsCache, type QuotaSummaryResponse } from "./live-models.ts"
import { antigravityUserAgent } from "./wire-constants.ts"

const PROJECT = "fake-project-1"
const TOKEN = "test-token-value"

/** Reduced `loadCodeAssist` capture, with fake ids. */
const LCA_PAID: PlanLoadCodeAssist = {
  currentTier: { id: "free-tier", name: "Antigravity" },
  allowedTiers: [{ id: "free-tier", isDefault: true }, { id: "standard-tier" }],
  cloudaicompanionProject: PROJECT,
  gcpManaged: false,
  paidTier: {
    id: "g1-pro-tier",
    name: "Google AI Pro",
    availableCredits: [{ creditType: "GOOGLE_ONE_AI", minimumCreditAmountForUsage: "50" }],
  },
}

/** Reduced `retrieveUserQuotaSummary` capture. */
const QUOTA: QuotaSummaryResponse = {
  description: "Within each group, models share a weekly limit and a 5-hour limit.",
  groups: [
    {
      displayName: "Gemini Models",
      buckets: [
        {
          bucketId: "gemini-weekly",
          displayName: "Weekly Limit Remaining",
          window: "weekly",
          resetTime: "2030-01-08T03:04:05Z",
          remainingFraction: 0.9899833,
        },
        {
          bucketId: "gemini-5h",
          displayName: "Five Hour Limit Remaining",
          window: "5h",
          resetTime: "2030-01-02T03:04:05Z",
          remainingFraction: 0.81902844,
        },
      ],
    },
    {
      displayName: "Claude and GPT models",
      buckets: [
        { bucketId: "3p-weekly", window: "weekly", remainingFraction: 1 },
        { bucketId: "3p-5h", window: "5h", remainingFraction: 1 },
      ],
    },
  ],
}

const USERINFO = { id: "100000000000000000001", email: "user@example.test" }

interface Seen {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  signal?: AbortSignal
}

type Answer = { status: number; body: unknown }

function respond(answer: Answer) {
  const text = JSON.stringify(answer.body)
  return {
    ok: answer.status >= 200 && answer.status < 300,
    status: answer.status,
    headers: new Headers({ "content-type": "application/json" }),
    body: new ReadableStream<Uint8Array>(),
    transport: { id: "test" },
    async text() {
      return text
    },
    async json<T>(): Promise<T> {
      return answer.body as T
    },
  }
}

/** A client that records each request and answers by path. */
function client(seen: Seen[], answers: Partial<Record<string, Answer>> = {}): NetworkClient {
  return {
    async request(input: NetworkRequestInput) {
      seen.push({
        url: input.url,
        method: input.method,
        headers: input.headers ?? {},
        body: typeof input.body === "string" ? input.body : undefined,
        signal: input.signal,
      })
      const url = new URL(input.url)
      if (url.pathname.endsWith(":loadCodeAssist")) {
        return respond(answers.loadCodeAssist ?? { status: 200, body: LCA_PAID })
      }
      if (url.pathname.endsWith(":retrieveUserQuotaSummary")) {
        return respond(answers.quota ?? { status: 200, body: QUOTA })
      }
      if (url.host === "www.googleapis.com" && url.pathname === "/oauth2/v2/userinfo") {
        return respond(answers.userinfo ?? { status: 200, body: USERINFO })
      }
      return respond({ status: 404, body: {} })
    },
  } as NetworkClient
}

beforeEach(() => {
  clearAntigravityLiveModelsCache()
})

describe("buildAntigravityAccountPlan", () => {
  it("a paid tier gives the paid name and hasPlan true", () => {
    const plan = buildAntigravityAccountPlan(LCA_PAID, null, USERINFO)
    expect(plan.plan).toBe("Google AI Pro")
    expect(plan.hasPlan).toBe(true)
    expect(plan.accountId).toBe(USERINFO.id)
    expect(plan.email).toBe(USERINFO.email)
    expect(plan.organizationId).toBe(PROJECT)
    expect(plan.windows).toBeUndefined()
    expect(plan.details).toEqual([
      { key: "current_tier", label: "current tier", value: "free-tier" },
      { key: "paid_tier", label: "paid tier", value: "g1-pro-tier" },
      { key: "project", label: "project", value: PROJECT },
      { key: "credits", label: "credits", value: "GOOGLE_ONE_AI (min 50)" },
    ])
  })

  it("the free tier only gives the tier name and hasPlan false", () => {
    const plan = buildAntigravityAccountPlan(
      { currentTier: { id: "free-tier", name: "Antigravity" }, cloudaicompanionProject: PROJECT },
      null,
      null,
    )
    expect(plan.plan).toBe("Antigravity")
    expect(plan.hasPlan).toBe(false)
    expect(plan.email).toBeUndefined()
  })

  it("an unknown tier with no paid tier leaves hasPlan unset", () => {
    const plan = buildAntigravityAccountPlan({ currentTier: { id: "standard-tier" } }, null, null)
    expect(plan.plan).toBe("standard-tier")
    expect(plan.hasPlan).toBeUndefined()
  })

  it("4 buckets give 4 windows with utilization = 1 - remainingFraction", () => {
    const plan = buildAntigravityAccountPlan(LCA_PAID, QUOTA, null)
    expect(plan.windows?.map((w) => w.id)).toEqual([
      "gemini-weekly",
      "gemini-5h",
      "3p-weekly",
      "3p-5h",
    ])
    const fiveHour = plan.windows?.[1]
    expect(fiveHour?.utilization).toBeCloseTo(0.181, 3)
    expect(fiveHour?.resetAtMs).toBe(Date.UTC(2030, 0, 2, 3, 4, 5))
    expect(plan.windows?.[0]?.resetAtMs).toBe(Date.UTC(2030, 0, 8, 3, 4, 5))
    expect(plan.windows?.[2]?.utilization).toBe(0)
    expect(plan.windows?.[2]?.resetAtMs).toBeUndefined()
  })

  it("surfaces claimable and ineligible bankedResets in details", () => {
    const plan = buildAntigravityAccountPlan(
      LCA_PAID,
      {
        ...QUOTA,
        bankedResets: [
          {
            resetId: "reset-1",
            displayLabel: "Weekly reset",
            claimable: true,
            remainingCount: 2,
            bucketIds: ["gemini-5h", "3p-5h"],
            expireTime: "2030-01-15T00:00:00Z",
          },
          {
            resetId: "reset-2",
            displayLabel: "Bonus reset",
            claimable: false,
            ineligibleReason: "QUOTA_SUMMARY_BANKED_RESET_INELIGIBLE_REASON_USAGE_BELOW_THRESHOLD",
            remainingCount: 1,
          },
          {},
        ],
      },
      null,
    )
    const banked = plan.details?.filter((d) => d.key === "banked_reset")
    expect(banked).toEqual([
      {
        key: "banked_reset",
        label: "banked reset",
        value: "Weekly reset (claimable, 2 left, gemini-5h+3p-5h, expires 2030-01-15)",
      },
      {
        key: "banked_reset",
        label: "banked reset",
        value: "Bonus reset (usage below threshold, 1 left)",
      },
    ])
  })
})

describe("fetchAntigravityAccountPlan", () => {
  it("api-key auth resolves null and makes no request", async () => {
    const seen: Seen[] = []
    const plan = await fetchAntigravityAccountPlan({ kind: "api-key", key: "k" }, {}, client(seen))
    expect(plan).toBeNull()
    expect(seen).toEqual([])
  })

  it("oauth reads the 3 endpoints with the bearer token and the agy User-Agent", async () => {
    const seen: Seen[] = []
    const plan = await fetchAntigravityAccountPlan(
      { kind: "oauth", token: TOKEN },
      {},
      client(seen),
    )
    expect(plan?.plan).toBe("Google AI Pro")
    expect(plan?.windows).toHaveLength(4)
    expect(plan?.email).toBe(USERINFO.email)

    const lca = seen.find((s) => s.url.endsWith(":loadCodeAssist"))
    const quota = seen.find((s) => s.url.endsWith(":retrieveUserQuotaSummary"))
    expect(lca?.method).toBe("POST")
    expect(JSON.parse(lca?.body ?? "{}")).toEqual({ metadata: { ideType: "ANTIGRAVITY" } })
    expect(quota?.method).toBe("POST")
    expect(JSON.parse(quota?.body ?? "{}")).toEqual({ project: PROJECT })
    for (const s of seen) {
      expect(s.headers.authorization).toBe(`Bearer ${TOKEN}`)
      expect(s.headers["user-agent"]).toBe(antigravityUserAgent())
    }
  })

  it("zero telemetry: only loadCodeAssist, retrieveUserQuotaSummary and userinfo", async () => {
    const seen: Seen[] = []
    await fetchAntigravityAccountPlan({ kind: "oauth", token: TOKEN }, {}, client(seen))
    const targets = seen.map((s) => `${s.method} ${new URL(s.url).host}${new URL(s.url).pathname}`)
    expect(targets.sort()).toEqual([
      "GET www.googleapis.com/oauth2/v2/userinfo",
      "POST daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
      "POST daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
    ])
    const forbidden =
      /recordTrajectoryAnalytics|setUserSettings|writeTrajectoryAcls|fetchConfig|listExperiments|play\.googleapis\.com|aicode\.googleapis\.com/
    for (const s of seen) expect(s.url).not.toMatch(forbidden)
  })

  it("a quota or userinfo failure degrades to absent fields", async () => {
    const seen: Seen[] = []
    const plan = await fetchAntigravityAccountPlan(
      { kind: "oauth", token: TOKEN },
      {},
      client(seen, {
        quota: { status: 500, body: { error: "boom" } },
        userinfo: { status: 403, body: {} },
      }),
    )
    expect(plan?.plan).toBe("Google AI Pro")
    expect(plan?.windows).toBeUndefined()
    expect(plan?.email).toBeUndefined()
    expect(plan?.accountId).toBeUndefined()
  })

  it("a loadCodeAssist failure rejects with the status and no body or token", async () => {
    const seen: Seen[] = []
    const error = await fetchAntigravityAccountPlan(
      { kind: "oauth", token: TOKEN },
      {},
      client(seen, {
        loadCodeAssist: { status: 401, body: { error: { message: "secret-body-text" } } },
      }),
    ).then(
      () => null,
      (err: Error) => err,
    )
    expect(error?.message).toContain("HTTP 401")
    expect(error?.message).not.toContain("secret-body-text")
    expect(error?.message).not.toContain(TOKEN)
    expect(seen).toHaveLength(1)
  })

  it("passes ctx.signal to each request", async () => {
    const seen: Seen[] = []
    const controller = new AbortController()
    await fetchAntigravityAccountPlan(
      { kind: "oauth", token: TOKEN },
      { signal: controller.signal },
      client(seen),
    )
    expect(seen).toHaveLength(3)
    for (const s of seen) expect(s.signal).toBe(controller.signal)
  })
})

describe("antigravityProviderPlugin.fetchAccountPlan", () => {
  it("is wired and resolves null for api-key auth", async () => {
    expect(typeof antigravityProviderPlugin.fetchAccountPlan).toBe("function")
    await expect(
      antigravityProviderPlugin.fetchAccountPlan({ kind: "api-key", key: "k" }),
    ).resolves.toBeNull()
  })
})
