/**
 * Session metadata for the status bar.
 *
 * Two sources, both cheap:
 *
 * 1. Usage of this process, accumulated from the final `message_delta` of each
 *    stream, so the footer shows real token totals.
 * 2. The plan quota windows, from `retrieveUserQuotaSummary`. That call spends
 *    no inference quota, and the result is cached for 60 s.
 *
 * `fetchSessionInfo` itself makes no network call, as the host contract
 * requires. `primeSessionInfo` is the background probe that fills the cache.
 *
 * @module llm/providers/antigravity/session-info
 */

import type { ProviderAuth } from "@minimal-agent/core/plugin-api/llm/provider-auth"
import type {
  ProviderSessionContext,
  ProviderSessionInfo,
  QuotaWindow,
} from "@minimal-agent/core/plugin-api/llm/provider-plugin"
import type { NetworkClient } from "@minimal-agent/core/plugin-api/net/types"

import { fetchQuotaSummary, type QuotaSummaryResponse } from "./live-models.ts"

/** Accumulated usage of this process. */
let sessionUsage: { inputTokens: number; outputTokens: number; at: number } | null = null

/** Cached plan quota. */
let quotaCache: { at: number; info: ProviderSessionInfo } | null = null

/** Cache lifetime of the quota probe. */
const QUOTA_TTL_MS = 60_000

/** Add one response's usage to the process totals. Non-throwing. */
export function accumulateAntigravityUsage(usage: {
  inputTokens: number
  outputTokens: number
}): void {
  if (!sessionUsage) {
    sessionUsage = { ...usage, at: Date.now() }
    return
  }
  sessionUsage.inputTokens += usage.inputTokens
  sessionUsage.outputTokens += usage.outputTokens
  sessionUsage.at = Date.now()
}

/** Read the accumulated usage of this process. */
export function getAntigravitySessionUsage(): typeof sessionUsage {
  return sessionUsage
}

/** Reset the accumulated usage. Tests call this between cases. */
export function clearAntigravitySessionUsage(): void {
  sessionUsage = null
  quotaCache = null
}

/** Convert a quota bucket to a canonical window. The label is the bucket id. */
function toWindow(
  buckets: NonNullable<NonNullable<QuotaSummaryResponse["groups"]>[number]["buckets"]>,
  i: number,
): QuotaWindow | null {
  const b = buckets[i]
  if (!b) return null
  const remaining = typeof b.remainingFraction === "number" ? b.remainingFraction : 1
  const resetAt = b.resetTime ? Date.parse(b.resetTime) : undefined
  const id = b.bucketId ?? b.displayName ?? b.window ?? `window-${i + 1}`
  return {
    id,
    utilization: Math.max(0, Math.min(1, 1 - remaining)),
    ...(resetAt !== undefined && Number.isFinite(resetAt) ? { resetAtMs: resetAt } : {}),
  }
}

/** Convert a quota summary to a canonical session view. */
export function antigravitySessionInfoFromQuota(
  response: QuotaSummaryResponse,
  modelLabel?: string,
): ProviderSessionInfo {
  const windows: QuotaWindow[] = []
  for (const group of response.groups ?? []) {
    const buckets = group.buckets ?? []
    buckets.forEach((_, i) => {
      const w = toWindow(buckets, i)
      if (w) windows.push(w)
    })
  }
  return {
    ...(modelLabel ? { modelLabel } : {}),
    ...(windows.length > 0 ? { quota: { windows } } : {}),
  }
}

/** Read the cached plan quota. No network call. */
export function fetchAntigravitySessionInfo(): ProviderSessionInfo | undefined {
  return quotaCache?.info
}

/**
 * Background probe: fill the quota cache from the backend.
 * Never throws. A 401 or 403 leaves the cache as it is, and the host refreshes
 * the token on the next inference call.
 */
export async function primeAntigravitySessionInfo(
  ctx: ProviderSessionContext,
  auth?: ProviderAuth,
): Promise<void> {
  if (ctx.signal?.aborted) return
  const now = Date.now()
  if (quotaCache && now - quotaCache.at < QUOTA_TTL_MS) return
  const token = auth?.kind === "oauth" ? auth.token : auth?.kind === "api-key" ? auth.key : ""
  if (!token) return
  try {
    const response = await fetchQuotaSummary({
      token,
      networkClient: ctx.networkClient as NetworkClient | undefined,
      signal: ctx.signal,
      nowMs: now,
    })
    quotaCache = { at: now, info: antigravitySessionInfoFromQuota(response) }
  } catch {
    // A quota probe never breaks a session.
  }
}
