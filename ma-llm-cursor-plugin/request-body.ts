/**
 * CanonicalRequest → framed AgentClientMessage for AgentService/Run.
 *
 * MVP: flatten system+history into a single user text, empty conversation_state,
 * fresh conversation_id per run. Wire agent **mode** defaults to AGENT (not ASK).
 *
 * Cache safety: mode is encoded only on UserMessage.mode (protobuf enum). It must
 * never rewrite `req.system` / customSystemPrompt — that would bust the prompt cache
 * and is not how MA ask-mode works (tool deny + stamps, stable system).
 *
 * @module llm/providers/cursor/request-body
 */

import { effortParamIdFromTags } from "./capabilities.ts"
import type { CanonicalBlock, CanonicalMessage } from "./lib/canonical-messages.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import type { ModelView } from "./lib/provider-plugin.ts"
import { cursorWireModelId } from "./models.ts"
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
 * Only when CanonicalRequest.effort is set AND model tags carry `effort-param:<id>`
 * (live registration). No hardcoded `effort` fallback — missing tag means catalog
 * metadata is incomplete; omit the parameter rather than invent an id.
 */
export function buildCursorModelParameters(
  req: CanonicalRequest,
  model: ModelView,
): CursorModelParameterValue[] {
  const effort = req.effort
  if (!effort) return []
  const paramId = effortParamIdFromTags(model.tags)
  if (!paramId) return []
  const levels = model.capabilities.effort.levels
  if (levels.length > 0 && !levels.includes(effort)) {
    // Cap validation should have caught this; omit rather than send invalid.
    return []
  }
  return [{ id: paramId, value: effort }]
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

  const maxMode = modelIsCursorMaxMode(model)
  const isVariant = modelIsCursorVariant(model)
  const parameters = buildCursorModelParameters(req, model)

  const opts: AgentRunEncodeOpts = {
    // Bare Cursor API slug (not host-namespaced id).
    modelId: cursorWireModelId(model),
    text,
    // Wire mode only — never fold mode policy into system / text for cache stability.
    mode: resolveCursorWireAgentMode(req),
    maxMode,
    isVariantStringRepresentation: isVariant,
    parameters: parameters.length > 0 ? parameters : undefined,
  }
  return encodeAgentClientMessageRun(opts)
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
