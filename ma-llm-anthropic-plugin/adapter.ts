/**
 * Anthropic `ProviderAdapter` implementation.
 *
 * Wires the building blocks (headers, request body, validation, SSE
 * translator) into the canonical `ProviderAdapter` shape. Dispatches
 * via the network client provided in `RunContext` (the host orchestrator
 * populates `ctx.networkClient`; an absent client is a wiring bug).
 *
 * Retry / 401-refresh / stream-watchdog are intentionally NOT here :
 * those are provider-neutral and live one layer up. This adapter
 * focuses on the wire format.
 *
 * @module llm/providers/anthropic/adapter
 */

import { ANTHROPIC_BETA_FLAGS_CATALOG } from "./beta-flags-catalog.ts"
import { applyBootstrapOverrides, fetchBootstrap } from "./bootstrap.ts"
import { buildAnthropicHeaders } from "./headers.ts"
import type { CanonicalEvent } from "./lib/canonical-events.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import { classifyUpstreamError, type ErrorClassFields, tagUpstreamError } from "./lib/errors.ts"
import type {
  ModelEntry,
  PreflightIssue,
  PreflightResolution,
  ProviderAdapter,
  SubagentModelRecommendation,
  SurfaceId,
  ValidationResult,
} from "./lib/host-types.ts"
import type { NetworkClient } from "./lib/net-types.ts"
import type { ProviderAuth, RunContext } from "./lib/provider-auth.ts"
import type {
  ProviderPlugin,
  ProviderSetupContext,
  ProviderStartupContext,
} from "./lib/provider-plugin.ts"
import { findModelByTags } from "./lib/registry.ts"
import { parseSse } from "./lib/sse-parser.ts"
import { listAnthropicModels } from "./list-models.ts"
import { anthropicMediaLimits } from "./media-limits.ts"
import { registerAnthropicAdHocModelInto, registerAnthropicModels } from "./models.ts"
import { anthropicOAuthLogin } from "./oauth-login.ts"
import { buildAnthropicRequestBody } from "./request-body.ts"
import { type AnthropicStreamEvent, translateAnthropicStream } from "./response-stream.ts"
import {
  fetchAnthropicSessionInfo,
  primeAnthropicSessionInfo,
  setAnthropicRateLimits,
} from "./session-info.ts"
import { resolveAnthropicSystemPrompt } from "./system-prompt.ts"
import {
  applyMismatchResolution,
  buildMismatchIssue,
  findThinkingMismatches,
  ISSUE_THINKING_MODEL_MISMATCH,
} from "./thinking-preflight.ts"
import { validateAnthropicRequest } from "./validate.ts"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MESSAGES_URL = "https://api.anthropic.com/v1/messages?beta=true"

/** Bodies smaller than this are sent as-is: gzip overhead outweighs the win. */
const GZIP_MIN_BYTES = 1024

/** Set once the server rejects a gzipped body (400/415). Disables gzip for the process. */
let gzipRejected = false

/**
 * True when a 400/415 is about the request `Content-Encoding` (the API says
 * "Unsupported Content-Encoding ... send the request body gzip-compressed or
 * uncompressed"), as opposed to an unrelated invalid-request error.
 */
function isContentEncodingRejection(status: number, body: string): boolean {
  if (status === 415) return true
  return /content-encoding|request_body_en/i.test(body)
}

/**
 * Gzip the serialized request body (level 6: same ratio as 9, ~2x faster).
 * Returns `undefined` when compression is off (`MINIMAL_AGENT_NO_REQUEST_GZIP=1`),
 * the server previously rejected it, or the body is too small to bother.
 * Compressed by hand, not via `fetch({compress})`: the default transport is
 * `node:http2` (bypasses fetch), and the API only accepts gzip on requests
 * (zstd / br / deflate all return 400 "Unsupported Content-Encoding").
 */
function gzipRequestBody(serialized: string): Uint8Array | undefined {
  if (gzipRejected || process.env.MINIMAL_AGENT_NO_REQUEST_GZIP === "1") return undefined
  const bytes = new TextEncoder().encode(serialized)
  if (bytes.length < GZIP_MIN_BYTES) return undefined
  return Bun.gzipSync(bytes, { level: 6 })
}

/** Test seam: clear the process-wide "server rejected gzip" latch. */
export function _resetGzipRejectedForTest(): void {
  gzipRejected = false
}

/**
 * Parse the upstream error type out of a non-2xx Anthropic JSON body.
 * Anthropic returns `{"type":"error","error":{"type":"...","message":"..."}}`.
 * Falls back to undefined for non-JSON bodies so the status alone classifies.
 */
function parseAnthropicErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { type?: unknown } }
    const type = parsed?.error?.type
    return typeof type === "string" ? type : undefined
  } catch {
    return undefined
  }
}

type TaggedHttpError = Error & ErrorClassFields & { streamErrorType?: string; retryable?: boolean }

/** Minimal header view (a `Headers` or a test fake). */
type HeaderView = { get(name: string): string | null }

/**
 * Plan quota reset time (epoch ms) from a rejected unified rate limit. A 429
 * with `anthropic-ratelimit-unified-status: rejected` and a numeric
 * `anthropic-ratelimit-unified-reset` (epoch seconds) means the 5h or 7d
 * window is used up until that time.
 */
function unifiedQuotaResetAt(status: number, headers: HeaderView | null | undefined) {
  if (status !== 429 || !headers) return undefined
  if (headers.get("anthropic-ratelimit-unified-status") !== "rejected") return undefined
  const resetSec = Number(headers.get("anthropic-ratelimit-unified-reset"))
  return Number.isFinite(resetSec) && resetSec > 0 ? resetSec * 1000 : undefined
}

/**
 * Build a classified HTTP error for a pre-stream rejection. Maps status, body
 * error type, `Retry-After`, a plan quota reset, and a "prompt is too long"
 * 400 (context overflow) through `classifyUpstreamError`, then stamps the
 * retry tag and the error class on the error. `retryable: false` stays set
 * for terminal verdicts (billing, auth) so older classifiers honor them too.
 */
function taggedAnthropicHttpError(
  status: number,
  body: string,
  headers?: HeaderView | null,
): TaggedHttpError {
  const resetAt = unifiedQuotaResetAt(status, headers)
  const c = classifyUpstreamError({
    httpStatus: status,
    upstreamCode: parseAnthropicErrorCode(body),
    retryAfter: headers?.get("retry-after") ?? null,
    ...(resetAt !== undefined ? { resetAt } : {}),
    contextOverflow: status === 400 && /prompt is too long/i.test(body),
  })
  const err: TaggedHttpError = tagUpstreamError(new Error(`Anthropic API ${status}: ${body}`), c)
  if (c.retryable === false) err.retryable = false
  return err
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Anthropic Messages adapter. Singleton; register once at module
 * load.
 */
export const anthropicAdapter: ProviderAdapter = {
  id: "anthropic",
  displayName: "Anthropic",
  surfaces: ["anthropic-messages"] satisfies ReadonlyArray<SurfaceId>,

  validate(req, model): ValidationResult {
    return validateAnthropicRequest(req, model)
  },

  /**
   * Anthropic media walls (32 MB request, 5 MB/item, format set, item
   * count by context tier). This hook is how CORE learns the limits —
   * core's fallback is the neutral conservative floor in
   * `src/media/default-limits.ts`, never an Anthropic import.
   */
  mediaLimits(model: ModelEntry) {
    return anthropicMediaLimits({ contextWindow: model.capabilities.contextWindow })
  },

  /**
   * Preflight: detect thinking-block signatures that were produced by a
   * different model than the request's `modelId`. Returns one issue
   * when any such mismatch is found (so the agent only opens one modal
   * per send even if the conversation has many stale blocks). Returns
   * `[]` when the request is clean.
   *
   * Why this is the only issue today: model-signed thinking is the
   * single class of validation error we can fix BEFORE the round-trip.
   * Everything else (overload, rate limit, auth) needs server feedback.
   */
  preflight(req: CanonicalRequest, _model: ModelEntry): PreflightIssue[] {
    const mismatches = findThinkingMismatches(req.messages, req.modelId)
    if (mismatches.length === 0) return []
    return [buildMismatchIssue(mismatches, req.modelId)]
  },

  /**
   * Apply the user's resolution to a {@link ISSUE_THINKING_MODEL_MISMATCH}
   * issue. Delegates to the pure `applyMismatchResolution` helper and
   * translates its outcome into the canonical {@link PreflightResolution}
   * shape.
   */
  applyResolution(req: CanonicalRequest, issueCode: string, optionId: string): PreflightResolution {
    if (issueCode !== ISSUE_THINKING_MODEL_MISMATCH) {
      throw new Error(
        `anthropicAdapter.applyResolution: unknown issue code "${issueCode}" (expected "${ISSUE_THINKING_MODEL_MISMATCH}")`,
      )
    }
    const outcome = applyMismatchResolution(req, optionId)
    if (outcome.kind === "cancel") return { kind: "cancel" }
    if (outcome.kind === "unknown-option") {
      throw new Error(
        `anthropicAdapter.applyResolution: unknown option id "${outcome.optionId}" for ${issueCode}`,
      )
    }
    return {
      kind: "modify-request",
      request: { ...req, messages: outcome.messages },
      ...(outcome.adoptModelId !== undefined ? { adoptModelId: outcome.adoptModelId } : {}),
    }
  },

  async *run(
    req: CanonicalRequest,
    model: ModelEntry,
    ctx: RunContext,
  ): AsyncIterable<CanonicalEvent> {
    const auth = ctx.auth
    if (auth.kind === "api-key" && auth.organization === undefined && !auth.key) {
      throw new Error("Anthropic adapter: missing api-key")
    }
    if (auth.kind === "oauth" && !auth.token) {
      throw new Error("Anthropic adapter: missing oauth token")
    }

    const { headers, betaFlags } = buildAnthropicHeaders({
      req,
      model,
      auth,
      sessionId: ctx.sessionId,
    })
    const body = buildAnthropicRequestBody(req, model)
    const serialized = JSON.stringify(body)

    ctx.debug?.header(`POST ${MESSAGES_URL}`)
    ctx.debug?.kv("model", body.model)
    ctx.debug?.kv("stream", String(body.stream ?? true))
    ctx.debug?.kv("max_tokens", String(body.max_tokens))
    ctx.debug?.kv("beta", betaFlags.join(","))
    ctx.debug?.headers(headers)
    ctx.debug?.body(body)

    const networkClient = ctx.networkClient as NetworkClient | undefined
    if (!networkClient) {
      throw new Error("Anthropic adapter: missing ctx.networkClient (host must provide the client)")
    }
    const gzipped = gzipRequestBody(serialized)
    let response = await networkClient.request({
      label: "messages.send",
      method: "POST",
      url: MESSAGES_URL,
      headers: gzipped ? { ...headers, "content-encoding": "gzip" } : headers,
      body: gzipped ?? serialized,
      signal: req.signal,
      // net-dbg logs the readable JSON, not the gzipped bytes.
      capture: { requestBody: serialized },
    })
    // Server rejected the compressed body shape: remember for this process
    // and retry once uncompressed so a gateway quirk never breaks a turn.
    if (gzipped && !response.ok && (response.status === 400 || response.status === 415)) {
      const errText = await response.text().catch(() => "")
      if (isContentEncodingRejection(response.status, errText)) {
        gzipRejected = true
        response = await networkClient.request({
          label: "messages.send",
          method: "POST",
          url: MESSAGES_URL,
          headers,
          body: serialized,
          signal: req.signal,
        })
      } else {
        // A real 400 unrelated to compression: surface it as-is, keep gzip on.
        throw taggedAnthropicHttpError(response.status, errText, response.headers)
      }
    }

    if (!response.ok) {
      const text = await response.text()
      throw taggedAnthropicHttpError(response.status, text, response.headers)
    }
    // Cache + broadcast THIS response's rate-limit snapshot so the status-bar
    // footer keeps the live 5h/7d windows fresh on every real turn. Before the
    // Wave-B transport flip the legacy `client.ts` chat path did this; the
    // canonical path only re-emitted the cached snapshot via
    // `rebroadcastQuotaForSessionUpdate`, so once the cold-start prime probe's
    // headers aged past the slot's 60s freshness window the windows collapsed
    // off the footer mid-session. The helper is provider-neutral (it copies any
    // `*ratelimit*` header), and this mirrors the OpenAI adapter's own
    // `setOpenAIRateLimits(response.headers)` call — each provider broadcasts
    // its own response headers from its own `run()`. Best-effort + non-throwing.
    setAnthropicRateLimits(response.headers)
    if (!response.body) {
      throw new Error("Anthropic API: empty response body for stream")
    }

    yield* translateAnthropicStream(parseSse<AnthropicStreamEvent>(response.body))
  },

  /**
   * Recommend Anthropic models for each abstract sub-agent role, picked from
   * THIS provider's own registered catalog by tier tag (never a hardcoded SKU,
   * so a model rename can't strand it). scout → Haiku, balanced → Sonnet,
   * deep → Opus, each restricted to a `production` model. A role with no
   * matching production model is omitted (the caller falls back to the lead's
   * model). Anthropic's models use adaptive thinking, so we leave `thinking`
   * unset and let effort default per the model.
   */
  recommendSubagentModels(): SubagentModelRecommendation[] {
    const byTier: Array<{ role: string; tag: string }> = [
      { role: "scout", tag: "haiku" },
      { role: "balanced", tag: "sonnet" },
      { role: "deep", tag: "opus" },
    ]
    const recs: SubagentModelRecommendation[] = []
    for (const { role, tag } of byTier) {
      const model = findModelByTags([tag, "production"])
      if (model) recs.push({ role, modelId: model.id })
    }
    return recs
  },
}

/**
 * Model registrar captured at activation so the host's no-arg
 * `registerAdHocModel(modelId)` hook can synthesize an unknown Claude id. As a
 * moved plugin this always holds `ctx.models` (activation always passes a setup
 * context); it stays undefined only before `bootstrapAnthropic` has run.
 */
let capturedModels: ProviderSetupContext["models"] | undefined

/**
 * Register the Anthropic adapter + its model catalog through the host setup
 * context. Idempotent. Called once at activation via
 * `ProviderPlugin.register(ctx)`.
 *
 * Registry seam (Wave D/G): the host passes a {@link ProviderSetupContext} (the
 * `models:register` + `providers:register` capabilities). The catalog is
 * contributed through `ctx.models` and the adapter through `ctx.providers`, so
 * a repo-separated plugin never imports `registerModel` / `registerProvider`
 * from core `src/`.
 *
 * @param ctx - Host setup context carrying the model + provider registrars.
 */
export function bootstrapAnthropic(ctx: ProviderSetupContext): void {
  capturedModels = ctx.models
  registerAnthropicModels(ctx.models)
  ctx.providers?.register(anthropicAdapter)
}

/**
 * Synthesize a registry entry for a Claude id the static catalog does not know
 * (a SKU released after this build). Implements the optional
 * {@link ProviderPlugin.registerAdHocModel} hook so `--model <new-claude-id>`
 * boots with the capability + pricing profile of its closest known family
 * sibling instead of failing with "unknown model". Routes through the registrar
 * captured at activation (no-op when activation has not run yet).
 */
export function registerAnthropicAdHocModel(modelId: string): void {
  if (!capturedModels) return
  registerAnthropicAdHocModelInto(capturedModels, modelId)
}

/** This provider packaged for the {@link ProviderPlugin} registry. */
export const anthropicProviderPlugin: ProviderPlugin = {
  id: "anthropic",
  displayName: "Anthropic",
  shortCode: "anth",
  register: bootstrapAnthropic,
  /**
   * Accept an uncataloged Claude id (a SKU newer than this build) by
   * synthesizing a family-default entry, so `--model <new-id>` boots instead
   * of hard-failing. See {@link registerAnthropicAdHocModel}.
   */
  registerAdHocModel: registerAnthropicAdHocModel,
  oauthLogin: anthropicOAuthLogin,
  /**
   * Plan-auth (OAuth) requests get the mandatory billing + Claude-Code
   * identity preamble the Anthropic server validates; api-key/custom auth
   * keeps the agent's neutral identity. See `./system-prompt.ts`.
   */
  resolveSystemPrompt: resolveAnthropicSystemPrompt,
  /**
   * Version token for dense labels: "claude-<family>-<maj>[-min]…" →
   * "maj.min" / "maj" (fable has no minor digit). Returns undefined for
   * ids outside this scheme so core's generic fallback applies.
   */
  modelVersionToken(modelId: string): string | undefined {
    const m = modelId.match(/^claude-(?:opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/)
    if (!m) return undefined
    return m[2] !== undefined ? `${m[1]}.${m[2]}` : m[1]
  },
  /**
   * Full dense label: the family name says more than the provider tag, so
   * "claude-opus-5-5" → "opus-5.5" (not "anth-5.5"). Undefined for ids
   * outside the Claude scheme, so core keeps its default join.
   */
  modelShortLabel(modelId: string): string | undefined {
    const m = modelId.match(/^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2})(?!\d))?/)
    if (!m) return undefined
    return m[3] !== undefined ? `${m[1]}-${m[2]}.${m[3]}` : `${m[1]}-${m[2]}`
  },
  /**
   * Beta-flag taxonomy for the neutral `--list-flags` command. Returns the
   * documented catalog of protocol flags this provider can send; core renders
   * the union across providers without naming any of them.
   */
  listBetaFlags() {
    return [...ANTHROPIC_BETA_FLAGS_CATALOG]
  },
  /**
   * Live catalog via GET /v1/models?beta=true (incl. the synthesized
   * `[1m]` context-window variants). Implements the neutral
   * `ProviderPlugin.listLiveModels` hook so `--list-models`/the picker
   * never import Anthropic code. Auth kinds map 1:1 onto the legacy
   * AuthResult shape this plugin's HTTP layer still speaks.
   */
  async listLiveModels(auth) {
    // Custom-header auth has no single credential to forward to the legacy
    // HTTP layer; report "no live list" and let the registry fallback serve.
    if (auth.kind === "custom") return []
    const legacyAuth =
      auth.kind === "oauth"
        ? ({ type: "oauth", token: auth.token } as const)
        : ({ type: "api-key", token: auth.key } as const)
    const models = await listAnthropicModels(legacyAuth)
    return models.map((m) => ({
      id: m.id,
      displayName: m.display_name,
      createdAt: m.created_at?.slice(0, 10),
    }))
  },
  /**
   * Provider-neutral session metadata (5h/7d quota windows, context window,
   * model label) for the status bar. **Cache-only** — non-blocking. The
   * cold-start probe lives in {@link primeSessionInfo}. See `./session-info.ts`.
   */
  fetchSessionInfo: fetchAnthropicSessionInfo,
  /**
   * Cold-start quota cache warmup, issued fire-and-forget by the agent boot.
   * A bounded 1-token Haiku POST whose response headers populate the cache
   * AND emit `quota.headersReceived`, so the status-bar slot's first tick
   * (which is cache-only) finds fresh data without ever blocking on the
   * network. Self-deduplicating. See `./session-info.ts`.
   */
  primeSessionInfo: primeAnthropicSessionInfo,
  /**
   * Fire-and-forget `/api/claude_cli/bootstrap` probe (v2.1.154+). Overlays
   * any server-shipped `additional_model_costs` onto the registry so
   * Anthropic can ship a new model id without a CLI release. Self-gates:
   * `fetchBootstrap` returns null for non-OAuth auth, and
   * `applyBootstrapOverrides` no-ops on null. Failures are swallowed; local
   * pricing tables stay authoritative. Relocated here from `src/index.ts`
   * so the entrypoint names no provider.
   */
  onStartupProbe(ctx: ProviderStartupContext): void {
    const registrar = capturedModels
    if (!registrar) return
    void (async () => {
      const resp = await fetchBootstrap({ auth: ctx.auth, modelId: ctx.modelId })
      applyBootstrapOverrides(resp, registrar)
    })().catch(() => {
      // Tolerated: bootstrap is a UX improvement, not a correctness
      // requirement. Local pricing tables remain authoritative.
    })
  },
}

export type { ProviderAuth }
