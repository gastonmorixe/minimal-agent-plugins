/**
 * Fetch + normalize Grok / xAI account profile fields for OAuth credentials.
 *
 * Called after device-code login and on refresh so `auth.jsonc` secrets keep
 * email / plan / planStatus (and related identity) up to date.
 *
 * Endpoints (Bearer = OIDC access token), confirmed 2026-08-05:
 *   - GET https://auth.x.ai/oauth2/userinfo
 *   - GET https://grok.com/api/auth/session
 *   - GET https://grok.com/rest/subscriptions
 *
 * @module llm/providers/grok/account-profile
 */

import type { NetworkClient } from "./lib/net-types.ts"
import type { AuthSecretBag } from "./lib/provider-plugin.ts"
import {
  GROK_SUBSCRIPTIONS_URL,
  GROK_USERINFO_URL,
  GROK_WEB_SESSION_URL,
} from "./wire-constants.ts"

/** Normalized account fields persisted into the OAuth secret bag. */
export interface GrokAccountProfile {
  emailAddress?: string
  displayName?: string
  givenName?: string
  familyName?: string
  emailVerified?: boolean
  picture?: string
  xUserId?: string
  /** Subscription tier, e.g. `SUBSCRIPTION_TIER_X_PREMIUM`. */
  plan?: string
  /** Subscription status, e.g. `SUBSCRIPTION_STATUS_ACTIVE`. */
  planStatus?: string
  /** PSP / entitlement provider: `stripe` | `x` | `braintree` | … */
  planProvider?: string
  /** ISO billing period end when the API provides one. */
  billingPeriodEnd?: string
}

interface SubscriptionRow {
  provider?: unknown
  tier?: unknown
  status?: unknown
  billingPeriodEnd?: unknown
  createTime?: unknown
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined
}

function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined
}

/** True for ACTIVE / SUBSCRIPTION_STATUS_ACTIVE (and similar suffixes). */
export function isActiveGrokPlanStatus(status: unknown): boolean {
  if (typeof status !== "string" || !status.trim()) return false
  const s = status.trim().toUpperCase()
  return s === "ACTIVE" || s.endsWith("_ACTIVE") || s.includes("STATUS_ACTIVE")
}

function subscriptionRecencyMs(row: SubscriptionRow): number {
  const end = str(row.billingPeriodEnd)
  if (end) {
    const t = Date.parse(end)
    if (Number.isFinite(t)) return t
  }
  const created = str(row.createTime)
  if (created) {
    const t = Date.parse(created)
    if (Number.isFinite(t)) return t
  }
  return 0
}

/**
 * Pick the best subscription row: prefer ACTIVE, else newest by
 * billingPeriodEnd / createTime among rows that have a tier.
 * Accepts either `summary` or `subscriptions` arrays from the REST payload.
 */
export function pickGrokSubscription(
  body: Record<string, unknown> | null | undefined,
): SubscriptionRow | null {
  if (!body || typeof body !== "object") return null
  const raw = body.summary ?? body.subscriptions
  if (!Array.isArray(raw) || raw.length === 0) return null
  const rows = raw.filter((r): r is SubscriptionRow => typeof r === "object" && r !== null)
  if (rows.length === 0) return null
  const actives = rows.filter((r) => isActiveGrokPlanStatus(r.status))
  if (actives.length > 0) {
    return (
      [...actives].sort((a, b) => subscriptionRecencyMs(b) - subscriptionRecencyMs(a))[0] ?? null
    )
  }
  const withTier = rows.filter((r) => str(r.tier))
  if (withTier.length === 0) return rows[0] ?? null
  return (
    [...withTier].sort((a, b) => subscriptionRecencyMs(b) - subscriptionRecencyMs(a))[0] ?? null
  )
}

/**
 * Project a subscriptions JSON body into plan fields.
 *
 * `null`/`undefined` means the fetch failed — return `{}` so callers can keep
 * previously persisted plan fields. An actual empty list means "no plan".
 */
export function planFieldsFromSubscriptions(
  body: Record<string, unknown> | null | undefined,
): Pick<GrokAccountProfile, "plan" | "planStatus" | "planProvider" | "billingPeriodEnd"> {
  if (body == null) return {}
  const row = pickGrokSubscription(body)
  if (!row) {
    return { planStatus: "none" }
  }
  return {
    ...(str(row.tier) ? { plan: str(row.tier) } : {}),
    ...(str(row.status) ? { planStatus: str(row.status) } : { planStatus: "none" }),
    ...(str(row.provider) ? { planProvider: str(row.provider) } : {}),
    ...(str(row.billingPeriodEnd) ? { billingPeriodEnd: str(row.billingPeriodEnd) } : {}),
  }
}

/** Project userinfo + session JSON into identity fields. */
export function identityFromUserinfoAndSession(
  userinfo: Record<string, unknown> | null | undefined,
  session: Record<string, unknown> | null | undefined,
): GrokAccountProfile {
  const ui = userinfo ?? {}
  const sess = session ?? {}
  const email = str(ui.email) ?? str(sess.email)
  const givenName = str(ui.given_name) ?? str(sess.givenName)
  const familyName = str(ui.family_name) ?? str(sess.familyName)
  const joinedName = [givenName, familyName].filter(Boolean).join(" ").trim()
  const displayName = str(ui.name) ?? (joinedName.length > 0 ? joinedName : undefined)
  const picture = str(ui.picture) ?? str(sess.profileImage)
  const xUserId = str(sess.xUserId)
  const emailVerified = bool(ui.email_verified)

  return {
    ...(email ? { emailAddress: email } : {}),
    ...(displayName ? { displayName } : {}),
    ...(givenName ? { givenName } : {}),
    ...(familyName ? { familyName } : {}),
    ...(emailVerified !== undefined ? { emailVerified } : {}),
    ...(picture ? { picture } : {}),
    ...(xUserId ? { xUserId } : {}),
  }
}

async function getJson(
  networkClient: NetworkClient,
  label: string,
  url: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await networkClient.request({
      label,
      method: "GET",
      url,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
      signal,
      capture: { requestBody: null, responseBody: false },
    })
    if (!response.ok) return null
    const raw = await response.json()
    return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Best-effort profile fetch. Never throws. Missing endpoints just omit fields.
 */
export async function fetchGrokAccountProfile(
  networkClient: NetworkClient,
  accessToken: string,
  signal?: AbortSignal,
): Promise<GrokAccountProfile> {
  const probeSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(12_000)])
    : AbortSignal.timeout(12_000)

  const [userinfo, session, subscriptions] = await Promise.all([
    getJson(networkClient, "grok.oauth.userinfo", GROK_USERINFO_URL, accessToken, probeSignal),
    getJson(networkClient, "grok.oauth.session", GROK_WEB_SESSION_URL, accessToken, probeSignal),
    getJson(
      networkClient,
      "grok.oauth.subscriptions",
      GROK_SUBSCRIPTIONS_URL,
      accessToken,
      probeSignal,
    ),
  ])

  return {
    ...identityFromUserinfoAndSession(userinfo, session),
    ...planFieldsFromSubscriptions(subscriptions),
  }
}

const PROFILE_SECRET_KEYS = [
  "emailAddress",
  "displayName",
  "givenName",
  "familyName",
  "emailVerified",
  "picture",
  "xUserId",
  "plan",
  "planStatus",
  "planProvider",
  "billingPeriodEnd",
] as const

/** Copy previously-persisted profile fields onto a fresh secret bag (refresh fallback). */
export function preserveGrokAccountProfileSecrets(
  secrets: AuthSecretBag,
  prior: AuthSecretBag | undefined,
): void {
  if (!prior) return
  for (const key of PROFILE_SECRET_KEYS) {
    if (secrets[key] !== undefined) continue
    const prev = prior[key]
    if (prev === undefined || prev === null) continue
    if (typeof prev === "string" || typeof prev === "number" || typeof prev === "boolean") {
      secrets[key] = prev
    }
  }
}

/** Merge a fetched profile into the secret bag (overwrites when the new value is set). */
export function applyGrokAccountProfile(secrets: AuthSecretBag, profile: GrokAccountProfile): void {
  if (profile.emailAddress) secrets.emailAddress = profile.emailAddress
  if (profile.displayName) secrets.displayName = profile.displayName
  if (profile.givenName) secrets.givenName = profile.givenName
  if (profile.familyName) secrets.familyName = profile.familyName
  if (profile.emailVerified !== undefined) secrets.emailVerified = profile.emailVerified
  if (profile.picture) secrets.picture = profile.picture
  if (profile.xUserId) secrets.xUserId = profile.xUserId
  if (profile.planStatus === "none") {
    secrets.planStatus = "none"
    delete secrets.plan
    delete secrets.planProvider
    delete secrets.billingPeriodEnd
    return
  }
  if (profile.plan) secrets.plan = profile.plan
  if (profile.planStatus) secrets.planStatus = profile.planStatus
  if (profile.planProvider) secrets.planProvider = profile.planProvider
  if (profile.billingPeriodEnd) secrets.billingPeriodEnd = profile.billingPeriodEnd
}

/** True when the profile has at least one useful identity or plan field. */
export function grokAccountProfileHasData(profile: GrokAccountProfile): boolean {
  return Boolean(
    profile.emailAddress ||
      profile.displayName ||
      profile.plan ||
      profile.planStatus ||
      profile.xUserId,
  )
}
