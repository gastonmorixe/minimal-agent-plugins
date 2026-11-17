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

import type { CanonicalEvent } from "@minimal-agent/core/plugin-api/llm/canonical-events"
import type { CanonicalRequest } from "@minimal-agent/core/plugin-api/llm/canonical-request"
import {
  classifyUpstreamError,
  type ErrorClassFields,
  tagUpstreamError,
} from "@minimal-agent/core/plugin-api/llm/errors"
import type { ProviderAuth, RunContext } from "@minimal-agent/core/plugin-api/llm/provider-auth"
import type {
  ProviderPlugin,
  ProviderSetupContext,
  ProviderStartupContext,
} from "@minimal-agent/core/plugin-api/llm/provider-plugin"
import type { NetworkClient } from "@minimal-agent/core/plugin-api/net/types"
import { parseSse } from "@minimal-agent/core/plugin-api/utils/sse-parser"

import { fetchAnthropicAccountPlan } from "./account-plan.ts"
import { ANTHROPIC_BETA_FLAGS, buildBetaFlags, classifyRequest } from "./beta-flags.ts"
import { ANTHROPIC_BETA_FLAGS_CATALOG } from "./beta-flags-catalog.ts"
import { applyBootstrapOverrides, fetchBootstrap } from "./bootstrap.ts"
import {
  forgetMessageId,
  isPreviousMessageIdRejection,
  previousMessageIdFor,
  ResponseChainRecorder,
  _resetCacheDiagnosisForTest as resetChainForTest,
} from "./cache-diagnosis.ts"
import { buildAnthropicHeaders } from "./headers.ts"
import { accountUuidFor, buildOAuthMetadata, rememberAccountUuid } from "./identity.ts"
import type {
  ModelEntry,
  ProviderAdapter,
  SubagentModelRecommendation,
  SurfaceId,
  ValidationResult,
} from "./lib/host-types.ts"
import { findModelByTags } from "./lib/registry.ts"
import { listAnthropicModels } from "./list-models.ts"
import { anthropicMediaLimits } from "./media-limits.ts"
import { prepareMediaUploads, retryInlineAfterMissingFile } from "./media-upload.ts"
import { registerAnthropicAdHocModelInto, registerAnthropicModels } from "./models.ts"
import { anthropicOAuthLogin } from "./oauth-login.ts"
import { type AnthropicRequestBody, buildAnthropicRequestBody } from "./request-body.ts"
import { type AnthropicStreamEvent, translateAnthropicStream } from "./response-stream.ts"
import {
  fetchAnthropicSessionInfo,
  primeAnthropicSessionInfo,
  setAnthropicRateLimits,
} from "./session-info.ts"
import { resolveAnthropicSystemPrompt } from "./system-prompt.ts"
import { validateAnthropicRequest } from "./validate.ts"
import { BUILD_HASH, buildHashFor, VERSION } from "./wire-constants.ts"
import { metadataUserIdEnabled } from "./wire-options.ts"

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

/**
 * Set once the server rejects `thinking-token-count-2026-05-13` (400 "invalid
 * beta flag"). CC heals the same way: `x0o` drops zW "for this conversation
 * and retrying" when `Jz(e)` (400 + "invalid beta flag") and the beta was on
 * the wire (CC/chunk-wqb2b4v0.mjs). We latch it for the process.
 */
let thinkingTokenCountRejected = false

/**
 * The four header-only CC 2.1.325 betas (research/2026-11-15-cc-2.1.325-oauth-
 * diff/betas-headers.md §1-§4). None carries a body field, so a server that
 * does not know one can only answer 400 "invalid beta flag" naming it. Same
 * heal as CC's x0o for zW: drop that beta for the process and retry once.
 */
const HEADER_ONLY_BETAS = [
  ANTHROPIC_BETA_FLAGS.PER_TURN_CONTROL,
  ANTHROPIC_BETA_FLAGS.MID_CONVERSATION_TOOL_CHANGES,
  ANTHROPIC_BETA_FLAGS.TOOL_PROVENANCE,
  ANTHROPIC_BETA_FLAGS.THINKING_BINDING_CONTROLS,
] as const

/** Header-only betas the server rejected in this process (never resent). */
const rejectedHeaderOnlyBetas = new Set<string>()

/** Test seam: forget the cache-diagnosis chain and the beta-heal latches. */
export function _resetCacheDiagnosisForTest(): void {
  resetChainForTest()
  thinkingTokenCountRejected = false
  rejectedHeaderOnlyBetas.clear()
}

/**
 * The header-only beta a 400 "invalid beta flag" names, when it was on the
 * wire and is not dropped yet; otherwise undefined.
 */
function rejectedHeaderOnlyBeta(
  status: number,
  body: string,
  sent: readonly string[],
): string | undefined {
  if (!isInvalidBetaRejection(status, body)) return undefined
  const lower = body.toLowerCase()
  return HEADER_ONLY_BETAS.find(
    (b) => sent.includes(b) && !rejectedHeaderOnlyBetas.has(b) && lower.includes(b),
  )
}

/** CC's `Jz`: a 400 whose message says "invalid beta flag". */
const TTC = ANTHROPIC_BETA_FLAGS.THINKING_TOKEN_COUNT

function isInvalidBetaRejection(status: number, body: string): boolean {
  return status === 400 && body.toLowerCase().includes("invalid beta flag")
}

/**
 * Only latch the process-wide TTC drop when the rejection names that beta;
 * an "invalid beta flag" 400 about another beta must not disable TTC.
 */
function isThinkingTokenCountRejection(status: number, body: string): boolean {
  return isInvalidBetaRejection(status, body) && body.toLowerCase().includes("thinking-token-count")
}

/**
 * Whether this request carries `cache-diagnosis-2026-04-07` + the body
 * `diagnostics` block. An explicit `req.vendor.anthropic.cacheDiagnostics`
 * wins. Otherwise ON for OAuth conversation/subtask requests (CC 2.1.325 adds
 * the beta on every agentic set: `if(wV()&&!Ea.includes(b3t))Ea.push(b3t)`,
 * CC/chunk-wqb2b4v0.mjs), unless `MINIMAL_AGENT_NO_CACHE_DIAGNOSIS=1`.
 */
function wantsCacheDiagnosis(req: CanonicalRequest, authKind: ProviderAuth["kind"]): boolean {
  const explicit = req.vendor?.anthropic?.cacheDiagnostics
  if (explicit !== undefined) return explicit
  if (authKind !== "oauth") return false
  if (process.env.MINIMAL_AGENT_NO_CACHE_DIAGNOSIS === "1") return false
  const kind = classifyRequest(req)
  return kind === "conversation" || kind === "subtask"
}

/**
 * Our sideband / reminder blocks: the equivalent of CC's `isMeta` messages.
 * CC keeps reminders and attachments-as-context in separate meta user
 * messages; we inline them as `<ma::…>` / `<system-reminder>` text blocks.
 */
function isMetaText(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith("<ma::") || t.startsWith("<system-reminder>")
}

/**
 * Text claude-code hashes into the billing `cc_version` suffix. Mirrors CC's
 * `j()` (CC/chunk-gpympest.mjs): `e.find(o=>o.type==="user"&&!o.isMeta)`, then
 * string content as-is or its FIRST `type==="text"` block, else "". A user
 * message made only of meta text blocks counts as meta and is skipped; meta
 * blocks before the prompt are skipped (on the wire CC's meta messages sit in
 * messages[0] before the prompt: 6 D captures, e.g. fetch-005 "hello 2" → f16).
 * A first real message with no text (image-only) yields "", like CC.
 */
export function firstUserPromptText(messages: AnthropicRequestBody["messages"]): string {
  for (const msg of messages) {
    if (msg.role !== "user") continue
    if (typeof msg.content === "string") {
      if (isMetaText(msg.content)) continue
      return msg.content
    }
    const real = msg.content.filter((b) => !(b.type === "text" && isMetaText(b.text)))
    if (real.length === 0) continue
    const text = real.find((b) => b.type === "text")
    return text?.type === "text" ? text.text : ""
  }
  return ""
}

/**
 * Re-derive the billing header's `cc_version` hash from the real first user
 * prompt (the system-prompt seam has no messages, so it renders the "" hash).
 * Only touches system[0] when it is our billing header with the default hash.
 */
function applyBillingPromptHash(body: AnthropicRequestBody): void {
  const block = body.system?.[0]
  if (!block?.text.startsWith("x-anthropic-billing-header:")) return
  const stale = `cc_version=${VERSION}.${BUILD_HASH};`
  if (!block.text.includes(stale)) return
  const fresh = `cc_version=${VERSION}.${buildHashFor(firstUserPromptText(body.messages))};`
  body.system![0] = { ...block, text: block.text.replace(stale, fresh) }
}

/**
 * Set once the server rejects `mid-conversation-system-clear-at-2026-08-21`.
 * CC 2.1.325 heals the same way: `lee` drops `_9` and retries when `mCn(e)`
 * (CC/chunk-wqb2b4v0.mjs: "the server rejected the clear_at beta header or
 * field (HTTP 400); retrying without them"). We then send the pre-2.1.325
 * `mid-conversation-system-2026-04-07` header instead (the one our role:system
 * messages were proven with), latched for the process.
 */
let clearAtRejected = false

const CLEAR_AT = ANTHROPIC_BETA_FLAGS.MID_CONVERSATION_SYSTEM_CLEAR_AT

/** Test seam: forget the clear-at heal latch. */
export function _resetClearAtRejectedForTest(): void {
  clearAtRejected = false
}

/**
 * CC's `mCn(e)` (CC/chunk-wqb2b4v0.mjs): a 400 whose message starts with
 * "Unexpected value(s) " and names the clear-at header in an anthropic-beta
 * context (`YBn`, CC/chunk-zhvxfbcg.mjs), or matches the clear_at field
 * errors (`Fjr`).
 */
const CLEAR_AT_FIELD_ERROR =
  /^messages\.\d+(?:\.content\.\d+)?(?:\.clear_at:|: .*(?:turn-scoped system message|\(clear_at: |clear_at is only permitted))/

/**
 * True when an HTTP response is the server rejecting the clear-at beta: a 400
 * whose error message (JSON `error.message`, or the raw body when not JSON)
 * is an "Unexpected value(s) " anthropic-beta complaint naming the clear-at
 * header, or matches {@link CLEAR_AT_FIELD_ERROR}.
 */
export function isClearAtRejection(status: number, body: string): boolean {
  if (status !== 400) return false
  let message = body
  try {
    const m = (JSON.parse(body) as { error?: { message?: unknown } })?.error?.message
    if (typeof m === "string") message = m
  } catch {
    // non-JSON body: match the raw text
  }
  return (
    (message.startsWith("Unexpected value(s) ") &&
      message.includes(CLEAR_AT) &&
      /anthropic[-_]beta/.test(message)) ||
    CLEAR_AT_FIELD_ERROR.test(message)
  )
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

/**
 * After a clear-at rejection: swap the clear-at beta for the pre-2.1.325
 * mid-conversation-system header, only on a request that would actually have
 * sent clear-at (same kind/model/auth gates; title and quota probes never
 * carry it, so they get neither header).
 */
function withClearAtFallback(
  req: CanonicalRequest,
  model: ModelEntry,
  authKind: ProviderAuth["kind"],
): CanonicalRequest {
  const o = req.vendor?.anthropic?.betaOverrides
  const wouldSendClearAt = buildBetaFlags({
    kind: classifyRequest(req),
    req,
    model,
    authKind,
  }).includes(CLEAR_AT)
  if (!wouldSendClearAt) return req
  const add = [...(o?.add ?? []), ANTHROPIC_BETA_FLAGS.MID_CONVERSATION_SYSTEM]
  return {
    ...req,
    vendor: {
      ...req.vendor,
      anthropic: {
        ...req.vendor?.anthropic,
        betaOverrides: { ...o, add, remove: [...(o?.remove ?? []), CLEAR_AT] },
      },
    },
  }
}

/**
 * The in-flight startup bootstrap probe (it learns `oauth_account.account_uuid`).
 * Cleared once it settles.
 */
let pendingAccountProbe: Promise<void> | undefined

/** Longest wait for the bootstrap probe before the first OAuth send. */
export const ACCOUNT_PROBE_WAIT_MS = 1500

/** Test seam: set (or clear) the in-flight account probe. */
export function _setPendingAccountProbeForTest(p: Promise<void> | undefined): void {
  pendingAccountProbe = p
}

/**
 * E2E FAIL-1: `metadata.user_id` must carry the account uuid from the first
 * request. The stored credential seeds it (oauth-login.ts `readAnthropicOAuthAuth`).
 * When the credential has none (an old login), wait for the in-flight
 * bootstrap probe, at most {@link ACCOUNT_PROBE_WAIT_MS}, before an OAuth
 * conversation send. No wait when the uuid is known, no probe is running, or
 * metadata is off.
 */
async function awaitAccountUuid(req: CanonicalRequest, auth: ProviderAuth): Promise<void> {
  if (auth.kind !== "oauth" || !pendingAccountProbe) return
  if (accountUuidFor(auth.token) !== undefined || !metadataUserIdEnabled()) return
  const kind = classifyRequest(req)
  if (kind === "title" || kind === "quota") return
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ACCOUNT_PROBE_WAIT_MS)
  })
  try {
    await Promise.race([pendingAccountProbe.catch(() => {}), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Body fields that follow the claude-code 2.1.325 wire (research diff B5, B7):
 * - `thinking.display:"updates"` exactly when the opt-in beta
 *   thinking-display-updates-2026-08-18 is on the wire (gate:
 *   `wantsThinkingDisplayUpdates` in ./beta-flags.ts).
 * - OAuth `metadata.user_id` (`buildOAuthMetadata`, ./identity.ts). CC's
 *   `Cqe()` sends it on every request, api-key included; we keep it OAuth-only.
 *   Opt-out: `MINIMAL_AGENT_NO_METADATA_USER_ID=1` or
 *   `plugins.anthropic.metadataUserId: false` (./wire-options.ts). Appended
 *   last (CC puts it after `tools`; key order is cosmetic and left alone).
 */
function applyWireExtras(
  body: AnthropicRequestBody,
  betaFlags: readonly string[],
  auth: ProviderAuth,
  sessionId: string,
): void {
  if (
    betaFlags.includes(ANTHROPIC_BETA_FLAGS.THINKING_DISPLAY_UPDATES) &&
    body.thinking?.type === "adaptive"
  ) {
    body.thinking = { type: "adaptive", display: "updates" }
  }
  if (auth.kind === "oauth" && metadataUserIdEnabled()) {
    body.metadata = buildOAuthMetadata(sessionId, undefined, auth.token)
  }
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
   * Anthropic media walls (32 MB request, 5 MB/item, item count by context
   * tier) and the model's own input format set (`inputMimeTypes`). This
   * hook is how CORE learns the limits — core's fallback is the neutral
   * conservative floor in `src/media/default-limits.ts`, never an Anthropic
   * import.
   */
  mediaLimits(model: ModelEntry) {
    return anthropicMediaLimits({
      contextWindow: model.capabilities.contextWindow,
      capabilities: model.capabilities,
    })
  },

  // No preflight() and no applyResolution(). The API docs say to send
  // thinking blocks back unchanged, also after a model switch. The API
  // drops each block that the new model cannot read. So there is nothing
  // to ask a person before the send.

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

    const networkClient = ctx.networkClient as NetworkClient | undefined
    if (!networkClient) {
      throw new Error("Anthropic adapter: missing ctx.networkClient (host must provide the client)")
    }

    await awaitAccountUuid(req, auth)

    const cacheDiagnosis = wantsCacheDiagnosis(req, auth.kind)
    // Derived from the history being sent, like CC's `Amt(e)` (./cache-diagnosis.ts).
    let previousMessageId = cacheDiagnosis ? previousMessageIdFor(req.messages) : null

    // Large inline media goes up through the Files API first. Only the wire
    // copy gets file ids; `req` (and the transcript) keeps the base64.
    const uploads = await prepareMediaUploads(req, model, ctx, networkClient)
    let baseReq = uploads.req

    /** Build + POST one attempt. Returns the response and the beta set sent. */
    const send = async () => {
      const processDropped = [
        ...(thinkingTokenCountRejected ? [TTC] : []),
        ...rejectedHeaderOnlyBetas,
      ]
      const removeBetas =
        processDropped.length > 0
          ? [...(req.vendor?.anthropic?.betaOverrides?.remove ?? []), ...processDropped]
          : req.vendor?.anthropic?.betaOverrides?.remove
      const wireReq0: CanonicalRequest =
        (cacheDiagnosis && !req.vendor?.anthropic?.cacheDiagnostics) || processDropped.length > 0
          ? {
              ...baseReq,
              vendor: {
                ...req.vendor,
                anthropic: {
                  ...req.vendor?.anthropic,
                  ...(cacheDiagnosis && { cacheDiagnostics: true }),
                  ...(removeBetas && {
                    betaOverrides: { ...req.vendor?.anthropic?.betaOverrides, remove: removeBetas },
                  }),
                },
              },
            }
          : baseReq
      const wireReq = clearAtRejected ? withClearAtFallback(wireReq0, model, auth.kind) : wireReq0
      const { headers, betaFlags } = buildAnthropicHeaders({
        req: wireReq,
        model,
        auth,
        sessionId: ctx.sessionId,
      })
      const body = buildAnthropicRequestBody(wireReq, model)
      // Only with the beta actually on the wire (betaOverrides.remove may drop
      // it). The leaf body builder pre-fills `diagnostics` from
      // vendor.cacheDiagnostics alone, so strip it when the beta is absent.
      if (cacheDiagnosis && betaFlags.includes(ANTHROPIC_BETA_FLAGS.CACHE_DIAGNOSIS)) {
        body.diagnostics = { previous_message_id: previousMessageId }
      } else if (!betaFlags.includes(ANTHROPIC_BETA_FLAGS.CACHE_DIAGNOSIS)) {
        delete body.diagnostics
      }
      if (auth.kind === "oauth") applyBillingPromptHash(body)
      applyWireExtras(body, betaFlags, auth, ctx.sessionId)
      const serialized = JSON.stringify(body)

      ctx.debug?.header(`POST ${MESSAGES_URL}`)
      ctx.debug?.kv("model", body.model)
      ctx.debug?.kv("stream", String(body.stream ?? true))
      ctx.debug?.kv("max_tokens", String(body.max_tokens))
      ctx.debug?.kv("beta", betaFlags.join(","))
      ctx.debug?.headers(headers)
      ctx.debug?.body(body)

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
          // A real 400 unrelated to compression: hand the body to the heal step.
          return { response, betaFlags, errText }
        }
      }
      return { response, betaFlags, errText: undefined as string | undefined }
    }

    let attempt = await send()
    // One-shot 400 heals (each at most once per run):
    // - `diagnostics.previous_message_id` rejected (CC: previous_message_id_invalid,
    //   CC/chunk-wqb2b4v0.mjs) → resend with previous_message_id:null.
    // - thinking-token-count rejected as an invalid beta (CC's x0o heal) →
    //   drop it for the process and resend.
    // - mid-conversation-system-clear-at rejected (CC's `lee`/`mCn` heal) →
    //   fall back to the old mid-conversation-system header for the process.
    // - a header-only beta (per-turn-control, mid-conversation-tool-changes,
    //   tool-provenance, thinking-binding-controls) named in an "invalid beta
    //   flag" 400 → drop it for the process and resend.
    // - a 404 for an uploaded file id the server no longer knows (deleted,
    //   expired, other workspace) → evict it from the upload cache and resend
    //   those items inline.
    let fileRetried = false
    for (let heals = 0; heals < 4 + HEADER_ONLY_BETAS.length && !attempt.response.ok; heals++) {
      const status = attempt.response.status
      if (status !== 400 && status !== 404) break
      const errText = attempt.errText ?? (await attempt.response.text().catch(() => ""))
      attempt.errText = errText
      if (status === 404) {
        if (fileRetried) break
        const retry = retryInlineAfterMissingFile(req, uploads, 404, errText)
        if (!retry) break
        fileRetried = true
        ctx.debug?.kv("files.retry", "inline after missing file id")
        baseReq = retry
      } else if (previousMessageId !== null && isPreviousMessageIdRejection(400, errText)) {
        // Evict the rejected id so a later withRetry re-run of run() (same
        // req.messages) does not recompute and resend it.
        forgetMessageId(previousMessageId)
        previousMessageId = null
      } else if (
        !thinkingTokenCountRejected &&
        attempt.betaFlags.includes(TTC) &&
        isThinkingTokenCountRejection(400, errText)
      ) {
        thinkingTokenCountRejected = true
      } else if (
        !clearAtRejected &&
        attempt.betaFlags.includes(CLEAR_AT) &&
        isClearAtRejection(400, errText)
      ) {
        clearAtRejected = true
      } else {
        const beta = rejectedHeaderOnlyBeta(400, errText, attempt.betaFlags)
        if (beta === undefined) break
        rejectedHeaderOnlyBetas.add(beta)
      }
      attempt = await send()
    }
    const response = attempt.response

    if (!response.ok) {
      const text = attempt.errText ?? (await response.text())
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

    // Per-request recorder: commits fingerprint → msg id only on a clean
    // message_stop, so aborted / failed / interleaved attempts never leak.
    const chain = cacheDiagnosis ? new ResponseChainRecorder() : undefined
    for await (const ev of translateAnthropicStream(
      parseSse<AnthropicStreamEvent>(response.body),
    )) {
      chain?.observe(ev)
      yield ev
    }
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

/**
 * `ProviderPlugin` plus the `fetchAccountPlan` hook. The pinned core predates
 * that hook; the field matches the newer contract, so a host on newer core
 * reads it through `ProviderPlugin` with no cast.
 */
type AnthropicProviderPlugin = ProviderPlugin & {
  fetchAccountPlan: typeof fetchAnthropicAccountPlan
}

/** This provider packaged for the {@link ProviderPlugin} registry. */
export const anthropicProviderPlugin: AnthropicProviderPlugin = {
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
    const probe = (async () => {
      const resp = await fetchBootstrap({ auth: ctx.auth, modelId: ctx.modelId })
      // account_uuid for the OAuth metadata.user_id (./identity.ts).
      rememberAccountUuid(resp?.oauth_account?.account_uuid)
      applyBootstrapOverrides(resp, registrar)
    })()
      .catch(() => {
        // Tolerated: bootstrap is a UX improvement, not a correctness
        // requirement. Local pricing tables remain authoritative.
      })
      .finally(() => {
        if (pendingAccountProbe === probe) pendingAccountProbe = undefined
      })
    // The first OAuth send may briefly await it for account_uuid (awaitAccountUuid).
    pendingAccountProbe = probe
  },
  /**
   * Plan, seat, role, and usage windows for one OAuth credential, read from
   * the account endpoints. Spends no model quota. `null` for API keys. See
   * `./account-plan.ts`.
   */
  fetchAccountPlan: fetchAnthropicAccountPlan,
}

export type { ProviderAuth }
