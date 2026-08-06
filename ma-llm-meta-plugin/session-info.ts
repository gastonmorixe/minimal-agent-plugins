/**
 * Meta session metadata for the status-bar / quota footer.
 *
 * Meta Model API returns OpenAI-style `x-ratelimit-*` headers on every
 * successful call (observed 2026-08-05: 3000 RPM / 4M TPM for standard SKUs;
 * contributor SKU is lower). We capture those in the adapter and expose them
 * as `req` / `tok` quota windows. No separate billing GraphQL from the plugin.
 *
 * @module llm/providers/meta/session-info
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
import { metaContextWindow, metaModelShortLabel } from "./models.ts"
import { CHAT_COMPLETIONS_URL, META_DEFAULT_HEADERS, META_USER_AGENT } from "./wire-constants.ts"

const HEADER_FRESHNESS_MS = 5 * 60_000

export interface CachedMetaRateLimits {
  rateLimits: ReadonlyMap<string, string>
  at: number
}

let headerCache: { rateLimits: Map<string, string>; at: number } | null = null
let sessionUsage: {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  at: number
} | null = null

/** Copy rate-limit headers from a successful response (non-throwing). */
export function setMetaRateLimits(headers: Headers): void {
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
export function accumulateMetaUsage(usage: {
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

/** Cached rate-limit header snapshot (test / status-bar). */
export function getMetaRateLimits(): CachedMetaRateLimits | null {
  return headerCache
}

/** Accumulated per-session token usage from chat streams. */
export function getMetaSessionUsage(): typeof sessionUsage {
  return sessionUsage
}

/** Reset caches (tests). */
export function clearMetaRateLimits(): void {
  headerCache = null
  sessionUsage = null
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

/** Build neutral QuotaWindows from x-ratelimit-* headers. */
export function parseMetaQuotaWindows(rl: ReadonlyMap<string, string>): QuotaWindow[] {
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

/**
 * Resolve session metadata for the status bar (cache-only, no network).
 * Never throws.
 */
export async function fetchMetaSessionInfo(
  ctx: ProviderSessionContext,
): Promise<ProviderSessionInfo | null> {
  if (ctx.signal?.aborted) return {}

  const contextWindow = metaContextWindow(ctx.modelId)
  const modelLabel = metaModelShortLabel(ctx.modelId)

  const cached = getMetaRateLimits()
  const rl = cached && Date.now() - cached.at < HEADER_FRESHNESS_MS ? cached.rateLimits : null
  const windows = rl ? parseMetaQuotaWindows(rl) : []
  const quota = windows.length > 0 ? { windows } : undefined

  return {
    contextWindow,
    modelLabel,
    quota,
  }
}

let inFlightPrime: Promise<void> | null = null

/** Test-only: clear the in-flight prime promise. */
export function _resetMetaPrimeInFlight(): void {
  inFlightPrime = null
}

/**
 * Best-effort API key from env or host auth store for cold-start priming.
 * Same pattern as ClinePass/Grok (plugins cannot import host getAuth).
 */
export function readMetaApiKeyFromEnvOrStore(credentialName?: string): string | null {
  const fromEnv =
    process.env["MINIMAL_AGENT_META_API_KEY"]?.trim() ||
    process.env["MODEL_API_KEY"]?.trim() ||
    process.env["META_API_KEY"]?.trim() ||
    ""
  if (fromEnv) return fromEnv

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
      entries?: Array<{ id?: string; name?: string; secrets?: { apiKey?: unknown } }>
    }
    const entries = (data.entries ?? []).filter((e) => e?.id === "meta-api-key")
    const entry = credentialName
      ? entries.find((e) => e?.name === credentialName)
      : (entries.find((e) => e?.name === "Meta Model API Key") ?? entries[0])
    const key = entry?.secrets?.apiKey
    return typeof key === "string" && key.length > 0 ? key : null
  } catch {
    return null
  }
}

/**
 * Warm rate-limit headers with a tiny non-stream chat completion.
 * Never throws. Self-deduplicates concurrent callers.
 */
export function primeMetaSessionInfo(ctx: ProviderSessionContext): Promise<void> {
  if (inFlightPrime) return inFlightPrime

  const work = (async () => {
    if (headerCache && Date.now() - headerCache.at < HEADER_FRESHNESS_MS) return

    const apiKey = readMetaApiKeyFromEnvOrStore(ctx.credentialName)
    if (!apiKey) return

    const networkClient = ctx.networkClient as NetworkClient | undefined
    const probeSignal: AbortSignal = ctx.signal
      ? AbortSignal.any([ctx.signal, AbortSignal.timeout(20_000)])
      : AbortSignal.timeout(20_000)

    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      "user-agent": META_USER_AGENT,
      ...META_DEFAULT_HEADERS,
    }
    const body = JSON.stringify({
      model: ctx.modelId || "muse-spark-1.2",
      messages: [{ role: "user", content: "." }],
      max_completion_tokens: 1,
      stream: false,
      reasoning_effort: "minimal",
    })

    try {
      if (networkClient) {
        const response = await networkClient.request({
          label: "meta.session.prime",
          method: "POST",
          url: CHAT_COMPLETIONS_URL,
          headers,
          body,
          signal: probeSignal,
        })
        if (response.ok) setMetaRateLimits(response.headers)
      } else {
        const response = await fetch(CHAT_COMPLETIONS_URL, {
          method: "POST",
          headers,
          body,
          signal: probeSignal,
        })
        if (response.ok) setMetaRateLimits(response.headers)
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
