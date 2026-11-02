/**
 * Anthropic account plan probe for `ProviderPlugin.fetchAccountPlan`.
 *
 * Reads three OAuth account endpoints the claude-code CLI also calls
 * (verified against the 2.1.316 bundle):
 *
 *   - `GET /api/oauth/profile`: account flags plus the organization's
 *     `organization_type`, `seat_tier`, `rate_limit_tier`, and
 *     `subscription_status`.
 *   - `GET /api/oauth/claude_cli/roles`: the member's organization role.
 *   - `GET /api/oauth/usage`: utilization per limit window.
 *
 * None of these spend model quota. Only OAuth credentials can call them, so
 * API-key auth resolves `null`.
 *
 * Seat detection: a Team or Enterprise member without an assigned seat
 * still authenticates, and the organization still reports an active
 * subscription. The difference shows in `rate_limit_tier`: an unseated
 * member observed on 2026-11-01 reported `default_raven`, and the same
 * member after seat assignment reported `default_claude_max_5x`. Unknown
 * tiers are shown raw and leave `hasPlan` unset.
 *
 * Contract types are declared locally: the plugins repo pins a core commit
 * older than the `fetchAccountPlan` hook. The shapes match
 * `@minimal-agent/core/plugin-api/llm/provider-plugin` `AccountPlanInfo`
 * field for field, so the host reads them through the contract unchanged.
 *
 * @module llm/providers/anthropic/account-plan
 */

import type { ProviderAuth } from "@minimal-agent/core/plugin-api/llm/provider-auth"

import { USER_AGENT_OAUTH } from "./wire-constants.ts"

const API_BASE = "https://api.anthropic.com"

/** Local mirror of the contract `AccountPlanInfo`. */
export interface AnthropicAccountPlan {
  accountId?: string
  email?: string
  organizationId?: string
  organizationName?: string
  role?: string
  plan?: string
  hasPlan?: boolean
  windows?: { id: string; utilization: number; resetAtMs?: number }[]
  overage?: { enabled: boolean; reason?: string }
  details?: { key: string; label: string; value: string }[]
}

/** Local mirror of the contract `AccountPlanContext`. */
export interface AnthropicAccountPlanContext {
  signal?: AbortSignal
}

/** Test seam: the HTTP GET used for every endpoint. */
export type AccountGet = (path: string, token: string, signal?: AbortSignal) => Promise<unknown>

interface ProfileWire {
  account?: {
    uuid?: string
    email?: string
    has_claude_max?: boolean
    has_claude_pro?: boolean
  }
  organization?: {
    uuid?: string
    name?: string
    organization_type?: string
    seat_tier?: string | null
    rate_limit_tier?: string | null
    subscription_status?: string | null
    has_extra_usage_enabled?: boolean
    plan_display_name?: string | null
  }
}

interface RolesWire {
  organization_role?: string | null
  workspace_role?: string | null
}

interface UsageLimitWire {
  kind?: string
  percent?: number
  resets_at?: string | null
}

interface UsageWire {
  limits?: UsageLimitWire[]
  five_hour?: { utilization?: number; resets_at?: string | null } | null
  seven_day?: { utilization?: number; resets_at?: string | null } | null
  extra_usage?: { is_enabled?: boolean; disabled_reason?: string | null } | null
}

const ORG_TYPE_LABEL: Record<string, string> = {
  claude_team: "Team",
  claude_enterprise: "Enterprise",
  claude_max: "Max",
  claude_pro: "Pro",
}

/** Window labels for `limits[].kind`. Unknown kinds are shown as is. */
const LIMIT_KIND_LABEL: Record<string, string> = {
  session: "5h",
  weekly_all: "7d",
  weekly_scoped: "7d-model",
}

/**
 * Map a `rate_limit_tier` to a seat label and a seated flag. Returns
 * `undefined` for tiers this table does not know.
 */
export function describeRateLimitTier(
  tier: string,
): { label: string; seated: boolean } | undefined {
  if (tier === "default_raven") return { label: "no seat", seated: false }
  const max = tier.match(/^default_claude_max_(\d+)x$/)
  if (max) return { label: `Max ${max[1]}x`, seated: true }
  if (tier === "default_claude_pro") return { label: "Pro", seated: true }
  return undefined
}

function parseResetMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

function clampFraction(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

/** Build the usage windows, preferring `limits[]` over the legacy fields. */
export function parseUsageWindows(usage: UsageWire | null): AnthropicAccountPlan["windows"] {
  if (!usage) return undefined
  const out: { id: string; utilization: number; resetAtMs?: number }[] = []
  if (Array.isArray(usage.limits) && usage.limits.length > 0) {
    for (const l of usage.limits) {
      if (typeof l.kind !== "string" || typeof l.percent !== "number") continue
      const resetAtMs = parseResetMs(l.resets_at)
      out.push({
        id: LIMIT_KIND_LABEL[l.kind] ?? l.kind,
        utilization: clampFraction(l.percent / 100),
        ...(resetAtMs !== undefined ? { resetAtMs } : {}),
      })
    }
    return out
  }
  for (const [id, w] of [
    ["5h", usage.five_hour],
    ["7d", usage.seven_day],
  ] as const) {
    if (!w || typeof w.utilization !== "number") continue
    const resetAtMs = parseResetMs(w.resets_at)
    out.push({
      id,
      utilization: clampFraction(w.utilization / 100),
      ...(resetAtMs !== undefined ? { resetAtMs } : {}),
    })
  }
  return out
}

/** Pure: fold the three endpoint bodies into the neutral plan view. */
export function buildAccountPlan(
  profile: ProfileWire,
  roles: RolesWire | null,
  usage: UsageWire | null,
): AnthropicAccountPlan {
  const acct = profile.account ?? {}
  const org = profile.organization ?? {}
  const plan: AnthropicAccountPlan = {}
  if (acct.uuid) plan.accountId = acct.uuid
  if (acct.email) plan.email = acct.email
  if (org.uuid) plan.organizationId = org.uuid
  if (org.name) plan.organizationName = org.name
  const role = roles?.organization_role ?? roles?.workspace_role
  if (role) plan.role = role

  const orgType = org.organization_type ?? undefined
  const orgLabel = orgType ? (ORG_TYPE_LABEL[orgType] ?? orgType) : undefined
  const tier = org.rate_limit_tier ?? undefined
  const tierInfo = tier ? describeRateLimitTier(tier) : undefined

  if (org.plan_display_name) {
    plan.plan = org.plan_display_name
  } else if (tierInfo && (orgType === "claude_max" || orgType === "claude_pro")) {
    // Personal plans have no seats: the tier alone names the plan.
    plan.plan = tierInfo.label
  } else if (orgLabel && tierInfo) {
    plan.plan = tierInfo.seated ? `${orgLabel} · ${tierInfo.label} seat` : `${orgLabel} · no seat`
  } else if (orgLabel && tier) {
    plan.plan = `${orgLabel} · ${tier}`
  } else if (acct.has_claude_max) {
    plan.plan = "Max"
  } else if (acct.has_claude_pro) {
    plan.plan = "Pro"
  } else if (orgLabel) {
    plan.plan = orgLabel
  }

  if (org.subscription_status && org.subscription_status !== "active") {
    plan.hasPlan = false
  } else if (tierInfo) {
    plan.hasPlan = tierInfo.seated
  } else if (acct.has_claude_max || acct.has_claude_pro) {
    plan.hasPlan = true
  }

  const windows = parseUsageWindows(usage)
  if (windows) plan.windows = windows

  const extra = usage?.extra_usage
  if (extra) {
    plan.overage = {
      enabled: extra.is_enabled === true,
      ...(extra.disabled_reason ? { reason: extra.disabled_reason } : {}),
    }
  } else if (typeof org.has_extra_usage_enabled === "boolean") {
    plan.overage = { enabled: org.has_extra_usage_enabled }
  }

  const details: { key: string; label: string; value: string }[] = []
  if (orgType) details.push({ key: "organization_type", label: "org type", value: orgType })
  if (org.seat_tier) details.push({ key: "seat_tier", label: "seat tier", value: org.seat_tier })
  if (tier) details.push({ key: "rate_limit_tier", label: "rate tier", value: tier })
  if (org.subscription_status) {
    details.push({
      key: "subscription_status",
      label: "org subscription",
      value: org.subscription_status,
    })
  }
  if (details.length > 0) plan.details = details
  return plan
}

/** Default GET: OAuth bearer plus the beta header these endpoints require. */
const defaultGet: AccountGet = async (path, token, signal) => {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "GET",
    headers: {
      accept: "application/json",
      "user-agent": USER_AGENT_OAUTH,
      authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
    signal,
  })
  if (!response.ok) {
    // Never echo the body: it can quote request details. Status is enough.
    throw new Error(`${path} returned HTTP ${response.status}`)
  }
  return (await response.json()) as unknown
}

/**
 * Read plan, seat, role, and usage for one OAuth credential. Resolves
 * `null` for non-OAuth auth. Rejects when the profile call fails; the
 * roles and usage calls are optional and degrade to absent fields.
 */
export async function fetchAnthropicAccountPlan(
  auth: ProviderAuth,
  ctx: AnthropicAccountPlanContext = {},
  get: AccountGet = defaultGet,
): Promise<AnthropicAccountPlan | null> {
  if (auth.kind !== "oauth") return null
  const token = auth.token
  const [profile, roles, usage] = await Promise.all([
    get("/api/oauth/profile", token, ctx.signal) as Promise<ProfileWire>,
    (get("/api/oauth/claude_cli/roles", token, ctx.signal) as Promise<RolesWire>).catch(() => null),
    (get("/api/oauth/usage", token, ctx.signal) as Promise<UsageWire>).catch(() => null),
  ])
  return buildAccountPlan(profile ?? {}, roles, usage)
}
