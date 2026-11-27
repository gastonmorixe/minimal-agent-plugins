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

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type { ProviderAuth } from "@minimal-agent/core/plugin-api/llm/provider-auth"
import type { NetworkClient } from "@minimal-agent/core/plugin-api/net/types"
import { parseJsonc } from "@minimal-agent/core/plugin-api/utils/jsonc"

// Cycle with account-plan.ts is safe: each side reads the other at call time.
import { fetchNetworkClient } from "./account-plan.ts"
import { type AntigravitySecrets, isExpired, readAntigravitySecrets } from "./auth.ts"
import type {
  ProviderSessionContext,
  ProviderSessionInfo,
  QuotaWindow,
} from "./lib/provider-plugin.ts"
import { fetchQuotaSummary, type QuotaSummaryResponse } from "./live-models.ts"
import { refreshTokens } from "./oauth-login.ts"
import { ANTIGRAVITY_CREDENTIAL_NAME, ANTIGRAVITY_SERVICE_ID } from "./wire-constants.ts"

/** Accumulated usage of this process. */
let sessionUsage: { inputTokens: number; outputTokens: number; at: number } | null = null

/** Cached plan quota. */
let quotaCache: { at: number; info: ProviderSessionInfo } | null = null

/** Single-flight guard for concurrent cold-start probes. */
let inFlightPrime: Promise<void> | null = null

/** Cache lifetime of the quota probe. */
const QUOTA_TTL_MS = 60_000

/** Upper bound on a cold-start quota probe. */
const PRIME_TIMEOUT_MS = 15_000

interface StoredAuthEntry {
  id?: string
  name?: string
  secrets?: Record<string, string>
}

interface StoredAuthFile {
  entries?: StoredAuthEntry[]
}

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
  inFlightPrime = null
}

/** Resolve the host auth store path. */
function authStorePath(): string {
  const override = process.env.MINIMAL_AGENT_AUTH_FILE?.trim()
  if (override) return override
  const home = process.env.MINIMAL_AGENT_HOME?.trim() || join(homedir(), ".minimal-agent")
  return join(home, "auth.jsonc")
}

/** Read one stored Antigravity OAuth credential from `auth.jsonc`. */
function readStoredSecrets(credentialName?: string): AntigravitySecrets | null {
  try {
    const raw = readFileSync(authStorePath(), "utf8")
    const parsed = parseJsonc(raw) as StoredAuthFile | null
    const entries = (parsed?.entries ?? []).filter((e) => e.id === ANTIGRAVITY_SERVICE_ID)
    if (entries.length === 0) return null
    const selected = credentialName
      ? entries.find((e) => e.name === credentialName)
      : (entries.find((e) => e.name === ANTIGRAVITY_CREDENTIAL_NAME) ?? entries[0])
    if (!selected?.secrets) return null
    return readAntigravitySecrets(selected.secrets)
  } catch {
    return null
  }
}

/** Combine an optional caller abort signal with the cold-start timeout. */
function primeSignal(caller?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(PRIME_TIMEOUT_MS)
  return caller ? AbortSignal.any([caller, timeout]) : timeout
}

/** Resolve token and optional project for the cold-start quota probe. */
async function resolvePrimeTarget(
  ctx: ProviderSessionContext,
  auth: ProviderAuth | undefined,
  networkClient: NetworkClient,
  signal: AbortSignal,
  now: number,
): Promise<{ token: string; project?: string } | null> {
  if (auth) {
    const token = auth.kind === "oauth" ? auth.token : auth.kind === "api-key" ? auth.key : ""
    return token ? { token } : null
  }
  if (ctx.authKind === "api-key") return null
  const secrets = readStoredSecrets(ctx.credentialName)
  if (!secrets) return null
  if (!isExpired(secrets, now)) {
    return { token: secrets.accessToken, ...(secrets.project ? { project: secrets.project } : {}) }
  }
  const refreshed = await refreshTokens({
    refreshToken: secrets.refreshToken,
    networkClient,
    signal,
  })
  return {
    token: refreshed.accessToken,
    ...(secrets.project ? { project: secrets.project } : {}),
  }
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
 * Never throws. Resolves the stored OAuth credential when `auth` is omitted,
 * deduplicates concurrent probes, and falls back to `fetchNetworkClient`.
 */
export async function primeAntigravitySessionInfo(
  ctx: ProviderSessionContext,
  auth?: ProviderAuth,
): Promise<void> {
  if (ctx.signal?.aborted) return
  const now = Date.now()
  if (quotaCache && now - quotaCache.at < QUOTA_TTL_MS) return
  if (inFlightPrime) return inFlightPrime

  const run = (async () => {
    const networkClient = (ctx.networkClient as NetworkClient | undefined) ?? fetchNetworkClient
    const signal = primeSignal(ctx.signal)
    try {
      const target = await resolvePrimeTarget(ctx, auth, networkClient, signal, now)
      if (!target) return
      const response = await fetchQuotaSummary({
        token: target.token,
        ...(target.project ? { project: target.project } : {}),
        networkClient,
        signal,
        nowMs: now,
      })
      quotaCache = { at: Date.now(), info: antigravitySessionInfoFromQuota(response) }
    } catch {
      // A quota probe never breaks a session.
    }
  })()

  inFlightPrime = run
  try {
    await run
  } finally {
    if (inFlightPrime === run) inFlightPrime = null
  }
}
