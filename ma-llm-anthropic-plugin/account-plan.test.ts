import { describe, expect, test } from "bun:test"

import {
  type AccountGet,
  buildAccountPlan,
  describeRateLimitTier,
  fetchAnthropicAccountPlan,
  parseUsageWindows,
} from "./account-plan.ts"

// Shapes captured from live /api/oauth/* responses on 2026-11-01 (ids
// replaced). Same member before and after a Team seat was assigned.
const UNSEATED_PROFILE = {
  account: { uuid: "acct-1", email: "a@example.com", has_claude_max: false, has_claude_pro: false },
  organization: {
    uuid: "org-1",
    name: "Example Org",
    organization_type: "claude_team",
    seat_tier: "team_standard",
    rate_limit_tier: "default_raven",
    subscription_status: "active",
    has_extra_usage_enabled: false,
  },
}
const SEATED_PROFILE = {
  ...UNSEATED_PROFILE,
  organization: {
    ...UNSEATED_PROFILE.organization,
    seat_tier: "team_tier_1",
    rate_limit_tier: "default_claude_max_5x",
  },
}
const ROLES = { organization_role: "membership_admin", workspace_role: null }
const USAGE = {
  five_hour: { utilization: 21, resets_at: "2026-11-01T23:00:00.872672+00:00" },
  seven_day: { utilization: 11, resets_at: "2026-11-03T20:00:00.872699+00:00" },
  extra_usage: { is_enabled: false, disabled_reason: null, user_disabled: true },
  limits: [
    { kind: "session", percent: 21, resets_at: "2026-11-01T23:00:00.872672+00:00" },
    { kind: "weekly_all", percent: 11, resets_at: "2026-11-03T20:00:00.872699+00:00" },
    { kind: "weekly_scoped", percent: 0, resets_at: "2026-11-03T20:00:00.872699+00:00" },
  ],
}

describe("describeRateLimitTier", () => {
  test("default_raven is an unseated member", () => {
    expect(describeRateLimitTier("default_raven")).toEqual({ label: "no seat", seated: false })
  })
  test("max tiers carry the multiplier", () => {
    expect(describeRateLimitTier("default_claude_max_5x")).toEqual({
      label: "Max 5x",
      seated: true,
    })
    expect(describeRateLimitTier("default_claude_max_20x")?.label).toBe("Max 20x")
  })
  test("unknown tiers return undefined", () => {
    expect(describeRateLimitTier("something_new")).toBeUndefined()
  })
})

describe("buildAccountPlan", () => {
  test("unseated Team member: active org subscription but no plan", () => {
    const plan = buildAccountPlan(UNSEATED_PROFILE, ROLES, null)
    expect(plan.plan).toBe("Team · no seat")
    expect(plan.hasPlan).toBe(false)
    expect(plan.role).toBe("membership_admin")
    expect(plan.organizationName).toBe("Example Org")
    expect(plan.email).toBe("a@example.com")
  })

  test("seated Team member reports the seat tier", () => {
    const plan = buildAccountPlan(SEATED_PROFILE, ROLES, USAGE)
    expect(plan.plan).toBe("Team · Max 5x seat")
    expect(plan.hasPlan).toBe(true)
    expect(plan.overage).toEqual({ enabled: false })
    expect(plan.details?.map((d) => [d.key, d.value])).toEqual([
      ["organization_type", "claude_team"],
      ["seat_tier", "team_tier_1"],
      ["rate_limit_tier", "default_claude_max_5x"],
      ["subscription_status", "active"],
    ])
  })

  test("server plan_display_name wins over the derived label", () => {
    const profile = {
      ...SEATED_PROFILE,
      organization: { ...SEATED_PROFILE.organization, plan_display_name: "Team Premium" },
    }
    expect(buildAccountPlan(profile, null, null).plan).toBe("Team Premium")
  })

  test("inactive org subscription means no plan even when seated", () => {
    const profile = {
      ...SEATED_PROFILE,
      organization: { ...SEATED_PROFILE.organization, subscription_status: "past_due" },
    }
    expect(buildAccountPlan(profile, null, null).hasPlan).toBe(false)
  })

  test("personal Max org names the tier without a seat", () => {
    const profile = {
      organization: { organization_type: "claude_max", rate_limit_tier: "default_claude_max_5x" },
    }
    const plan = buildAccountPlan(profile, null, null)
    expect(plan.plan).toBe("Max 5x")
    expect(plan.hasPlan).toBe(true)
  })

  test("personal Max with no org tier falls back to account flags", () => {
    const plan = buildAccountPlan({ account: { has_claude_max: true } }, null, null)
    expect(plan.plan).toBe("Max")
    expect(plan.hasPlan).toBe(true)
  })

  test("unknown tier is shown raw and leaves hasPlan unset", () => {
    const profile = {
      organization: { organization_type: "claude_team", rate_limit_tier: "tier_x" },
    }
    const plan = buildAccountPlan(profile, null, null)
    expect(plan.plan).toBe("Team · tier_x")
    expect(plan.hasPlan).toBeUndefined()
  })
})

describe("parseUsageWindows", () => {
  test("prefers limits[] and maps kinds to short ids", () => {
    const w = parseUsageWindows(USAGE)
    expect(w?.map((x) => [x.id, x.utilization])).toEqual([
      ["5h", 0.21],
      ["7d", 0.11],
      ["7d-model", 0],
    ])
    expect(w?.[0]?.resetAtMs).toBe(Date.parse("2026-11-01T23:00:00.872672+00:00"))
  })
  test("falls back to five_hour / seven_day", () => {
    const w = parseUsageWindows({ five_hour: { utilization: 100 }, seven_day: { utilization: 55 } })
    expect(w).toEqual([
      { id: "5h", utilization: 1 },
      { id: "7d", utilization: 0.55 },
    ])
  })
  test("null usage yields no windows", () => {
    expect(parseUsageWindows(null)).toBeUndefined()
  })
})

describe("fetchAnthropicAccountPlan", () => {
  const routes: Record<string, unknown> = {
    "/api/oauth/profile": SEATED_PROFILE,
    "/api/oauth/claude_cli/roles": ROLES,
    "/api/oauth/usage": USAGE,
  }

  test("api-key auth resolves null without any request", async () => {
    let calls = 0
    const get: AccountGet = async () => {
      calls += 1
      return {}
    }
    expect(await fetchAnthropicAccountPlan({ kind: "api-key", key: "k" }, {}, get)).toBeNull()
    expect(calls).toBe(0)
  })

  test("oauth auth reads all three endpoints with the stored token", async () => {
    const seen: string[] = []
    const get: AccountGet = async (path, token) => {
      seen.push(`${path} ${token}`)
      return routes[path]
    }
    const plan = await fetchAnthropicAccountPlan({ kind: "oauth", token: "tok" }, {}, get)
    expect(plan?.plan).toBe("Team · Max 5x seat")
    expect(plan?.windows?.length).toBe(3)
    expect(seen.sort()).toEqual([
      "/api/oauth/claude_cli/roles tok",
      "/api/oauth/profile tok",
      "/api/oauth/usage tok",
    ])
  })

  test("roles and usage failures degrade to absent fields", async () => {
    const get: AccountGet = async (path) => {
      if (path === "/api/oauth/profile") return SEATED_PROFILE
      throw new Error(`${path} returned HTTP 500`)
    }
    const plan = await fetchAnthropicAccountPlan({ kind: "oauth", token: "t" }, {}, get)
    expect(plan?.plan).toBe("Team · Max 5x seat")
    expect(plan?.role).toBeUndefined()
    expect(plan?.windows).toBeUndefined()
  })

  test("profile failure rejects", async () => {
    const get: AccountGet = async (path) => {
      throw new Error(`${path} returned HTTP 401`)
    }
    await expect(fetchAnthropicAccountPlan({ kind: "oauth", token: "t" }, {}, get)).rejects.toThrow(
      "HTTP 401",
    )
  })
})
