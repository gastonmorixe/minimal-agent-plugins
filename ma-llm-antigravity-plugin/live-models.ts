/**
 * Live catalog and bootstrap for the Antigravity backend.
 *
 * All traffic goes to `daily-cloudcode-pa.googleapis.com`, and only on these
 * two paths:
 *
 * 1. `POST /v1internal:loadCodeAssist` gives the project id and the tier.
 * 2. `POST /v1internal:fetchAvailableModels` gives the model catalog.
 *
 * No telemetry path is called: no `play.googleapis.com/log`, no
 * `aicode.googleapis.com` config poll, no trajectory or ACL write, no
 * `setUserSettings`, no updater.
 *
 * The catalog is cached for 60 s per (token, project) pair, and the project id
 * is cached for the life of the process, because it changes only when the
 * account changes. The token part of a key is a sha256 of the full token.
 *
 * The live model list has the same rows as the static catalog: one row per
 * `groupedModels` family, then one row per id that is in no family.
 *
 * @module llm/providers/antigravity/live-models
 */

import { createHash } from "node:crypto"

import type { ProviderAuth } from "@minimal-agent/core/plugin-api/llm/provider-auth"
import type { LiveModelRow } from "@minimal-agent/core/plugin-api/llm/provider-plugin"
import type { NetworkClient } from "@minimal-agent/core/plugin-api/net/types"

// Cycle with account-plan.ts is safe: each side reads the other at call time.
import { fetchNetworkClient } from "./account-plan.ts"
import {
  antigravitySpecsFromCatalog,
  type CatalogGroupRow,
  clearAntigravityLiveFamilies,
  rememberAntigravityLiveCatalog,
} from "./models.ts"
import {
  ANTIGRAVITY_API_BASE,
  antigravityUserAgent,
  FETCH_MODELS_PATH,
  LOAD_CODE_ASSIST_PATH,
  QUOTA_PATH,
} from "./wire-constants.ts"

/** One `models[id]` row of `fetchAvailableModels`. */
export interface CatalogEntry {
  displayName?: string
  model?: string
  vertexModelId?: string
  apiProvider?: string
  modelProvider?: string
  maxTokens?: number
  maxOutputTokens?: number
  supportsImages?: boolean
  supportsVideo?: boolean
  supportsThinking?: boolean
  supportsAdaptiveThinking?: boolean
  thinkingLevel?: number
  recommended?: boolean
  tagTitle?: string
  tagDescription?: string
  toolFormatterType?: string
  quotaInfo?: { remainingFraction?: number; resetTime?: string }
  supportedMimeTypes?: Record<string, boolean>
}

/** Response of `fetchAvailableModels`. */
export interface FetchModelsResponse {
  models?: Record<string, CatalogEntry>
  defaultAgentModelId?: string
  tieredModelIds?: Record<string, string[]>
  commandModelIds?: string[]
  imageGenerationModelIds?: string[]
  webSearchModelIds?: string[]
  groupedModels?: Record<string, CatalogGroupRow>
}

/** Response of `loadCodeAssist`, reduced to what this plugin reads. */
export interface LoadCodeAssistResponse {
  cloudaicompanionProject?: string
  gcpManaged?: boolean
  currentTier?: { id?: string; name?: string; description?: string }
  paidTier?: { id?: string; name?: string }
  allowedTiers?: Array<{ id?: string; isDefault?: boolean }>
}

/** One row of the quota summary. */
export interface QuotaBucket {
  bucketId?: string
  displayName?: string
  window?: string
  resetTime?: string
  description?: string
  remainingFraction?: number
}

/** Reason a banked quota reset cannot be claimed yet (`v1internal`). */
export type QuotaSummaryBankedResetIneligibleReason =
  | "QUOTA_SUMMARY_BANKED_RESET_INELIGIBLE_REASON_UNSPECIFIED"
  | "QUOTA_SUMMARY_BANKED_RESET_INELIGIBLE_REASON_USAGE_BELOW_THRESHOLD"
  | (string & {})

/** One banked quota reset returned by `retrieveUserQuotaSummary` (`agy` 1.5.18+). */
export interface QuotaSummaryBankedReset {
  resetId?: string
  displayLabel?: string
  expireTime?: string
  claimable?: boolean
  ineligibleReason?: QuotaSummaryBankedResetIneligibleReason
  remainingCount?: number
  bucketIds?: string[]
}

/** Response of `retrieveUserQuotaSummary`. */
export interface QuotaSummaryResponse {
  description?: string
  groups?: Array<{
    displayName?: string
    description?: string
    buckets?: QuotaBucket[]
  }>
  bankedResets?: QuotaSummaryBankedReset[]
}

/** Input of one catalog or bootstrap call. */
export interface LiveModelsDeps {
  token?: string
  project?: string
  networkClient?: NetworkClient
  signal?: AbortSignal
  nowMs?: number
}

const CACHE_TTL_MS = 60_000

/** Cache of catalog responses, keyed by token hash and project. */
const catalogCache = new Map<string, { at: number; rows: FetchModelsResponse }>()

/** Project id per token hash. The value changes only with the account. */
const projectCache = new Map<string, string>()

/** Drop the catalog and project caches. Tests call this between cases. */
export function clearAntigravityLiveModelsCache(): void {
  catalogCache.clear()
  projectCache.clear()
  clearAntigravityLiveFamilies()
}

/**
 * Cache key of one token: a sha256 of the full token. A prefix is not a key:
 * every Google access token starts with the same `ya29.a0A` bytes, so two
 * accounts would share one project and one catalog.
 */
export function antigravityTokenKey(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

function cacheKey(token: string, project: string): string {
  return `${antigravityTokenKey(token)}:${project}`
}

/** Bearer token of a provider auth value, or null. */
export function antigravityBearer(auth: ProviderAuth): string | null {
  if (auth.kind === "oauth") return auth.token || null
  if (auth.kind === "api-key") return auth.key || null
  return null
}

function requireNetwork(deps: LiveModelsDeps): NetworkClient {
  if (!deps.networkClient) {
    throw new Error("antigravity: no network client for the backend call")
  }
  return deps.networkClient
}

/** POST one control-plane method and parse its JSON body. */
async function postControl<T>(
  deps: LiveModelsDeps,
  path: string,
  body: unknown,
  label: string,
): Promise<T> {
  const network = requireNetwork(deps)
  const token = deps.token ?? ""
  const response = await network.request({
    label,
    method: "POST",
    url: `${ANTIGRAVITY_API_BASE}${path}`,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": antigravityUserAgent(),
    },
    body: JSON.stringify(body),
    signal: deps.signal,
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`antigravity ${path} ${response.status}: ${text.slice(0, 400)}`)
  }
  return (await response.json()) as T
}

/**
 * Read the project id of the account. A consumer account gets
 * `aicode-consumers`; an enterprise account gets its own id.
 */
export async function loadCodeAssist(deps: LiveModelsDeps): Promise<LoadCodeAssistResponse> {
  const response = await postControl<LoadCodeAssistResponse>(
    deps,
    LOAD_CODE_ASSIST_PATH,
    { metadata: { ideType: "ANTIGRAVITY" } },
    "antigravity.loadCodeAssist",
  )
  if (!response.cloudaicompanionProject && response.currentTier?.id === undefined) {
    throw new Error(
      "antigravity: the account has no Antigravity tier; open the agy CLI once, then retry",
    )
  }
  return response
}

/** Resolve the project id, from a hint, the cache, or `loadCodeAssist`. */
export async function resolveProject(deps: LiveModelsDeps): Promise<string> {
  if (deps.project) return deps.project
  const token = deps.token ?? ""
  const cached = projectCache.get(antigravityTokenKey(token))
  if (cached) return cached
  const res = await loadCodeAssist(deps)
  const project = res.cloudaicompanionProject
  if (!project) {
    throw new Error(
      "antigravity: this account has no Cloud Code Assist project; open the agy CLI once to finish onboarding",
    )
  }
  projectCache.set(antigravityTokenKey(token), project)
  return project
}

/** Fetch the model catalog, with a 60 s cache. */
export async function fetchAntigravityCatalog(deps: LiveModelsDeps): Promise<FetchModelsResponse> {
  const project = await resolveProject(deps)
  const key = cacheKey(deps.token ?? "", project)
  const now = deps.nowMs ?? Date.now()
  const hit = catalogCache.get(key)
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.rows
  const rows = await postControl<FetchModelsResponse>(
    { ...deps, project },
    FETCH_MODELS_PATH,
    { project },
    "antigravity.fetchAvailableModels",
  )
  catalogCache.set(key, { at: now, rows })
  // A family that is new in this response registers as a family row later.
  rememberAntigravityLiveCatalog(rows)
  return rows
}

/** Read the quota summary. This call spends no inference quota. */
export async function fetchQuotaSummary(deps: LiveModelsDeps): Promise<QuotaSummaryResponse> {
  const project = await resolveProject(deps)
  return postControl<QuotaSummaryResponse>(
    { ...deps, project },
    QUOTA_PATH,
    { project },
    "antigravity.retrieveUserQuotaSummary",
  )
}

/**
 * Bootstrap the provider for one account: project id, then catalog.
 * Resolves the catalog rows and the default model id.
 */
export async function antigravityBootstrap(
  deps: LiveModelsDeps,
): Promise<{ project: string; response: FetchModelsResponse }> {
  const project = await resolveProject(deps)
  const response = await fetchAntigravityCatalog({ ...deps, project })
  return { project, response }
}

/**
 * Live rows of one catalog response: one row per family (`gemini-4-neon`),
 * then one row per id that is in no family. These are the same ids that the
 * static catalog registers, so a picked row always resolves.
 */
export function antigravityLiveRows(response: FetchModelsResponse): LiveModelRow[] {
  const models = response.models ?? {}
  return antigravitySpecsFromCatalog(response).map((spec) => {
    const wireId = spec.vendorIds?.model ?? spec.id
    const reset = models[wireId]?.quotaInfo?.resetTime
    return {
      id: spec.id,
      displayName: spec.displayName,
      createdAt: reset ? reset.slice(0, 10) : undefined,
    }
  })
}

/** Options of {@link listAntigravityLiveModels}. Tests give a client. */
export interface ListLiveModelsOptions {
  /** Transport. The default is the global-fetch client of `account-plan.ts`. */
  networkClient?: NetworkClient
  /** Sink for the error of a failed list. The host hook gives none. */
  debug?: (message: string) => void
  signal?: AbortSignal
}

/**
 * Live model rows for `--list-models`. Never throws on a network fault: the
 * host falls back to the static snapshot. A 401 or 403 still throws, so the
 * host can refresh the token.
 *
 * The host hook `listLiveModels(auth)` gives no network client. Thus the
 * default transport is `fetchNetworkClient`, the same one that the account
 * plan probe uses. It sends only `loadCodeAssist` and `fetchAvailableModels`.
 */
export async function listAntigravityLiveModels(
  auth: ProviderAuth,
  opts: ListLiveModelsOptions = {},
): Promise<LiveModelRow[]> {
  const token = antigravityBearer(auth)
  if (!token) throw new Error("antigravity: no access token for the model list")
  try {
    const response = await fetchAntigravityCatalog({
      token,
      networkClient: opts.networkClient ?? fetchNetworkClient,
      signal: opts.signal,
    })
    return antigravityLiveRows(response)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/\b(401|403)\b/.test(message)) throw err
    opts.debug?.(`antigravity live model list failed: ${message.slice(0, 200)}`)
    return []
  }
}
