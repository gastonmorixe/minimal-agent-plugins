/**
 * ClinePass session metadata for the status-bar / quota footer.
 *
 * ClinePass chat responses do **not** carry `x-ratelimit-*` headers. Quota is a
 * subscription cost budget with three rolling windows (5h / 7d / 30d), defined
 * on the plan as `inferenceCapThreshold` and measured by summing `costUsd` on
 * `/api/v1/users/{uid}/usages` (micro-USD integers: 1e6 = $1).
 *
 * Data path (Judy + Evelyn, 2026-07-15):
 * 1. {@link primeClinepassSessionInfo} fetches plan caps + usages, builds
 *    neutral windows, caches them.
 * 2. {@link fetchClinepassSessionInfo} is cache-only and returns
 *    `quota.windows` with ids `5h` / `7d` / `30d` for `formatQuotaWindows`.
 * 3. Optional header capture via {@link setClinepassRateLimits} remains as a
 *    fallback if the gateway ever starts emitting rate-limit headers.
 *
 * @module llm/providers/clinepass/session-info
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
import { clinepassContextWindow, clinepassModelShortLabel } from "./models.ts"
import { formatClinepassBearerToken } from "./oauth-login.ts"
import { CLINE_ACCOUNT, CLINEPASS_DEFAULT_HEADERS, CLINEPASS_USER_AGENT } from "./wire-constants.ts"

/** How long a rate-limit header snapshot stays fresh. */
const HEADER_FRESHNESS_MS = 5 * 60_000
/** How long a Pass window snapshot stays fresh before re-priming. */
const PASS_FRESHNESS_MS = 5 * 60_000
/** Max usage pages to walk (each page up to 100 items). */
const MAX_USAGE_PAGES = 20
const USAGE_PAGE_LIMIT = 100

export interface CachedClinepassRateLimits {
  rateLimits: ReadonlyMap<string, string>
  at: number
}

export interface PassQuotaSnapshot {
  windows: QuotaWindow[]
  /** Plan display name when known. */
  planLabel?: string
  /** Summed micro-USD used in each window (diagnostics / tests). */
  usedMicro: { h5: number; d7: number; d30: number }
  capsMicro: { h5: number; d7: number; d30: number }
  at: number
}

let headerCache: { rateLimits: Map<string, string>; at: number } | null = null
let sessionUsage: {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  at: number
} | null = null
let passQuota: PassQuotaSnapshot | null = null

/** Copy rate-limit headers from a successful response (non-throwing). */
export function setClinepassRateLimits(headers: Headers): void {
  try {
    const copy = new Map<string, string>()
    headers.forEach((value, key) => {
      const lk = key.toLowerCase()
      if (lk.startsWith("x-ratelimit-")) copy.set(lk, value)
    })
    if (copy.size === 0) return
    headerCache = { rateLimits: copy, at: Date.now() }
  } catch {
    // best-effort
  }
}

/** Accumulate token usage from a completed stream. */
export function accumulateClinepassUsage(usage: {
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

/** Cached ClinePass rate-limit header snapshot (test / status-bar). */
export function getClinepassRateLimits(): CachedClinepassRateLimits | null {
  return headerCache
}

/** Accumulated per-session token usage from chat streams. */
export function getClinepassSessionUsage(): typeof sessionUsage {
  return sessionUsage
}

/** Cached Pass subscription quota windows (5h / 7d / 30d). */
export function getClinepassPassQuota(): PassQuotaSnapshot | null {
  return passQuota
}

/** Reset header, session-usage, and Pass quota caches (tests). */
export function clearClinepassRateLimits(): void {
  headerCache = null
  sessionUsage = null
  passQuota = null
}

function parseResetMs(s: string): number | undefined {
  if (typeof s !== "string") return undefined
  const trimmed = s.trim()
  if (!trimmed) return undefined
  const unitMs: Record<string, number> = {
    ns: 1e-6,
    us: 1e-3,
    µs: 1e-3,
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
  }
  const re = /(\d+(?:\.\d+)?)(ms|us|µs|ns|h|m|s)/y
  let total = 0
  let pos = 0
  while (pos < trimmed.length) {
    re.lastIndex = pos
    const m = re.exec(trimmed)
    if (!m) return undefined
    const value = Number(m[1])
    if (!Number.isFinite(value)) return undefined
    total += value * unitMs[m[2]!]!
    pos = re.lastIndex
  }
  return total
}

/** Build neutral QuotaWindows from x-ratelimit-* headers (fallback path). */
export function parseClinepassQuotaWindows(rl: ReadonlyMap<string, string>): QuotaWindow[] {
  const now = Date.now()
  const out: QuotaWindow[] = []
  const build = (id: string, limitKey: string, remainingKey: string, resetKey: string): void => {
    const limit = Number(rl.get(limitKey))
    const remaining = Number(rl.get(remainingKey))
    if (!Number.isFinite(limit) || limit <= 0) return
    if (!Number.isFinite(remaining)) return
    let utilization = 1 - remaining / limit
    if (utilization < 0) utilization = 0
    if (utilization > 1) utilization = 1
    const resetMs = parseResetMs(rl.get(resetKey) ?? "")
    const resetAtMs = resetMs == null ? undefined : now + resetMs
    out.push({ id, utilization, resetAtMs })
  }
  build(
    "req",
    "x-ratelimit-limit-requests",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-reset-requests",
  )
  build(
    "tok",
    "x-ratelimit-limit-tokens",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset-tokens",
  )
  return out
}

export interface UsageTxn {
  costUsd: number
  createdAtMs: number
}

export interface PassCaps {
  h5: number
  d7: number
  d30: number
}

/**
 * Sum micro-USD costs into 5h / 7d / 30d rolling windows and map to
 * {@link QuotaWindow}s. Pure; exported for unit tests.
 *
 * `costUsd` and caps are the same micro-USD integer scale (1e6 = $1).
 * `resetAtMs` is the end of each rolling window from `now` (now + duration).
 */
export function buildPassQuotaWindows(
  txns: readonly UsageTxn[],
  caps: PassCaps,
  nowMs: number = Date.now(),
): {
  windows: QuotaWindow[]
  usedMicro: { h5: number; d7: number; d30: number }
} {
  const cut5 = nowMs - 5 * 3_600_000
  const cut7 = nowMs - 7 * 86_400_000
  const cut30 = nowMs - 30 * 86_400_000
  let h5 = 0
  let d7 = 0
  let d30 = 0
  for (const t of txns) {
    if (!Number.isFinite(t.costUsd) || t.costUsd <= 0) continue
    if (t.createdAtMs >= cut30) d30 += t.costUsd
    if (t.createdAtMs >= cut7) d7 += t.costUsd
    if (t.createdAtMs >= cut5) h5 += t.costUsd
  }

  const clampUtil = (used: number, cap: number): number | undefined => {
    if (!Number.isFinite(cap) || cap <= 0) return undefined
    let u = used / cap
    if (u < 0) u = 0
    if (u > 1) u = 1
    return u
  }

  const windows: QuotaWindow[] = []
  const u5 = clampUtil(h5, caps.h5)
  if (u5 != null) windows.push({ id: "5h", utilization: u5, resetAtMs: nowMs + 5 * 3_600_000 })
  const u7 = clampUtil(d7, caps.d7)
  if (u7 != null) windows.push({ id: "7d", utilization: u7, resetAtMs: nowMs + 7 * 86_400_000 })
  const u30 = clampUtil(d30, caps.d30)
  if (u30 != null) windows.push({ id: "30d", utilization: u30, resetAtMs: nowMs + 30 * 86_400_000 })

  return { windows, usedMicro: { h5, d7, d30 } }
}

/**
 * Resolve session metadata for the status bar (cache-only, no network).
 * Prefer Pass subscription windows; fall back to header-derived req/tok.
 * Never throws.
 */
export async function fetchClinepassSessionInfo(
  ctx: ProviderSessionContext,
): Promise<ProviderSessionInfo | null> {
  if (ctx.signal?.aborted) return {}

  const contextWindow = clinepassContextWindow(ctx.modelId)
  const modelLabel = clinepassModelShortLabel(ctx.modelId)

  let windows: QuotaWindow[] = []
  if (passQuota && Date.now() - passQuota.at < PASS_FRESHNESS_MS) {
    windows = passQuota.windows
  } else {
    const cached = getClinepassRateLimits()
    const rl = cached && Date.now() - cached.at < HEADER_FRESHNESS_MS ? cached.rateLimits : null
    windows = rl ? parseClinepassQuotaWindows(rl) : []
  }
  const quota = windows.length > 0 ? { windows } : undefined

  return {
    contextWindow,
    modelLabel,
    quota,
  }
}

let inFlightPrime: Promise<void> | null = null

/** Test-only: clear the in-flight prime promise so a new prime can start. */
export function _resetClinepassPrimeInFlight(): void {
  inFlightPrime = null
}

interface ResolvedBearer {
  token: string
  kind: "api-key" | "oauth"
}

/**
 * Best-effort OAuth access token from the host auth store
 * (`~/.minimal-agent/auth.jsonc` or `$MINIMAL_AGENT_HOME/auth.jsonc`).
 * Same pattern as Grok's prime path (plugins cannot import host getAuth).
 */
export function readClinepassOAuthTokenFromAuthStore(): string | null {
  try {
    const home = process.env["MINIMAL_AGENT_HOME"]?.trim() || join(homedir(), ".minimal-agent")
    const path = join(home, "auth.jsonc")
    if (!existsSync(path)) return null
    const raw = readFileSync(path, "utf8")
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n\r]*/g, "$1")
      .replace(/,(\s*[}\]])/g, "$1")
    const data = JSON.parse(stripped) as {
      entries?: Array<{ id?: string; secrets?: { accessToken?: unknown } }>
    }
    const entry = data.entries?.find((e) => e?.id === "clinepass-oauth")
    const token = entry?.secrets?.accessToken
    return typeof token === "string" && token.length > 0 ? token : null
  } catch {
    return null
  }
}

function resolvePrimeBearer(): ResolvedBearer | null {
  const apiKey =
    process.env["MINIMAL_AGENT_CLINEPASS_API_KEY"]?.trim() ||
    process.env["CLINE_API_KEY"]?.trim() ||
    ""
  if (apiKey) return { kind: "api-key", token: apiKey }
  const oauth = readClinepassOAuthTokenFromAuthStore()
  if (oauth) return { kind: "oauth", token: formatClinepassBearerToken(oauth) }
  return null
}

function authHeaders(bearer: string): Record<string, string> {
  return {
    accept: "application/json",
    authorization: `Bearer ${bearer}`,
    "user-agent": CLINEPASS_USER_AGENT,
    ...CLINEPASS_DEFAULT_HEADERS,
  }
}

async function httpGetJson(
  url: string,
  bearer: string,
  signal: AbortSignal,
  networkClient: NetworkClient | undefined,
  label: string,
): Promise<unknown> {
  try {
    if (networkClient) {
      const response = await networkClient.request({
        label,
        method: "GET",
        url,
        headers: authHeaders(bearer),
        signal,
      })
      if (!response.ok) return null
      return await response.json()
    }
    const response = await fetch(url, { headers: authHeaders(bearer), signal })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

function unwrapData(json: unknown): Record<string, unknown> | null {
  if (!json || typeof json !== "object") return null
  const o = json as Record<string, unknown>
  if (o.data && typeof o.data === "object") return o.data as Record<string, unknown>
  return o
}

function parseIsoMs(s: unknown): number | null {
  if (typeof s !== "string" || !s) return null
  const ms = Date.parse(s)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Warm Pass quota windows from plan caps + usages ledger.
 * Never throws. Self-deduplicates concurrent callers.
 */
export function primeClinepassSessionInfo(ctx: ProviderSessionContext): Promise<void> {
  if (inFlightPrime) return inFlightPrime

  const work = (async () => {
    if (passQuota && Date.now() - passQuota.at < PASS_FRESHNESS_MS) return

    const cred = resolvePrimeBearer()
    if (!cred) return

    const networkClient = ctx.networkClient as NetworkClient | undefined
    const probeSignal: AbortSignal = ctx.signal
      ? AbortSignal.any([ctx.signal, AbortSignal.timeout(20_000)])
      : AbortSignal.timeout(20_000)

    try {
      // 1) Plan + me (user id) in parallel
      const [planJson, meJson] = await Promise.all([
        httpGetJson(
          CLINE_ACCOUNT.plan,
          cred.token,
          probeSignal,
          networkClient,
          "clinepass.plan.probe",
        ),
        httpGetJson(CLINE_ACCOUNT.me, cred.token, probeSignal, networkClient, "clinepass.me.probe"),
      ])

      const planData = unwrapData(planJson)
      const meData = unwrapData(meJson)
      const userId =
        (typeof meData?.id === "string" && meData.id) ||
        (typeof planData?.userId === "string" && planData.userId) ||
        null
      if (!userId) return

      const planObj =
        planData?.plan && typeof planData.plan === "object"
          ? (planData.plan as Record<string, unknown>)
          : null
      const planLabel =
        (typeof planObj?.displayName === "string" && planObj.displayName) ||
        (typeof planObj?.name === "string" && planObj.name) ||
        "ClinePass"

      const entitlements =
        planObj?.entitlements && typeof planObj.entitlements === "object"
          ? (planObj.entitlements as Record<string, unknown>)
          : null
      const clinePass =
        entitlements?.cline_pass && typeof entitlements.cline_pass === "object"
          ? (entitlements.cline_pass as Record<string, unknown>)
          : null
      const thresholds =
        clinePass?.inferenceCapThreshold && typeof clinePass.inferenceCapThreshold === "object"
          ? (clinePass.inferenceCapThreshold as Record<string, unknown>)
          : null

      const caps: PassCaps = {
        h5: Number(thresholds?.last5HoursUsageCostUSDPerUser) || 0,
        d7: Number(thresholds?.last7daysUsageCostUSDPerUser) || 0,
        d30: Number(thresholds?.last30daysUsageCostUSDPerUser) || 0,
      }
      if (caps.h5 <= 0 && caps.d7 <= 0 && caps.d30 <= 0) {
        // No Pass caps (maybe not subscribed); still cache empty so we don't thrash.
        passQuota = {
          windows: [],
          planLabel,
          usedMicro: { h5: 0, d7: 0, d30: 0 },
          capsMicro: caps,
          at: Date.now(),
        }
        return
      }

      // 2) Page usages newest-first until we cover 30d or pages run out.
      const nowMs = Date.now()
      const cutoff30 = nowMs - 30 * 86_400_000
      const txns: UsageTxn[] = []
      let nextToken = ""
      for (let page = 0; page < MAX_USAGE_PAGES; page++) {
        if (probeSignal.aborted) break
        const qs = new URLSearchParams({ limit: String(USAGE_PAGE_LIMIT) })
        if (nextToken) qs.set("nextToken", nextToken)
        const url = `${CLINE_ACCOUNT.usages(userId)}?${qs.toString()}`
        const usagesJson = await httpGetJson(
          url,
          cred.token,
          probeSignal,
          networkClient,
          "clinepass.usages.probe",
        )
        const usagesData = unwrapData(usagesJson)
        const items = Array.isArray(usagesData?.items) ? usagesData!.items : []
        let oldestOnPage = Number.POSITIVE_INFINITY
        for (const raw of items) {
          if (!raw || typeof raw !== "object") continue
          const row = raw as Record<string, unknown>
          const createdAtMs = parseIsoMs(row.createdAt)
          const costUsd = Number(row.costUsd)
          if (createdAtMs == null || !Number.isFinite(costUsd)) continue
          if (createdAtMs < oldestOnPage) oldestOnPage = createdAtMs
          if (createdAtMs >= cutoff30) {
            txns.push({ costUsd, createdAtMs })
          }
        }
        const nt = usagesData?.nextToken
        nextToken = typeof nt === "string" ? nt : ""
        // Stop when page is empty, no next page, or oldest item is already past 30d.
        if (items.length === 0 || !nextToken || oldestOnPage < cutoff30) break
      }

      const { windows, usedMicro } = buildPassQuotaWindows(txns, caps, nowMs)
      passQuota = {
        windows,
        planLabel,
        usedMicro,
        capsMicro: caps,
        at: Date.now(),
      }
    } catch {
      // soft-fail
    }
  })()

  inFlightPrime = work
  void work.finally(() => {
    if (inFlightPrime === work) inFlightPrime = null
  })

  return work
}
