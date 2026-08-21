/**
 * Grok session metadata: rate-limit quotas + session usage + monthly billing.
 *
 * Implements TWO seams on `ProviderPlugin`:
 *
 *   - {@link fetchGrokSessionInfo} → `fetchSessionInfo` (**cache-only**).
 *   - {@link primeGrokSessionInfo} → `primeSessionInfo` (cold-start warmup).
 *
 * Monthly quota comes from cli-chat-proxy `GET /v1/billing` (OAuth/session
 * tokens). RPM/TPM come from `x-ratelimit-*` response headers on real traffic
 * and from the optional models probe.
 *
 * Credential resolution for the prime path (plugins cannot call host
 * `getAuth`):
 *   1. Honor `ctx.authKind` / `ctx.credentialName` from the host session.
 *   2. Else env API keys (`MINIMAL_AGENT_GROK_API_KEY` / `XAI_API_KEY` /
 *      `GROK_API_KEY`), then the matching `grok-oauth` auth.jsonc entry.
 *
 * Weekly `creditUsagePercent` (Grok CLI unified billing) comes from
 * cli-chat-proxy `GET /v1/billing?format=credits` (verified 2026-08-21:
 * `config.creditUsagePercent`, `config.currentPeriod.type=USAGE_PERIOD_TYPE_WEEKLY`,
 * `productUsage[].usagePercent`). Surfaced as the `week` quota window.
 *
 * @module llm/providers/grok/session-info
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type { NetworkClient } from "./lib/net-types.ts"
import type {
  ProviderSessionContext,
  ProviderSessionInfo,
  QuotaWindow,
} from "./lib/provider-plugin.ts"
import { grokContextWindow, grokModelShortLabel } from "./models.ts"
import { GROK_OAUTH } from "./oauth-login.ts"
import {
  CLI_BILLING_CREDITS_URL,
  CLI_BILLING_URL,
  CLI_MODELS_URL,
  MODELS_URL,
  XAI_TOKEN_AUTH_VALUE,
} from "./wire-constants.ts"

const FRESHNESS_MS = 5 * 60_000
/** Keep the monthly billing window a bit longer than rate-limit headers. */
const BILLING_FRESHNESS_MS = FRESHNESS_MS * 12

export interface CachedGrokRateLimits {
  rateLimits: ReadonlyMap<string, string>
  at: number
}

let cache: { rateLimits: Map<string, string>; at: number } | null = null

let sessionUsage: {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  at: number
} | null = null

let billingQuota: {
  used: number
  limit: number
  periodEndMs?: number
  onDemandCap?: number
  onDemandUsed?: number
  at: number
} | null = null

let weeklyCredits: {
  /** 0-100, from `config.creditUsagePercent`. */
  usagePercent: number
  periodEndMs?: number
  at: number
} | null = null

/** Capture rate-limit headers from a live Grok response into the session cache. */
export function setGrokRateLimits(headers: Headers): void {
  try {
    const copy = new Map<string, string>()
    headers.forEach((value, key) => {
      const lk = key.toLowerCase()
      if (lk.startsWith("x-ratelimit-") || lk.startsWith("ratelimit-") || lk === "retry-after") {
        copy.set(lk, value)
      }
    })
    if (copy.size === 0) return
    cache = { rateLimits: copy, at: Date.now() }
  } catch {
    // best-effort
  }
}

/** Add a turn's token usage into the running session totals. */
export function accumulateGrokUsage(usage: {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
}): void {
  if (sessionUsage) {
    sessionUsage.inputTokens += usage.inputTokens
    sessionUsage.outputTokens += usage.outputTokens
    sessionUsage.cacheReadTokens += usage.cacheReadTokens ?? 0
    sessionUsage.at = Date.now()
  } else {
    sessionUsage = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      at: Date.now(),
    }
  }
}

/**
 * Cache billing quota from cli-chat-proxy `/v1/billing`.
 *
 * `limit === 0` is allowed (Free / no included pool) so we mark the probe
 * fresh and avoid re-fetching every OAuth turn. The status bar only emits a
 * `month` window when `limit > 0`.
 */
export function setGrokBillingQuota(input: {
  used: number
  limit: number
  periodEndMs?: number
  onDemandCap?: number
  onDemandUsed?: number
}): void {
  if (input.limit < 0 || input.used < 0) return
  if (input.onDemandCap != null && input.onDemandCap < 0) return
  if (input.onDemandUsed != null && input.onDemandUsed < 0) return
  billingQuota = {
    used: input.used,
    limit: input.limit,
    periodEndMs: input.periodEndMs,
    onDemandCap: input.onDemandCap,
    onDemandUsed: input.onDemandUsed,
    at: Date.now(),
  }
}

/** Cache the weekly unified-billing usage (0-100 percent). */
export function setGrokWeeklyCredits(input: { usagePercent: number; periodEndMs?: number }): void {
  if (!Number.isFinite(input.usagePercent) || input.usagePercent < 0) return
  weeklyCredits = {
    usagePercent: Math.min(100, input.usagePercent),
    periodEndMs: input.periodEndMs,
    at: Date.now(),
  }
}

/** Read the cached rate-limit header snapshot, if any. */
export function getGrokRateLimits(): CachedGrokRateLimits | null {
  return cache
}

/** Read the running session token totals, if any. */
export function getGrokSessionUsage(): typeof sessionUsage {
  return sessionUsage
}

/** Read the cached monthly billing quota, if any. */
export function getGrokBillingQuota(): typeof billingQuota {
  return billingQuota
}

/** Read the cached weekly credits usage, if any. */
export function getGrokWeeklyCredits(): typeof weeklyCredits {
  return weeklyCredits
}

/** Drop rate-limit, usage, and billing caches (tests / logout). */
export function clearGrokSessionCaches(): void {
  cache = null
  sessionUsage = null
  billingQuota = null
  weeklyCredits = null
}

function parseResetMs(s: string): number | undefined {
  if (typeof s !== "string") return undefined
  const trimmed = s.trim()
  if (!trimmed) return undefined
  const m = /^(\d+(?:\.\d+)?)(ms|[smhd])?$/i.exec(trimmed)
  if (!m) {
    const asNum = Number(trimmed)
    if (Number.isFinite(asNum) && asNum > 1e12) return asNum
    if (Number.isFinite(asNum)) return asNum * 1000
    return undefined
  }
  const n = Number(m[1])
  const unit = (m[2] ?? "s").toLowerCase()
  const unitMs: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  }
  return n * (unitMs[unit] ?? 1000)
}

/** Project cached rate-limit headers (+ billing) into provider-neutral quota windows. */
export function parseGrokQuotaWindows(rateLimits: ReadonlyMap<string, string>): QuotaWindow[] {
  const out: QuotaWindow[] = []
  const now = Date.now()

  const build = (id: string, limitKey: string, remainingKey: string, resetKey: string): void => {
    const limit = Number(rateLimits.get(limitKey))
    const remaining = Number(rateLimits.get(remainingKey))
    if (!Number.isFinite(limit) || limit <= 0) return
    if (!Number.isFinite(remaining)) return
    let utilization = 1 - remaining / limit
    if (utilization < 0) utilization = 0
    if (utilization > 1) utilization = 1
    const resetMs = parseResetMs(rateLimits.get(resetKey) ?? "")
    const resetAtMs = resetMs == null ? undefined : now + resetMs
    out.push({ id, utilization, resetAtMs })
  }

  build(
    "rpm",
    "x-ratelimit-limit-requests",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-reset-requests",
  )
  build(
    "tpm",
    "x-ratelimit-limit-tokens",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset-tokens",
  )

  if (weeklyCredits && Date.now() - weeklyCredits.at < BILLING_FRESHNESS_MS) {
    out.push({
      id: "week",
      utilization: Math.min(1, Math.max(0, weeklyCredits.usagePercent / 100)),
      resetAtMs: weeklyCredits.periodEndMs,
    })
  }

  if (billingQuota && Date.now() - billingQuota.at < BILLING_FRESHNESS_MS) {
    if (billingQuota.limit > 0) {
      out.push({
        id: "month",
        utilization: Math.min(1, Math.max(0, billingQuota.used / billingQuota.limit)),
        resetAtMs: billingQuota.periodEndMs,
      })
    }
    const odCap = billingQuota.onDemandCap
    if (odCap != null && odCap > 0) {
      const odUsed = billingQuota.onDemandUsed ?? 0
      out.push({
        id: "ondemand",
        utilization: Math.min(1, Math.max(0, odUsed / odCap)),
        resetAtMs: billingQuota.periodEndMs,
      })
    }
  }

  return out
}

/** Cache-only session metadata for the status bar (never blocks on network). */
export async function fetchGrokSessionInfo(
  ctx: ProviderSessionContext,
): Promise<ProviderSessionInfo | null> {
  if (ctx.signal?.aborted) return {}

  const contextWindow = grokContextWindow(ctx.modelId)
  const modelLabel = `xai-${grokModelShortLabel(ctx.modelId)}`

  const cached = getGrokRateLimits()
  const rl =
    cached && Date.now() - cached.at < FRESHNESS_MS ? cached.rateLimits : new Map<string, string>()
  const windows = parseGrokQuotaWindows(rl)
  const quota = windows.length > 0 ? { windows } : undefined

  return { contextWindow, modelLabel, quota }
}

let inFlightPrime: Promise<void> | null = null

/** Test-only: clear the in-flight prime promise so a new prime can start. */
export function _resetGrokPrimeInFlight(): void {
  inFlightPrime = null
}

/** Env var names that may hold a Grok / xAI API key (console key). */
function resolveEnvApiKey(): string | undefined {
  return (
    process.env["MINIMAL_AGENT_GROK_API_KEY"] ??
    process.env["XAI_API_KEY"] ??
    process.env["GROK_API_KEY"]
  )
}

/**
 * Best-effort read of the OAuth access token from the host auth store.
 *
 * Plugins cannot import host `getAuth`; the store file is JSONC at
 * `~/.minimal-agent/auth.jsonc` (or `$MINIMAL_AGENT_HOME/auth.jsonc`).
 *
 * When `credentialName` is set, selects that entry's `name`. Otherwise prefers
 * the default {@link GROK_OAUTH.displayName}, then the first `grok-oauth` entry.
 */
export function readGrokOAuthTokenFromAuthStore(credentialName?: string): string | null {
  try {
    const home = process.env["MINIMAL_AGENT_HOME"]?.trim() || join(homedir(), ".minimal-agent")
    const path = join(home, "auth.jsonc")
    if (!existsSync(path)) return null
    const raw = readFileSync(path, "utf8")
    // Tolerate // comments and trailing commas (JSONC).
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n\r]*/g, "$1")
      .replace(/,(\s*[}\]])/g, "$1")
    const data = JSON.parse(stripped) as {
      entries?: Array<{ id?: string; name?: string; secrets?: { accessToken?: unknown } }>
    }
    const entries = (data.entries ?? []).filter((e) => e?.id === "grok-oauth")
    const entry = credentialName
      ? entries.find((e) => e?.name === credentialName)
      : (entries.find((e) => e?.name === GROK_OAUTH.displayName) ?? entries[0])
    const token = entry?.secrets?.accessToken
    return typeof token === "string" && token.length > 0 ? token : null
  } catch {
    return null
  }
}

type CredentialKind = "api-key" | "oauth"

interface ResolvedCredential {
  kind: CredentialKind
  token: string
}

/**
 * Resolve which credential the prime path should use.
 *
 * Honors host `authKind` / `credentialName` so `--credential-name grok-oauth-3`
 * cannot be overridden by a stray `XAI_API_KEY`, and OAuth sessions never
 * silently prime with the first auth.jsonc entry.
 */
function resolvePrimeCredential(ctx: ProviderSessionContext): ResolvedCredential | null {
  const apiKey = resolveEnvApiKey()?.trim()
  const oauth = readGrokOAuthTokenFromAuthStore(ctx.credentialName)

  if (ctx.authKind === "oauth") {
    return oauth ? { kind: "oauth", token: oauth } : null
  }
  if (ctx.authKind === "api-key") {
    return apiKey ? { kind: "api-key", token: apiKey } : null
  }

  // Legacy / unset authKind: named credential ⇒ OAuth by name; else env key, then default OAuth.
  if (ctx.credentialName) {
    if (oauth) return { kind: "oauth", token: oauth }
    return null
  }
  if (apiKey) return { kind: "api-key", token: apiKey }
  if (oauth) return { kind: "oauth", token: oauth }
  return null
}

function billingIsFresh(): boolean {
  return Boolean(billingQuota && Date.now() - billingQuota.at < BILLING_FRESHNESS_MS)
}

function weeklyCreditsAreFresh(): boolean {
  return Boolean(weeklyCredits && Date.now() - weeklyCredits.at < BILLING_FRESHNESS_MS)
}

function rateLimitsAreFresh(): boolean {
  return Boolean(cache && Date.now() - cache.at < FRESHNESS_MS)
}

/**
 * Warm rate-limit headers (via GET /models) and, for OAuth, monthly billing
 * (via GET /v1/billing on cli-chat-proxy).
 *
 * Never throws. Self-deduplicates concurrent callers.
 */
export function primeGrokSessionInfo(ctx: ProviderSessionContext): Promise<void> {
  if (inFlightPrime) return inFlightPrime

  const work = (async () => {
    const needRateLimits = !rateLimitsAreFresh()
    const needBilling = !billingIsFresh() || !weeklyCreditsAreFresh()
    if (!needRateLimits && !needBilling) return

    const cred = resolvePrimeCredential(ctx)
    if (!cred) return

    const networkClient = ctx.networkClient as NetworkClient | undefined
    // Fall back to global fetch when the host did not inject a client (boot
    // path currently calls prime without networkClient).
    const probeSignal: AbortSignal = ctx.signal
      ? AbortSignal.any([ctx.signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000)

    const tasks: Promise<void>[] = []

    if (needRateLimits) {
      tasks.push(
        (async () => {
          try {
            const url = cred.kind === "oauth" ? CLI_MODELS_URL : MODELS_URL
            const headers: Record<string, string> = {
              authorization: `Bearer ${cred.token}`,
              accept: "application/json",
            }
            if (cred.kind === "oauth") {
              headers["x-xai-token-auth"] = XAI_TOKEN_AUTH_VALUE
            }
            if (networkClient) {
              const response = await networkClient.request({
                label: "grok.quota.probe",
                method: "GET",
                url,
                headers,
                signal: probeSignal,
              })
              if (response.ok) setGrokRateLimits(response.headers)
            } else {
              const response = await fetch(url, { headers, signal: probeSignal })
              if (response.ok) setGrokRateLimits(response.headers)
            }
          } catch {
            // best-effort
          }
        })(),
      )
    }

    // Monthly billing only applies to cli-chat-proxy (OAuth / session tokens).
    // Console API keys use api.x.ai, which has no /billing endpoint.
    if (needBilling && cred.kind === "oauth") {
      tasks.push(
        (async () => {
          if (!billingIsFresh()) {
            if (networkClient) {
              await refreshGrokBillingQuota(networkClient, cred.token, probeSignal)
            } else {
              await refreshGrokBillingQuotaViaFetch(cred.token, probeSignal)
            }
          }
          if (!weeklyCreditsAreFresh()) {
            if (networkClient) {
              await refreshGrokWeeklyCredits(networkClient, cred.token, probeSignal)
            } else {
              await refreshGrokWeeklyCreditsViaFetch(cred.token, probeSignal)
            }
          }
        })(),
      )
    }

    await Promise.all(tasks)
  })()

  inFlightPrime = work.finally(() => {
    inFlightPrime = null
  })
  return inFlightPrime
}

/**
 * Fetch monthly quota from cli-chat-proxy and cache it.
 * Safe to call from the adapter after an OAuth turn or from prime.
 */
export async function refreshGrokBillingQuota(
  networkClient: NetworkClient,
  bearerToken: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const res = await networkClient.request({
      label: "grok.billing",
      method: "GET",
      url: CLI_BILLING_URL,
      headers: {
        authorization: `Bearer ${bearerToken}`,
        "x-xai-token-auth": XAI_TOKEN_AUTH_VALUE,
        accept: "application/json",
      },
      signal,
    })
    if (!res.ok) return
    const text = await res.text()
    applyBillingBody(text)
  } catch {
    // best-effort
  }
}

/** Same as {@link refreshGrokBillingQuota} but uses global `fetch` (no host client). */
export async function refreshGrokBillingQuotaViaFetch(
  bearerToken: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const res = await fetch(CLI_BILLING_URL, {
      method: "GET",
      headers: {
        authorization: `Bearer ${bearerToken}`,
        "x-xai-token-auth": XAI_TOKEN_AUTH_VALUE,
        accept: "application/json",
      },
      signal,
    })
    if (!res.ok) return
    const text = await res.text()
    applyBillingBody(text)
  } catch {
    // best-effort
  }
}

function applyBillingBody(text: string): void {
  const body = JSON.parse(text) as {
    config?: {
      monthlyLimit?: { val?: number }
      used?: { val?: number }
      onDemandCap?: { val?: number }
      onDemandUsed?: { val?: number }
      billingPeriodEnd?: string
    }
  }
  const limit = body.config?.monthlyLimit?.val
  const used = body.config?.used?.val
  if (typeof limit !== "number" || typeof used !== "number") return
  let periodEndMs: number | undefined
  if (body.config?.billingPeriodEnd) {
    const t = Date.parse(body.config.billingPeriodEnd)
    if (Number.isFinite(t)) periodEndMs = t
  }
  const onDemandCap = body.config?.onDemandCap?.val
  const onDemandUsed = body.config?.onDemandUsed?.val
  setGrokBillingQuota({
    used,
    limit,
    periodEndMs,
    ...(typeof onDemandCap === "number" ? { onDemandCap } : {}),
    ...(typeof onDemandUsed === "number" ? { onDemandUsed } : {}),
  })
}

function applyWeeklyCreditsBody(text: string): void {
  const body = JSON.parse(text) as {
    config?: {
      creditUsagePercent?: number
      currentPeriod?: { end?: string; type?: string }
      billingPeriodEnd?: string
    }
  }
  const pct = body.config?.creditUsagePercent
  if (typeof pct !== "number") return
  const endRaw = body.config?.currentPeriod?.end ?? body.config?.billingPeriodEnd
  let periodEndMs: number | undefined
  if (endRaw) {
    const t = Date.parse(endRaw)
    if (Number.isFinite(t)) periodEndMs = t
  }
  setGrokWeeklyCredits({ usagePercent: pct, periodEndMs })
}

/**
 * Fetch weekly unified-billing usage (`?format=credits`) and cache it.
 * Verified live 2026-08-21: `config.creditUsagePercent` (0-100),
 * `config.currentPeriod.type=USAGE_PERIOD_TYPE_WEEKLY`.
 */
export async function refreshGrokWeeklyCredits(
  networkClient: NetworkClient,
  bearerToken: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const res = await networkClient.request({
      label: "grok.billing.credits",
      method: "GET",
      url: CLI_BILLING_CREDITS_URL,
      headers: {
        authorization: `Bearer ${bearerToken}`,
        "x-xai-token-auth": XAI_TOKEN_AUTH_VALUE,
        accept: "application/json",
      },
      signal,
    })
    if (!res.ok) return
    applyWeeklyCreditsBody(await res.text())
  } catch {
    // best-effort
  }
}

/** Same as {@link refreshGrokWeeklyCredits} but uses global `fetch`. */
export async function refreshGrokWeeklyCreditsViaFetch(
  bearerToken: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const res = await fetch(CLI_BILLING_CREDITS_URL, {
      headers: {
        authorization: `Bearer ${bearerToken}`,
        "x-xai-token-auth": XAI_TOKEN_AUTH_VALUE,
        accept: "application/json",
      },
      signal,
    })
    if (!res.ok) return
    applyWeeklyCreditsBody(await res.text())
  } catch {
    // best-effort
  }
}
