/**
 * Cursor session metadata for the quota footer.
 *
 * {@link fetchCursorSessionInfo} is cache-only. {@link primeCursorSessionInfo}
 * warms the cache from DashboardService/GetCurrentPeriodUsage (JSON Connect).
 * After each AgentService/Run, {@link scheduleCursorQuotaRefresh} re-fetches
 * so the bar moves without waiting for the 5-minute heartbeat.
 *
 * Window ids match Grok: `month` (included cents) and `ondemand` (extra cap).
 * `displayMessage` is not parsed. Enterprise falls back to `GET /auth/usage`
 * only when `planUsage.limit` is missing.
 *
 * @module llm/providers/cursor/session-info
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { CURSOR_API_KEY_AUTH, exchangeCursorApiKey } from "./auth.ts"
import { authUsageUrl, currentPeriodUsageUrl } from "./connect/hosts.ts"
import { buildCursorHeaders } from "./headers.ts"
import { loadClientIds } from "./ids.ts"
import { parseJsonc } from "./lib/jsonc.ts"
import type { NetworkClient } from "./lib/net-types.ts"
import type {
  ProviderSessionContext,
  ProviderSessionInfo,
  QuotaSnapshot,
  QuotaWindow,
} from "./lib/provider-plugin.ts"
import { CURSOR_OAUTH } from "./oauth-login.ts"

const FRESHNESS_MS = 5 * 60_000
/** Skip a post-turn refresh when the last successful probe is newer than this. */
const POST_TURN_MIN_INTERVAL_MS = 30_000
const PROBE_TIMEOUT_MS = 15_000

export type CursorPlanUsage = {
  includedSpend?: number
  limit?: number
  remaining?: number
}

export type CursorSpendLimitUsage = {
  individualLimit?: number
  individualRemaining?: number
  individualUsed?: number
}

/** Connect JSON body for GetCurrentPeriodUsage (camelCase). */
export type CursorPeriodUsageResponse = {
  billingCycleEnd?: string | number
  planUsage?: CursorPlanUsage
  spendLimitUsage?: CursorSpendLimitUsage
}

export type CursorAuthUsageBucket = {
  numRequests?: number
  maxRequestUsage?: number | null
}

type CachedQuota = {
  snapshot: QuotaSnapshot
  at: number
}

let cache: CachedQuota | null = null
let inFlightPrime: Promise<void> | null = null
let inFlightRefresh: Promise<void> | null = null

/** Test helper: drop the in-memory period-usage cache. */
export function clearCursorQuotaCache(): void {
  cache = null
}

/** Test helper: drop the in-flight prime latch. */
export function _resetCursorPrimeInFlight(): void {
  inFlightPrime = null
}

/** Latest cached snapshot (tests). */
export function getCursorQuotaCache(): CachedQuota | null {
  return cache
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function clamp01(value: number): number {
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function cycleEndMs(raw: string | number | undefined): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw
  if (typeof raw !== "string" || raw.trim() === "") return undefined
  if (/^\d+$/.test(raw.trim())) return Number(raw)
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

function addOneUtcMonth(ms: number): number {
  const date = new Date(ms)
  date.setUTCMonth(date.getUTCMonth() + 1)
  return date.getTime()
}

/**
 * Map GetCurrentPeriodUsage JSON to footer windows.
 *
 * `month` uses includedSpend/limit (not totalPercentUsed / displayMessage).
 * `ondemand` only when individualLimit is greater than 0.
 */
export function parseCursorPeriodUsage(body: CursorPeriodUsageResponse): QuotaSnapshot {
  const windows: QuotaWindow[] = []
  const resetAtMs = cycleEndMs(body.billingCycleEnd)
  const plan = body.planUsage
  const limit = num(plan?.limit)
  let included = num(plan?.includedSpend)
  if (included == null && limit != null && limit > 0) {
    const remaining = num(plan?.remaining)
    if (remaining != null) included = limit - remaining
  }
  if (limit != null && limit > 0 && included != null) {
    windows.push({
      id: "month",
      utilization: clamp01(included / limit),
      ...(resetAtMs != null ? { resetAtMs } : {}),
    })
  }

  const spend = body.spendLimitUsage
  const odLimit = num(spend?.individualLimit)
  if (odLimit != null && odLimit > 0) {
    const remaining = num(spend?.individualRemaining)
    const used = num(spend?.individualUsed)
    let utilization = 0
    if (used != null) utilization = clamp01(used / odLimit)
    else if (remaining != null) utilization = clamp01(1 - remaining / odLimit)
    windows.push({
      id: "ondemand",
      utilization,
      ...(resetAtMs != null ? { resetAtMs } : {}),
    })
  }

  const overage = odLimit != null && odLimit > 0 ? { active: true } : undefined
  return overage ? { windows, overage } : { windows }
}

/**
 * Map legacy `/auth/usage` buckets to a `req` window when maxRequestUsage is set.
 */
export function parseCursorAuthUsage(
  body: Record<string, unknown>,
  preferredKey = "gpt-4",
): QuotaSnapshot {
  const windows: QuotaWindow[] = []
  const startRaw = body.startOfMonth
  const startMs = typeof startRaw === "string" ? Date.parse(startRaw) : num(startRaw)
  const resetAtMs =
    startMs != null && Number.isFinite(startMs) ? addOneUtcMonth(startMs) : undefined

  const pickBucket = (): CursorAuthUsageBucket | undefined => {
    const preferred = body[preferredKey]
    if (preferred && typeof preferred === "object" && !Array.isArray(preferred)) {
      return preferred as CursorAuthUsageBucket
    }
    for (const value of Object.values(body)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue
      const bucket = value as CursorAuthUsageBucket
      if (num(bucket.maxRequestUsage) != null) return bucket
    }
    return undefined
  }

  const bucket = pickBucket()
  const maxReq = num(bucket?.maxRequestUsage)
  const used = num(bucket?.numRequests)
  if (maxReq != null && maxReq > 0 && used != null) {
    windows.push({
      id: "req",
      utilization: clamp01(used / maxReq),
      ...(resetAtMs != null ? { resetAtMs } : {}),
    })
  }
  return { windows }
}

function applySnapshot(snapshot: QuotaSnapshot): void {
  cache = { snapshot, at: Date.now() }
}

function jsonHeaders(
  token: string,
  ids: Awaited<ReturnType<typeof loadClientIds>>,
): Record<string, string> {
  const headers = buildCursorHeaders({ token, ids, streaming: false, clientType: "cli" })
  headers.accept = "application/json"
  headers["content-type"] = "application/json"
  return headers
}

async function readBody(
  networkClient: NetworkClient | undefined,
  input: {
    method: "GET" | "POST"
    url: string
    headers: Record<string, string>
    body?: string
    signal?: AbortSignal
  },
): Promise<{ ok: boolean; text: string }> {
  if (networkClient) {
    const response = await networkClient.request({
      label: "cursor.quota",
      method: input.method,
      url: input.url,
      headers: input.headers,
      ...(input.body != null ? { body: input.body } : {}),
      signal: input.signal,
      timeoutMs: PROBE_TIMEOUT_MS,
    })
    return { ok: response.ok, text: await response.text() }
  }
  const response = await fetch(input.url, {
    method: input.method,
    headers: input.headers,
    body: input.method === "GET" ? undefined : input.body,
    signal: input.signal,
  })
  return { ok: response.ok, text: await response.text() }
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * Fetch GetCurrentPeriodUsage (and `/auth/usage` if included limit is absent).
 * Never throws.
 */
export async function refreshCursorPeriodUsage(
  token: string,
  options: { networkClient?: NetworkClient; signal?: AbortSignal } = {},
): Promise<void> {
  try {
    const ids = await loadClientIds()
    const headers = jsonHeaders(token, ids)
    const probeSignal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)])
      : AbortSignal.timeout(PROBE_TIMEOUT_MS)
    const period = await readBody(options.networkClient, {
      method: "POST",
      url: currentPeriodUsageUrl(),
      headers,
      body: "{}",
      signal: probeSignal,
    })
    if (period.ok) {
      const parsed = parseJsonObject(period.text)
      if (parsed) {
        const snapshot = parseCursorPeriodUsage(parsed as CursorPeriodUsageResponse)
        if (snapshot.windows.some((window) => window.id === "month")) {
          applySnapshot(snapshot)
          return
        }
      }
    }
    const legacy = await readBody(options.networkClient, {
      method: "GET",
      url: authUsageUrl(),
      headers,
      signal: probeSignal,
    })
    if (!legacy.ok) return
    const parsed = parseJsonObject(legacy.text)
    if (!parsed) return
    const snapshot = parseCursorAuthUsage(parsed)
    if (snapshot.windows.length > 0) applySnapshot(snapshot)
  } catch {
    // best-effort
  }
}

/**
 * Fire-and-forget post-turn refresh. Dedupes in-flight work and skips when
 * the cache was written in the last {@link POST_TURN_MIN_INTERVAL_MS}.
 */
export function scheduleCursorQuotaRefresh(token: string, networkClient?: NetworkClient): void {
  if (!token) return
  if (cache && Date.now() - cache.at < POST_TURN_MIN_INTERVAL_MS) return
  if (inFlightRefresh) return
  const work = refreshCursorPeriodUsage(token, { networkClient }).finally(() => {
    if (inFlightRefresh === work) inFlightRefresh = null
  })
  inFlightRefresh = work
}

type StoreEntry = {
  id?: string
  name?: string
  secrets?: Record<string, unknown>
}

function readAuthStoreEntries(): StoreEntry[] {
  try {
    const home = process.env.MINIMAL_AGENT_HOME?.trim() || join(homedir(), ".minimal-agent")
    const path = join(home, "auth.jsonc")
    if (!existsSync(path)) return []
    const data = parseJsonc(readFileSync(path, "utf8")) as { entries?: StoreEntry[] }
    return data.entries ?? []
  } catch {
    return []
  }
}

function oauthTokenFromStore(credentialName?: string): string | null {
  const entries = readAuthStoreEntries().filter((entry) => entry.id === CURSOR_OAUTH.serviceId)
  const entry = credentialName
    ? entries.find((item) => item.name === credentialName)
    : (entries.find((item) => item.name === CURSOR_OAUTH.displayName) ?? entries[0])
  const token = entry?.secrets?.accessToken
  return typeof token === "string" && token.length > 0 ? token : null
}

function apiKeyFromStore(credentialName?: string): string | null {
  const entries = readAuthStoreEntries().filter(
    (entry) => entry.id === CURSOR_API_KEY_AUTH.serviceId,
  )
  const entry = credentialName
    ? entries.find((item) => item.name === credentialName)
    : (entries.find((item) => item.name === CURSOR_API_KEY_AUTH.displayName) ?? entries[0])
  const key = entry?.secrets?.apiKey
  return typeof key === "string" && key.length > 0 ? key : null
}

async function resolvePrimeToken(ctx: ProviderSessionContext): Promise<string | null> {
  const oauth = oauthTokenFromStore(ctx.credentialName)
  const apiKey = apiKeyFromStore(ctx.credentialName)

  if (ctx.authKind === "oauth") return oauth
  if (ctx.authKind === "api-key") {
    if (!apiKey) return null
    try {
      return (
        await exchangeCursorApiKey(apiKey, { networkClient: ctx.networkClient as NetworkClient })
      ).accessToken
    } catch {
      return null
    }
  }
  if (ctx.credentialName) {
    if (oauth) return oauth
    if (!apiKey) return null
    try {
      return (
        await exchangeCursorApiKey(apiKey, { networkClient: ctx.networkClient as NetworkClient })
      ).accessToken
    } catch {
      return null
    }
  }
  if (oauth) return oauth
  if (!apiKey) return null
  try {
    return (
      await exchangeCursorApiKey(apiKey, { networkClient: ctx.networkClient as NetworkClient })
    ).accessToken
  } catch {
    return null
  }
}

function cacheIsFresh(): boolean {
  return Boolean(cache && Date.now() - cache.at < FRESHNESS_MS)
}

/**
 * Cache-only session metadata. Never blocks on network. Host fills
 * contextWindow / modelLabel when omitted.
 */
export async function fetchCursorSessionInfo(
  ctx: ProviderSessionContext,
): Promise<ProviderSessionInfo | null> {
  if (ctx.signal?.aborted) return {}
  if (cache && !cacheIsFresh()) {
    void primeCursorSessionInfo(ctx).catch(() => undefined)
  }
  if (!cache) return {}
  return { quota: cache.snapshot }
}

/**
 * Cold-start probe. Never throws. Concurrent callers share one in-flight promise.
 */
export function primeCursorSessionInfo(ctx: ProviderSessionContext): Promise<void> {
  if (inFlightPrime) return inFlightPrime
  if (cacheIsFresh()) return Promise.resolve()

  const work = (async () => {
    const token = await resolvePrimeToken(ctx)
    if (!token) return
    await refreshCursorPeriodUsage(token, {
      networkClient: ctx.networkClient as NetworkClient | undefined,
      signal: ctx.signal,
    })
  })().catch(() => undefined)

  inFlightPrime = work.finally(() => {
    if (inFlightPrime === work) inFlightPrime = null
  })
  return inFlightPrime
}
