/**
 * Cursor `ProviderAdapter` — self-contained custom-wire provider plugin.
 *
 * Speaks Cursor's AgentService/Run (connect+proto) surface `cursor-agent-run`.
 * MA tools ride MCP (`mcp_tools` + exclude native oneofs); text/thinking stream
 * maps to canonical events. With tools enabled, uses bidi h2: one stream per user
 * turn; tool results are written as exec_client_message on the same connection.
 *
 * Auth: MA provider store only (apiKeyAuth exchange / oauthLogin deviceCode).
 * No env tokens or keychain.
 *
 * @module llm/providers/cursor/adapter
 */

import { cursorApiKeyAuth, resolveCursorAccessToken } from "./auth.ts"
import { runCursorBidi, shouldUseCursorBidi } from "./bidi-run.ts"
import { agentRunUrl } from "./connect/hosts.ts"
import { connectFrameProto, connectStreamPost } from "./connect/stream.ts"
import { buildCursorHeaders } from "./headers.ts"
import { loadClientIds } from "./ids.ts"
import type { CanonicalEvent } from "./lib/canonical-events.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import type { NetworkClient } from "./lib/net-types.ts"
import type { RunContext } from "./lib/provider-auth.ts"
import type {
  ModelView,
  ProviderAdapterView,
  ProviderPlugin,
  ProviderSetupContext,
  ProviderValidationResult,
  SubagentModelRecommendation,
} from "./lib/provider-plugin.ts"
import { listCursorLiveModels, setCursorLiveModelRegistrar } from "./live-models.ts"
import { registerCursorAdHocModelInto, registerCursorModels } from "./models.ts"
import { cursorOAuthLogin } from "./oauth-login.ts"
import { buildCursorAgentRunBody, buildCursorToolHeaders } from "./request-body.ts"
import { translateCursorStream } from "./response-stream.ts"
import { fetchCursorSessionInfo } from "./session-info.ts"
import { validateCursorRequest } from "./validate.ts"
import { CURSOR_SURFACE_AGENT_RUN } from "./wire-constants.ts"

/**
 * Stable bidi session key when the host passes an empty sessionId.
 * loadClientIds() mints a fresh UUID each call — that must not key the
 * open AgentService/Run stream or tool continuations never find pendingExec.
 */
let fallbackBidiSessionKey: string | undefined

function resolveBidiSessionKey(hostSessionId: string | undefined): string {
  const host = hostSessionId?.trim()
  if (host) return host
  fallbackBidiSessionKey ??= crypto.randomUUID()
  return fallbackBidiSessionKey
}

/** Cursor adapter. Speaks AgentService/Run (custom surface). */
export const cursorAdapter: ProviderAdapterView = {
  id: "cursor",
  displayName: "Cursor",
  surfaces: [CURSOR_SURFACE_AGENT_RUN],

  validate(req: CanonicalRequest, model: ModelView): ProviderValidationResult {
    return validateCursorRequest(req, model)
  },

  async *run(
    req: CanonicalRequest,
    model: ModelView,
    ctx: RunContext,
  ): AsyncIterable<CanonicalEvent> {
    const networkClient = ctx.networkClient as NetworkClient | undefined
    const token = await resolveCursorAccessToken(ctx.auth, {
      networkClient,
      signal: req.signal,
    })
    const ids = await loadClientIds()
    const bidiSessionKey = resolveBidiSessionKey(ctx.sessionId)
    // Align Cursor wire session id with host (or stable fallback) for bidi.
    ids.sessionId = bidiSessionKey

    const headers = buildCursorHeaders({
      token,
      ids,
      streaming: true,
      clientType: "cli",
      extra: buildCursorToolHeaders(req),
    })

    const protoBody = buildCursorAgentRunBody(req, model)
    const url = agentRunUrl()

    ctx.debug?.header(`POST ${url}`)
    ctx.debug?.kv("model", model.id)
    ctx.debug?.kv("surface", CURSOR_SURFACE_AGENT_RUN)
    ctx.debug?.kv("bidi", String(shouldUseCursorBidi(req, networkClient)))
    ctx.debug?.kv("bidiSession", bidiSessionKey)
    ctx.debug?.headers(headers)

    if (shouldUseCursorBidi(req, networkClient)) {
      if (!networkClient) {
        yield {
          type: "stream_error",
          retryable: false,
          category: "api",
          cause: new Error("cursor bidi: host NetworkClient is required when tools are enabled"),
        }
        return
      }
      yield* runCursorBidi(req, model, {
        url,
        headers,
        initialRunBody: protoBody,
        signal: req.signal,
        sessionId: bidiSessionKey,
        modelId: model.id,
        networkClient,
      })
      return
    }

    const framed = connectFrameProto(protoBody)
    ctx.debug?.kv("bodyBytes", String(framed.length))

    const chunks = connectStreamPost({
      url,
      headers,
      body: framed,
      signal: req.signal,
      networkClient,
    })

    yield* translateCursorStream(chunks, { modelId: model.id })
  },

  /**
   * Recommend Cursor models per abstract sub-agent role from the static seed.
   * Live catalog (2.2) can refine picks later.
   */
  recommendSubagentModels(): SubagentModelRecommendation[] {
    const recs: SubagentModelRecommendation[] = []
    if (catalogScoutId) recs.push({ role: "scout", modelId: catalogScoutId })
    if (catalogBalancedId && catalogBalancedId !== catalogScoutId) {
      recs.push({ role: "balanced", modelId: catalogBalancedId })
    }
    return recs
  },
}

// Role picks captured at registration for recommendSubagentModels.
let catalogScoutId: string | undefined
let catalogBalancedId: string | undefined

// Registrar captured at bootstrap for ad-hoc model hook (no ctx).
let capturedModels: ProviderSetupContext["models"] | undefined

/**
 * Register the Cursor catalog + adapter through the setup context.
 * No-op when ctx is absent (legacy no-arg activation path).
 */
export function bootstrapCursor(ctx?: ProviderSetupContext): void {
  if (!ctx?.models || !ctx.providers) return
  capturedModels = ctx.models
  // So listLiveModels can register full ModelEntry caps (ctx/effort/think/tools)
  // for every AvailableModels row — host list-models only enriches from registry.
  setCursorLiveModelRegistrar(ctx.models)
  const ids = registerCursorModels(ctx.models)
  catalogScoutId =
    ids.find((id) => id.includes("fast")) ?? ids.find((id) => id === "cursor-auto") ?? ids[0]
  catalogBalancedId =
    ids.find((id) => id === "cursor-composer-2.5") ??
    ids.find((id) => id === "cursor-auto") ??
    ids[0]
  ctx.providers.register(cursorAdapter)
}

/** Register a one-off Cursor slug the static seed does not know. */
export function registerCursorAdHocModel(modelId: string): void {
  if (!capturedModels) return
  registerCursorAdHocModelInto(capturedModels, modelId)
}

/**
 * Cursor provider packaged for the {@link ProviderPlugin} registry.
 *
 * Auth/catalog hooks (Christina 2.1/2.2):
 * - {@link cursorApiKeyAuth} (auth.ts)
 * - {@link cursorOAuthLogin} (oauth-login.ts)
 * - {@link listCursorLiveModels} (live-models.ts)
 */
export const cursorProviderPlugin: ProviderPlugin = {
  id: "cursor",
  displayName: "Cursor",
  shortCode: "cur",
  register: bootstrapCursor,
  registerAdHocModel: registerCursorAdHocModel,
  listLiveModels: listCursorLiveModels,
  apiKeyAuth: cursorApiKeyAuth,
  oauthLogin: cursorOAuthLogin,
  fetchSessionInfo: fetchCursorSessionInfo,
}
