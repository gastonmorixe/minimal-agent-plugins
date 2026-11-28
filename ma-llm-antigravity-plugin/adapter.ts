/**
 * Antigravity `ProviderAdapter` and plugin registration.
 *
 * One wire surface (`custom`): the Cloud Code Assist envelope that `agy` uses.
 * A turn is:
 *
 * 1. `resolveProject` (`v1internal:loadCodeAssist`) when the project is not
 *    cached. A consumer account gets `aicode-consumers`.
 * 2. `POST /v1internal:streamGenerateContent?alt=sse` with the envelope built
 *    by `request-body.ts`.
 * 3. SSE frames become canonical events in `response-stream.ts`.
 *
 * This adapter sends no telemetry call: no `play.googleapis.com/log`, no
 * `fetchConfig`, no `recordTrajectoryAnalytics`, no `writeTrajectoryAcls`.
 * The only hosts it contacts are the control plane, the OAuth token endpoint
 * and the profile endpoint that the login uses.
 *
 * @module llm/providers/antigravity/adapter
 */

import type { CanonicalEvent } from "@minimal-agent/core/plugin-api/llm/canonical-events"
import { isEvent } from "@minimal-agent/core/plugin-api/llm/canonical-events"
import type { CanonicalRequest } from "@minimal-agent/core/plugin-api/llm/canonical-request"
import type { ProviderAuth, RunContext } from "@minimal-agent/core/plugin-api/llm/provider-auth"
import type {
  ProviderAdapterView,
  ProviderPlugin,
  ProviderSetupContext,
  ProviderValidationResult,
} from "@minimal-agent/core/plugin-api/llm/provider-plugin"
import type { NetworkClient } from "@minimal-agent/core/plugin-api/net/types"
import { parseSse } from "@minimal-agent/core/plugin-api/utils/sse-parser"

import {
  type AntigravityAccountPlan,
  type AntigravityAccountPlanContext,
  fetchAntigravityAccountPlan,
} from "./account-plan.ts"
import { tokenNeedsRefresh } from "./auth.ts"
import { taggedAntigravityError } from "./error-class.ts"
import { antigravityMediaLimits } from "./input-formats.ts"
import type { ModelView, SubagentModelRecommendation } from "./lib/host-types.ts"
import { listAntigravityLiveModels, resolveProject } from "./live-models.ts"
import {
  antigravityModelShortLabel,
  antigravityModelVersionToken,
  registerAntigravityAdHocModelInto,
  registerAntigravityModels,
} from "./models.ts"
import { antigravityOAuthLogin } from "./oauth-login.ts"
import { buildAntigravityBody } from "./request-body.ts"
import {
  type GeminiSseFrame,
  translateAntigravityStream,
  unfenceJsonText,
} from "./response-stream.ts"
import {
  accumulateAntigravityUsage,
  fetchAntigravitySessionInfo,
  primeAntigravitySessionInfo,
} from "./session-info.ts"
import { validateAntigravityRequest } from "./validate.ts"
import { ANTIGRAVITY_API_BASE, antigravityUserAgent, STREAM_PATH } from "./wire-constants.ts"

/** Cap of the tool-signature cache. */
const SIGNATURE_CACHE_MAX = 512

/** Signature cache: tool call id to the `thoughtSignature` the model sent. */
const signatureCache = new Map<string, string>()

/**
 * Store one tool-call signature.
 *
 * A Gemini tool loop is a 400 when the latest assistant `functionCall` has no
 * `thoughtSignature`, and core strips thinking blocks from every message
 * except the last. This cache is the source that survives the round trip.
 */
export function rememberToolSignature(toolUseId: string, signature: string): void {
  if (!toolUseId || !signature) return
  if (signatureCache.size >= SIGNATURE_CACHE_MAX) {
    const oldest = signatureCache.keys().next()
    if (!oldest.done) signatureCache.delete(oldest.value)
  }
  signatureCache.set(toolUseId, signature)
}

/** Read one stored signature, or undefined. */
export function getToolSignature(toolUseId: string): string | undefined {
  return signatureCache.get(toolUseId)
}

/** Drop the signature cache. Tests call this between cases. */
export function clearAntigravityAdapterState(): void {
  signatureCache.clear()
  refreshInFlight.clear()
}

/** Re-export: `index.ts` and older callers import the User-Agent from here. */
export { antigravityUserAgent }

/** In-flight proactive refreshes, keyed by the old access token. */
const refreshInFlight = new Map<string, Promise<{ token: string }>>()

/**
 * Refresh the access token before the turn when it is inside the refresh
 * window (`REFRESH_SKEW_MS` before its expiry).
 *
 * The refresh is `auth.refresh`, the callback the host built from
 * `oauthLogin.refreshCredential`. The host callback writes the new credential
 * to the store and keeps the old refresh token when Google returns none. The
 * token is changed in place on `auth`, as the host 401 path does, so a retry
 * of the same request uses the new token. Calls for the same old token share
 * one refresh.
 *
 * A failed refresh is not fatal here: the turn goes on with the old token, and
 * the host 401 path makes the last attempt.
 */
export async function refreshIfExpiring(
  auth: ProviderAuth,
  debug?: RunContext["debug"],
): Promise<void> {
  if (auth.kind !== "oauth" || !auth.refresh || !auth.token) return
  if (!tokenNeedsRefresh(auth.token)) return
  const old = auth.token
  let pending = refreshInFlight.get(old)
  if (!pending) {
    pending = auth.refresh()
    refreshInFlight.set(old, pending)
    pending.then(
      () => refreshInFlight.delete(old),
      () => refreshInFlight.delete(old),
    )
  }
  try {
    const next = await pending
    if (next.token) auth.token = next.token
  } catch (err) {
    debug?.kv("proactive refresh failed", err instanceof Error ? err.message : String(err))
  }
}

/** Request headers of a stream call. */
function buildHeaders(auth: ProviderAuth): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "text/event-stream",
    "accept-encoding": "gzip",
    "content-type": "application/json",
    "user-agent": antigravityUserAgent(),
  }
  if (auth.kind === "oauth") {
    headers.authorization = `Bearer ${auth.token}`
    if (auth.headers) Object.assign(headers, auth.headers)
  } else if (auth.kind === "api-key") {
    headers.authorization = `Bearer ${auth.key}`
  } else if (auth.kind === "custom") {
    Object.assign(headers, auth.headers)
  }
  return headers
}

/** Digits only: the backend takes `sessionId` as a numeric string. */
export function numericSessionId(sessionId: string): string {
  let hash = 0n
  for (const ch of sessionId) {
    hash = (hash * 131n + BigInt(ch.codePointAt(0) ?? 0)) % 9_007_199_254_740_991n
  }
  return hash.toString()
}

/** A request id in the `agy` shape: `agent/<conv>/<ms>/<exec>/<step>`. */
export function buildRequestId(sessionId: string, step: number): string {
  const ms = Date.now()
  return `agent/${numericSessionId(sessionId)}/${ms}/${step}/0`
}

/** Count of assistant turns: the step index of the request id. */
function stepIndex(req: CanonicalRequest): number {
  return req.messages.filter((m) => m.role === "assistant").length
}

/** True when the request has at least one image part. */
export function requestHasImages(req: CanonicalRequest): boolean {
  const scan = (blocks: ReadonlyArray<{ type: string }> | undefined): boolean =>
    (blocks ?? []).some((b) => b.type === "image" || b.type === "document")
  if (scan(req.system)) return true
  return req.messages.some((m) => scan(m.content as ReadonlyArray<{ type: string }>))
}

/** Antigravity adapter. One wire surface: the Cloud Code Assist envelope. */
export const antigravityAdapter: ProviderAdapterView &
  Required<Pick<ProviderAdapterView, "recommendUtilityModel">> = {
  id: "antigravity",
  displayName: "Google Antigravity",
  surfaces: ["custom"],

  /**
   * The title model: the Gemini 4 Hydrogen family row. Pure: no network.
   *
   * 1. Hydrogen is the one Gemini 4 model on every plan
   *    (https://antigravity.google/docs/models/), and it takes a JSON schema
   *    reply (`structuredOutputs`, see `capabilities.ts`).
   * 2. Gemini 4 has no thinking off and no `minimal` level: `low` is the
   *    lowest (https://ai.google.dev/gemini-api/docs/thinking). `effort: "low"`
   *    sends the `gemini-4-hydrogen-low` SKU. `thinkingOff` sends no
   *    `thinkingConfig`, so no thought text streams back.
   * 3. `stream: "required"`: the adapter only calls `streamGenerateContent`.
   * 4. Price 0: plan quota (`pricing.ts`).
   */
  recommendUtilityModel() {
    return {
      modelId: "gemini-4-hydrogen",
      structured: "json_schema",
      thinkingOff: true,
      effort: "low",
      stream: "required",
    }
  },

  validate(req: CanonicalRequest, model: ModelView): ProviderValidationResult {
    return validateAntigravityRequest(req, model)
  },

  mediaLimits(model: ModelView) {
    return antigravityMediaLimits(model)
  },

  async *run(
    req: CanonicalRequest,
    model: ModelView,
    ctx: RunContext,
  ): AsyncIterable<CanonicalEvent> {
    const auth = ctx.auth
    if (auth.kind === "oauth" && !auth.token) {
      throw new Error(
        "antigravity: no OAuth token (run `minimal-agent login antigravity` or import the agy token)",
      )
    }
    if (!ctx.networkClient) {
      throw new Error("antigravity: no network client on RunContext")
    }
    const networkClient = ctx.networkClient as NetworkClient

    await refreshIfExpiring(auth, ctx.debug)

    const project = await resolveProject({
      token: auth.kind === "oauth" ? auth.token : undefined,
      networkClient,
      signal: req.signal,
    })

    const sessionId = numericSessionId(ctx.sessionId)
    // `buildAntigravityBody` returns the wire body plus a generation receipt.
    // Only `body` goes on the wire: an extra top-level key is a 400.
    const built = buildAntigravityBody(req, model, {
      project,
      modelId: model.vendorIds?.model ?? model.id,
      requestId: buildRequestId(ctx.sessionId, stepIndex(req)),
      sessionId,
      signatures: signatureCache,
    })
    const body = built.body

    const headers = buildHeaders(auth)
    const url = `${ANTIGRAVITY_API_BASE}${STREAM_PATH}`
    ctx.debug?.header(`POST ${url}`)
    ctx.debug?.kv("model", model.id)
    ctx.debug?.headers(headers)
    ctx.debug?.body(body)

    const response = await networkClient.request({
      label: "antigravity.streamGenerateContent",
      method: "POST",
      url,
      headers,
      // The builder returns { body, generation }, and `body` is already the
      // wire body. A second `.body` sends `undefined` and the backend answers
      // 400 INVALID_ARGUMENT with no detail.
      body: JSON.stringify(body),
      signal: req.signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw taggedAntigravityError(response.status, text, response.headers)
    }
    if (!response.body) {
      throw new Error("antigravity API: empty response body for stream")
    }

    const frames = parseSse<GeminiSseFrame>(response.body, {
      contentEncoding: response.headers.get("content-encoding"),
    })

    const translated = translateAntigravityStream(frames, {
      modelId: model.id,
      signatureSink: rememberToolSignature,
    })
    // A JSON schema call: core parses the text as JSON, so drop a fence.
    const events =
      req.outputFormat?.type === "json_schema" && model.capabilities.structuredOutputs
        ? unfenceJsonText(translated)
        : translated
    for await (const ev of events) {
      if (isEvent(ev, "message_delta")) {
        accumulateAntigravityUsage({
          inputTokens: ev.usage.inputTokens,
          outputTokens: ev.usage.outputTokens,
        })
      }
      yield ev
    }
  },

  /**
   * Map the abstract sub-agent roles to this catalog. `scout` takes the cheap
   * flash-lite model; `balanced` takes the family row of the recommended agent
   * model, at its default effort.
   */
  recommendSubagentModels(): SubagentModelRecommendation[] {
    return [
      { role: "scout", modelId: "gemini-3.5-flash-lite" },
      { role: "balanced", modelId: "gemini-4-neon", effort: "high" },
    ]
  },
}

let capturedModels: ProviderSetupContext["models"] | undefined

/**
 * Register the catalog and the adapter through the setup context. The host's
 * live provider loader calls this with a context.
 */
export function bootstrapAntigravity(ctx?: ProviderSetupContext): void {
  if (!ctx?.models || !ctx.providers) return
  capturedModels = ctx.models
  registerAntigravityModels(ctx.models)
  ctx.providers.register(antigravityAdapter)
}

/** Register a model id that the static snapshot does not know yet. */
export function registerAntigravityAdHocModel(modelId: string): void {
  if (!capturedModels) return
  registerAntigravityAdHocModelInto(capturedModels, modelId)
}

/**
 * `ProviderPlugin` plus the `fetchAccountPlan` hook. The pinned core predates
 * that hook. The field matches the newer contract, so a host on newer core
 * reads it through `ProviderPlugin` with no cast.
 */
type AntigravityProviderPlugin = ProviderPlugin & {
  fetchAccountPlan: (
    auth: ProviderAuth,
    ctx?: AntigravityAccountPlanContext,
  ) => Promise<AntigravityAccountPlan | null>
}

/** This provider packaged for the {@link ProviderPlugin} registry. */
export const antigravityProviderPlugin: AntigravityProviderPlugin = {
  id: "antigravity",
  displayName: "Google Antigravity",
  shortCode: "agy",
  register: bootstrapAntigravity,
  registerAdHocModel: registerAntigravityAdHocModel,
  oauthLogin: antigravityOAuthLogin,
  listLiveModels: listAntigravityLiveModels,
  fetchAccountPlan: (auth, ctx) => fetchAntigravityAccountPlan(auth, ctx),
  async fetchSessionInfo() {
    return fetchAntigravitySessionInfo() ?? null
  },
  primeSessionInfo: primeAntigravitySessionInfo,
  modelShortLabel: antigravityModelShortLabel,
  modelVersionToken: antigravityModelVersionToken,
}

/** The model id the backend expects on the wire. Exported for tests. */
export function wireModelId(model: ModelView): string {
  return model.vendorIds?.model ?? model.id
}
