/**
 * Antigravity account plan probe for `ProviderPlugin.fetchAccountPlan`.
 *
 * The probe reads three endpoints. All are reads, and none spends model quota:
 *
 * 1. `POST /v1internal:loadCodeAssist` gives the tier and the project.
 * 2. `POST /v1internal:retrieveUserQuotaSummary` gives the quota buckets.
 * 3. `GET https://www.googleapis.com/oauth2/v2/userinfo` gives the account id
 *    and the email.
 *
 * The probe sends no telemetry: no `recordTrajectoryAnalytics`, no
 * `setUserSettings`, no `writeTrajectoryAcls`, no `fetchConfig`, no
 * `listExperiments`, no `play.googleapis.com`.
 *
 * The host gives no network client to this hook (`AccountPlanContext` has only
 * `signal`). Thus the default transport is a small `NetworkClient` over the
 * global `fetch`, as the anthropic plugin does. Tests give their own client.
 *
 * Contract types are local mirrors: the plugins repo pins a core commit older
 * than the `fetchAccountPlan` hook. The shapes match `AccountPlanInfo` field for
 * field.
 *
 * @module llm/providers/antigravity/account-plan
 */

import type { ProviderAuth } from "@minimal-agent/core/plugin-api/llm/provider-auth"
import type { NetworkClient, NetworkResponse } from "@minimal-agent/core/plugin-api/net/types"

import {
  fetchQuotaSummary,
  type LoadCodeAssistResponse,
  loadCodeAssist,
  type QuotaSummaryResponse,
} from "./live-models.ts"
import { antigravitySessionInfoFromQuota } from "./session-info.ts"
import { antigravityUserAgent, GOOGLE_USERINFO_URL } from "./wire-constants.ts"

/** Local mirror of the contract `AccountPlanInfo`. */
export interface AntigravityAccountPlan {
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
export interface AntigravityAccountPlanContext {
  signal?: AbortSignal
}

/** The `loadCodeAssist` fields that the plan reads. */
export interface PlanLoadCodeAssist extends LoadCodeAssistResponse {
  paidTier?: {
    id?: string
    name?: string
    availableCredits?: Array<{ creditType?: string; minimumCreditAmountForUsage?: string }>
  }
}

/** The userinfo fields that the plan reads. */
export interface PlanUserInfo {
  id?: string
  email?: string
}

/** The tier id of an account with no paid plan. */
const FREE_TIER_ID = "free-tier"

/**
 * Default transport: a `NetworkClient` over the global `fetch`. It keeps only
 * the fields that the control-plane helpers read.
 */
export const fetchNetworkClient: NetworkClient = {
  async request(input): Promise<NetworkResponse> {
    const response = await fetch(input.url, {
      method: input.method,
      headers: input.headers,
      // The control-plane helpers send a JSON string. A byte body is copied.
      body:
        typeof input.body === "string" ? input.body : input.body && new Blob([input.body.slice()]),
      signal: input.signal,
    })
    return {
      status: response.status,
      headers: response.headers,
      body: response.body ?? new ReadableStream<Uint8Array>(),
      transport: { id: "fetch" },
      ok: response.ok,
      text: () => response.text(),
      json: <T>() => response.json() as Promise<T>,
    }
  },
}

/** Get the HTTP status from an error of the control-plane helpers. */
function statusOf(err: unknown): string | undefined {
  const message = err instanceof Error ? err.message : String(err)
  return /\s(\d{3}):/.exec(message)?.[1]
}

/**
 * Change an error of a control-plane call to a short error with only the path
 * and the status. The response body never goes into the message.
 */
function sanitize(path: string, err: unknown): Error {
  if (err instanceof Error && err.name === "AbortError") return err
  if (err instanceof Error && err.name === "TimeoutError") return err
  const status = statusOf(err)
  if (status) return new Error(`antigravity ${path} returned HTTP ${status}`)
  const message = err instanceof Error ? err.message : String(err)
  return new Error(message.startsWith("antigravity") ? message : `antigravity ${path}: ${message}`)
}

/** Read the userinfo of the token. Returns null on any failure. */
async function fetchUserInfo(
  client: NetworkClient,
  token: string,
  signal?: AbortSignal,
): Promise<PlanUserInfo | null> {
  try {
    const response = await client.request({
      label: "antigravity.accountPlan.userinfo",
      method: "GET",
      url: GOOGLE_USERINFO_URL,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "user-agent": antigravityUserAgent(),
      },
      signal,
      capture: { responseBody: false },
    })
    if (!response.ok) return null
    return await response.json<PlanUserInfo>()
  } catch {
    return null
  }
}

/** Pure: fold the three endpoint bodies into the neutral plan view. */
export function buildAntigravityAccountPlan(
  lca: PlanLoadCodeAssist,
  quota: QuotaSummaryResponse | null,
  userinfo: PlanUserInfo | null,
): AntigravityAccountPlan {
  const plan: AntigravityAccountPlan = {}
  if (userinfo?.id) plan.accountId = userinfo.id
  if (userinfo?.email) plan.email = userinfo.email
  const project = lca.cloudaicompanionProject
  if (project) plan.organizationId = project

  const current = lca.currentTier
  const paid = lca.paidTier
  const name = paid?.name ?? current?.name ?? current?.id
  if (name) plan.plan = name
  if (paid?.id) plan.hasPlan = true
  else if (current?.id === FREE_TIER_ID) plan.hasPlan = false

  if (quota) {
    const windows = antigravitySessionInfoFromQuota(quota).quota?.windows
    if (windows && windows.length > 0) plan.windows = [...windows]
  }

  const details: { key: string; label: string; value: string }[] = []
  if (current?.id) details.push({ key: "current_tier", label: "current tier", value: current.id })
  if (paid?.id) details.push({ key: "paid_tier", label: "paid tier", value: paid.id })
  if (project) details.push({ key: "project", label: "project", value: project })
  if (lca.gcpManaged === true) {
    details.push({ key: "gcp_managed", label: "gcp managed", value: "true" })
  }
  for (const credit of paid?.availableCredits ?? []) {
    if (!credit.creditType) continue
    const min = credit.minimumCreditAmountForUsage
    details.push({
      key: "credits",
      label: "credits",
      value: min ? `${credit.creditType} (min ${min})` : credit.creditType,
    })
  }
  if (details.length > 0) plan.details = details
  return plan
}

/**
 * Read the plan, the tier and the quota windows of one OAuth credential.
 * Resolves `null` for an auth kind that is not OAuth. Rejects when
 * `loadCodeAssist` fails. The quota and the userinfo calls are optional: on a
 * failure, the plan has no windows or no email.
 */
export async function fetchAntigravityAccountPlan(
  auth: ProviderAuth,
  ctx: AntigravityAccountPlanContext = {},
  client: NetworkClient = fetchNetworkClient,
): Promise<AntigravityAccountPlan | null> {
  if (auth.kind !== "oauth" || !auth.token) return null
  const token = auth.token
  const deps = { token, networkClient: client, signal: ctx.signal }
  let lca: PlanLoadCodeAssist
  try {
    lca = (await loadCodeAssist(deps)) as PlanLoadCodeAssist
  } catch (err) {
    throw sanitize("loadCodeAssist", err)
  }
  const project = lca.cloudaicompanionProject
  const [quota, userinfo] = await Promise.all([
    project ? fetchQuotaSummary({ ...deps, project }).catch(() => null) : Promise.resolve(null),
    fetchUserInfo(client, token, ctx.signal),
  ])
  return buildAntigravityAccountPlan(lca, quota, userinfo)
}
