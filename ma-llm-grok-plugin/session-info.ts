/**
 * Grok session metadata: rate-limit quotas + session usage + optional monthly billing.
 *
 * @module llm/providers/grok/session-info
 */

import type { NetworkClient } from "./lib/net-types.ts"
import type {
  ProviderSessionContext,
  ProviderSessionInfo,
  QuotaWindow,
} from "./lib/provider-plugin.ts"
import { grokContextWindow, grokModelShortLabel } from "./models.ts"
import { CLI_BILLING_URL, MODELS_URL } from "./wire-constants.ts"

const FRESHNESS_MS = 5 * 60_000

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
  at: number
} | null = null

export function setGrokRateLimits(headers: Headers): void {
  try {
    const copy = new Map<string, string>()
    headers.forEach((value, key) => {
      const lk = key.toLowerCase()
      if (
        lk.startsWith("x-ratelimit-") ||
        lk.startsWith("ratelimit-") ||
        lk === "retry-after"
      ) {
        copy.set(lk, value)
      }
    })
    if (copy.size === 0) return
    cache = { rateLimits: copy, at: Date.now() }
  } catch {
    // best-effort
  }
}

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

export function setGrokBillingQuota(input: {
  used: number
  limit: number
  periodEndMs?: number
}): void {
  if (!(input.limit > 0) || input.used < 0) return
  billingQuota = {
    used: input.used,
    limit: input.limit,
    periodEndMs: input.periodEndMs,
    at: Date.now(),
  }
}

export function getGrokRateLimits(): CachedGrokRateLimits | null {
  return cache
}

export function getGrokSessionUsage(): typeof sessionUsage {
  return sessionUsage
}

export function getGrokBillingQuota(): typeof billingQuota {
  return billingQuota
}

export function clearGrokSessionCaches(): void {
  cache = null
  sessionUsage = null
  billingQuota = null
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

export function parseGrokQuotaWindows(
  rateLimits: ReadonlyMap<string, string>,
): QuotaWindow[] {
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

  if (billingQuota && Date.now() - billingQuota.at < FRESHNESS_MS * 12) {
    out.push({
      id: "month",
      utilization: Math.min(1, Math.max(0, billingQuota.used / billingQuota.limit)),
      resetAtMs: billingQuota.periodEndMs,
    })
  }

  return out
}

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

export function _resetGrokPrimeInFlight(): void {
  inFlightPrime = null
}

export function primeGrokSessionInfo(ctx: ProviderSessionContext): Promise<void> {
  if (inFlightPrime) return inFlightPrime

  const work = (async () => {
    const cached = getGrokRateLimits()
    if (cached && Date.now() - cached.at < FRESHNESS_MS) return

    const apiKey =
      process.env["MINIMAL_AGENT_GROK_API_KEY"] ??
      process.env["XAI_API_KEY"] ??
      process.env["GROK_API_KEY"]
    if (!apiKey) return

    const networkClient = ctx.networkClient as NetworkClient | undefined
    if (!networkClient) return

    try {
      const probeSignal: AbortSignal = ctx.signal
        ? AbortSignal.any([ctx.signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000)

      const response = await networkClient.request({
        label: "grok.quota.probe",
        method: "GET",
        url: MODELS_URL,
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: "application/json",
        },
        signal: probeSignal,
      })
      if (response.ok) setGrokRateLimits(response.headers)
    } catch {
      // best-effort
    }
  })()

  inFlightPrime = work.finally(() => {
    inFlightPrime = null
  })
  return inFlightPrime
}

export async function refreshGrokBillingQuota(
  networkClient: NetworkClient,
  bearerToken: string,
): Promise<void> {
  try {
    const res = await networkClient.request({
      label: "grok.billing",
      method: "GET",
      url: CLI_BILLING_URL,
      headers: {
        authorization: `Bearer ${bearerToken}`,
        "x-xai-token-auth": "xai-grok-cli",
        accept: "application/json",
      },
    })
    if (!res.ok) return
    const text = await res.text()
    const body = JSON.parse(text) as {
      config?: {
        monthlyLimit?: { val?: number }
        used?: { val?: number }
        billingPeriodEnd?: string
      }
    }
    const limit = body.config?.monthlyLimit?.val
    const used = body.config?.used?.val
    if (typeof limit === "number" && typeof used === "number") {
      let periodEndMs: number | undefined
      if (body.config?.billingPeriodEnd) {
        const t = Date.parse(body.config.billingPeriodEnd)
        if (Number.isFinite(t)) periodEndMs = t
      }
      setGrokBillingQuota({ used, limit, periodEndMs })
    }
  } catch {
    // best-effort
  }
}
