/**
 * CanonicalRequest → framed AgentClientMessage for AgentService/Run.
 *
 * MVP: flatten system+history into a single user text, empty conversation_state.
 * conversation_id prefers `metadata.sessionId` (stable across continues) and
 * falls back to a fresh UUID. Wire agent **mode** defaults to AGENT (not ASK).
 *
 * Cache safety: mode is encoded only on UserMessage.mode (protobuf enum). It must
 * never rewrite `req.system` / customSystemPrompt — that would bust the prompt cache
 * and is not how MA ask-mode works (tool deny + stamps, stable system).
 *
 * @module llm/providers/cursor/request-body
 */

import { effortParamIdFromTags, fastParamIdFromTags, isCursorFastParamId } from "./capabilities.ts"
import { buildCursorToolWirePolicy } from "./cursor-tool-policy.ts"
import { getCursorEncodeSpec, lookupCursorRunSku } from "./encode-spec.ts"
import type { CanonicalBlock, CanonicalMessage } from "./lib/canonical-messages.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import type { ModelView } from "./lib/provider-plugin.ts"
import { cursorWireModelId, inferCursorGrokPreset } from "./models.ts"
import {
  AGENT_MODE,
  type AgentRunEncodeOpts,
  type CursorModelParameterValue,
  encodeAgentClientMessageRun,
} from "./proto/agent-run.ts"

/**
 * Map MA / host intent → Cursor UserMessage.mode enum.
 *
 * Default: **AGENT** (full agent loop on Cursor's side). Never default to ASK —
 * that was a bootstrap MVP mistake that forced every Fable session into read-only.
 *
 * Optional override (does **not** touch system text):
 * `req.metadata.custom["cursor-agent-mode"]` ∈ `agent` | `ask` | `plan` | `debug`
 * (case-insensitive). Unknown values fall back to AGENT.
 */
export function resolveCursorWireAgentMode(req: CanonicalRequest): number {
  const raw = req.metadata?.custom?.["cursor-agent-mode"]?.trim().toLowerCase()
  switch (raw) {
    case "ask":
      return AGENT_MODE.ASK
    case "plan":
      return AGENT_MODE.PLAN
    case "debug":
      return AGENT_MODE.DEBUG
    case "agent":
    case "default":
    case undefined:
    case "":
      return AGENT_MODE.AGENT
    default:
      return AGENT_MODE.AGENT
  }
}

/**
 * True when registration marks a **string-representation** variant for wire f8.
 * Requires `variant-string` (George: wire from variantStringRepresentation).
 * Bare `variant` / `variant-legacy-slug` alone do not set f8.
 */
export function modelIsCursorVariant(model: Pick<ModelView, "tags">): boolean {
  return (model.tags ?? []).includes("variant-string")
}

/** True when tags include max-mode (variant or parent supports max). */
export function modelIsCursorMaxMode(model: Pick<ModelView, "tags">): boolean {
  return (model.tags ?? []).includes("max-mode")
}

/**
 * Build ModelParameterValue list for RequestedModel.parameters (field 3).
 *
 * Parameterized catalog (CLI): send baked variant values, then overlay
 * CanonicalRequest.effort / speed. Parents send effort default + fast + any
 * default-param extras (thinking/context). Never invent an effort id.
 */
export function buildCursorModelParameters(
  req: CanonicalRequest,
  model: ModelView,
): CursorModelParameterValue[] {
  const spec = getCursorEncodeSpec(model.id)
  const baked = spec?.parameterValues.length
    ? [...spec.parameterValues]
    : paramsFromTags(model.tags, "param:")
  const extras = spec?.defaultParameterValues.length
    ? [...spec.defaultParameterValues]
    : paramsFromTags(model.tags, "default-param:")
  const grok = inferCursorGrokPreset(model.id)

  let params: CursorModelParameterValue[] =
    baked.length > 0
      ? baked.map((p) => ({ id: p.id, value: p.value }))
      : extras.map((p) => ({ id: p.id, value: p.value }))

  if (baked.length === 0 && grok?.effort) {
    params = [
      { id: "effort", value: grok.effort },
      { id: "fast", value: String(grok.fast) },
    ]
  }

  const effortParamId =
    spec?.effortParamId ?? effortParamIdFromTags(model.tags) ?? (grok ? "effort" : undefined)
  const fastParamId =
    spec?.fastParamId ??
    fastParamIdFromTags(model.tags) ??
    (spec?.speedFast || grok ? "fast" : undefined)
  const levels = spec?.effortLevels.length ? spec.effortLevels : model.capabilities.effort.levels
  const speedFast = spec?.speedFast ?? model.capabilities.speedFast ?? Boolean(grok)

  if (effortParamId) {
    const effort =
      req.effort ??
      (baked.length === 0 ? (model.capabilities.effort.default as string | undefined) : undefined)
    if (effort && (levels.length === 0 || levels.includes(effort))) {
      upsertParam(params, effortParamId, effort)
    }
  }

  if (fastParamId && speedFast) {
    if (req.speed === "fast") upsertParam(params, fastParamId, "true")
    else if (req.speed === "normal") upsertParam(params, fastParamId, "false")
  }

  return params.filter((p) => p.id && p.value)
}

function paramsFromTags(
  tags: ReadonlyArray<string> | undefined,
  prefix: string,
): CursorModelParameterValue[] {
  const out: CursorModelParameterValue[] = []
  for (const tag of tags ?? []) {
    if (!tag.startsWith(prefix)) continue
    const rest = tag.slice(prefix.length)
    const eq = rest.indexOf("=")
    if (eq <= 0) continue
    out.push({ id: rest.slice(0, eq), value: rest.slice(eq + 1) })
  }
  return out
}

function upsertParam(params: CursorModelParameterValue[], id: string, value: string): void {
  const i = params.findIndex(
    (p) => p.id === id || (isCursorFastParamId(id) && isCursorFastParamId(p.id)),
  )
  if (i >= 0) params[i] = { id, value }
  else params.push({ id, value })
}

function parentWireIdFromTags(tags: ReadonlyArray<string> | undefined): string | undefined {
  for (const tag of tags ?? []) {
    if (tag.startsWith("parent:") && tag.length > "parent:".length) {
      return tag.slice("parent:".length)
    }
  }
  return undefined
}

function grokExplodedSku(parent: string, effort?: string, fast?: boolean): string | undefined {
  if (!/^grok-\d+\.\d+$/.test(parent)) return undefined
  if (!effort) return undefined
  return `cursor-${parent}-${effort}${fast ? "-fast" : ""}`
}

function desiredSkuLookup(
  req: CanonicalRequest,
  model: ModelView,
): { parent: string; effort?: string; fast?: boolean } | undefined {
  const spec = getCursorEncodeSpec(model.id)
  const grok = inferCursorGrokPreset(model.id)
  const parent =
    spec?.parentApiId ?? spec?.wireId ?? parentWireIdFromTags(model.tags) ?? grok?.parent
  if (!parent || parent === "default" || parent === "auto") return undefined
  const effortParamId =
    spec?.effortParamId ?? effortParamIdFromTags(model.tags) ?? (grok ? "effort" : undefined)
  const levels = spec?.effortLevels.length ? spec.effortLevels : model.capabilities.effort.levels
  const effort =
    req.effort ??
    (effortParamId && levels.length > 0
      ? (model.capabilities.effort.default as string | undefined)
      : grok && !grok.effort
        ? (model.capabilities.effort.default as string | undefined)
        : grok?.effort)
  const fast =
    req.speed === "fast"
      ? true
      : req.speed === "normal"
        ? false
        : grok && grok.effort
          ? grok.fast
          : undefined
  return { parent, effort, fast }
}

/**
 * Resolve RequestedModel.model_id + f8 + whether to send parameters.
 *
 * Prefer exploded SKUs (`cursor-grok-4.6-high`) and omit parameters/f8.
 * Parent `grok-4.6` + effort/fast is what Cursor Agent CLI sends; MA hit
 * Connect `not_found` / ERROR_BAD_MODEL_NAME for that shape while also
 * sending IDE fingerprint headers. After headers matched CLI, the SKU
 * path returned PONG. Do not treat parent+params as illegal API-wide —
 * `docs/agent-run-too-many-computers-postmortem.md`.
 */
export function resolveCursorRequestedModelId(
  model: ModelView,
  req?: CanonicalRequest,
): {
  modelId: string
  isVariantStringRepresentation: boolean
  sendParameters: boolean
} {
  const spec = getCursorEncodeSpec(model.id)
  if (spec?.useVariantString && spec.wireId) {
    return { modelId: spec.wireId, isVariantStringRepresentation: true, sendParameters: false }
  }
  if (spec?.runModelId) {
    return { modelId: spec.runModelId, isVariantStringRepresentation: false, sendParameters: false }
  }
  if (modelIsCursorVariant(model)) {
    return {
      modelId: spec?.wireId ?? cursorWireModelId(model),
      isVariantStringRepresentation: true,
      sendParameters: false,
    }
  }

  const grok = inferCursorGrokPreset(model.id)
  if (grok?.effort) {
    return {
      modelId: model.id.startsWith("cursor-") ? model.id : `cursor-${model.id}`,
      isVariantStringRepresentation: false,
      sendParameters: false,
    }
  }

  const lookup = req ? desiredSkuLookup(req, model) : undefined
  if (lookup) {
    const fromIndex =
      lookupCursorRunSku(lookup.parent, { effort: lookup.effort, fast: lookup.fast }) ??
      spec?.defaultRunModelId
    const fromGrok = grokExplodedSku(lookup.parent, lookup.effort, lookup.fast === true)
    const sku = fromIndex ?? fromGrok
    if (sku) {
      return { modelId: sku, isVariantStringRepresentation: false, sendParameters: false }
    }
  }

  const parent = parentWireIdFromTags(model.tags)
  const baked = paramsFromTags(model.tags, "param:")
  if (parent && baked.length > 0 && grok) {
    const sku = grokExplodedSku(parent, grok.effort, grok.fast)
    if (sku) {
      return { modelId: sku, isVariantStringRepresentation: false, sendParameters: false }
    }
  }

  return {
    modelId: spec?.wireId ?? cursorWireModelId(model),
    isVariantStringRepresentation: modelIsCursorVariant(model) && baked.length === 0,
    sendParameters: true,
  }
}

/**
 * Resolve Cursor AgentRunRequest.conversation_id from host metadata.
 *
 * Prefer `metadata.sessionId` (CanonicalRequest contract: "replayed in every
 * request in a session"). Optional override via
 * `metadata.custom["cursor-conversation-id"]`. Returns undefined when absent
 * so the encoder generates a fresh UUID.
 */
export function resolveCursorConversationId(req: CanonicalRequest): string | undefined {
  const custom = req.metadata?.custom?.["cursor-conversation-id"]?.trim()
  if (custom) return custom
  const sessionId = req.metadata?.sessionId?.trim()
  if (sessionId) return sessionId
  return undefined
}

/**
 * Ensure a host/bidi session key is present as `metadata.sessionId` before encode.
 * Does not overwrite an explicit sessionId or cursor-conversation-id override.
 */
export function applyCursorSessionToRequest(
  req: CanonicalRequest,
  sessionId: string,
): CanonicalRequest {
  const key = sessionId.trim()
  if (!key) return req
  if (resolveCursorConversationId(req)) return req
  return {
    ...req,
    metadata: {
      ...req.metadata,
      sessionId: key,
    },
  }
}

/**
 * Resolve optional AgentRunRequest.conversation_group_id (field 16).
 * Distinct from conversation_id. Only set when explicitly provided.
 */
export function resolveCursorConversationGroupId(req: CanonicalRequest): string | undefined {
  const group = req.metadata?.custom?.["cursor-conversation-group-id"]?.trim()
  return group || undefined
}

/**
 * Build the protobuf body for AgentService/Run (AgentClientMessage).
 * Caller wraps with Connect frame via connectFrameProto.
 */
export function buildCursorAgentRunBody(req: CanonicalRequest, model: ModelView): Uint8Array {
  // MVP: spike-proven shape is a single user UserMessage.text only.
  // Do NOT send MA system blocks as Cursor customSystemPrompt — live API
  // returned invalid_argument "unknown option '--system-prompt'" (2026-07-23).
  // Do NOT set excludeWorkspaceContext — rejected for typical accounts.
  // Fold system into the user text for context instead.
  // Do NOT invent ConversationState rebuild from transcript (Cheryl RE).
  const systemParts: string[] = []
  for (const block of req.system ?? []) {
    const t = blockText(block)
    if (t) systemParts.push(t)
  }
  const userText = summarizeMessages(req.messages)
  const text =
    systemParts.length > 0
      ? `${systemParts.join("\n\n")}\n\n${userText || "(empty)"}`
      : userText || "(empty)"

  const maxMode = getCursorEncodeSpec(model.id)?.maxMode ?? modelIsCursorMaxMode(model)
  const requested = resolveCursorRequestedModelId(model, req)
  const parameters = requested.sendParameters ? buildCursorModelParameters(req, model) : []
  const toolPolicy = buildCursorToolWirePolicy(req)
  const conversationId = resolveCursorConversationId(req)
  const conversationGroupId = resolveCursorConversationGroupId(req)

  const opts: AgentRunEncodeOpts = {
    // Exploded SKU when known (`cursor-grok-4.6-high`); parent+params only as fallback.
    modelId: requested.modelId,
    text,
    // Wire mode only — never fold mode policy into system / text for cache stability.
    mode: resolveCursorWireAgentMode(req),
    maxMode,
    isVariantStringRepresentation: requested.isVariantStringRepresentation,
    parameters: parameters.length > 0 ? parameters : undefined,
    mcpTools: toolPolicy.mcpTools.length > 0 ? toolPolicy.mcpTools : undefined,
    conversationId,
    conversationGroupId,
  }
  return encodeAgentClientMessageRun(opts)
}

/** Tool-filter HTTP headers for AgentService/Run (exclude native oneofs). */
export function buildCursorToolHeaders(req: CanonicalRequest): Record<string, string> {
  return buildCursorToolWirePolicy(req).headers
}

/** Best-effort text flatten for diagnostics / encoding. */
export function summarizeRequestText(req: CanonicalRequest): string {
  const parts: string[] = []
  for (const block of req.system ?? []) {
    const t = blockText(block)
    if (t) parts.push(t)
  }
  const body = summarizeMessages(req.messages)
  if (body) parts.push(body)
  return parts.join("\n\n") || "(empty)"
}

function summarizeMessages(messages: CanonicalMessage[]): string {
  const parts: string[] = []
  for (const msg of messages) {
    const body = messageText(msg)
    if (body) parts.push(`${msg.role}: ${body}`)
  }
  return parts.join("\n\n")
}

function blockText(block: CanonicalBlock): string | null {
  if (block.type === "text" && block.text.trim()) return block.text.trim()
  if (block.type === "thinking" && block.text.trim()) return block.text.trim()
  return null
}

function messageText(msg: CanonicalMessage): string {
  const texts: string[] = []
  for (const block of msg.content) {
    const t = blockText(block)
    if (t) texts.push(t)
  }
  return texts.join("\n")
}
