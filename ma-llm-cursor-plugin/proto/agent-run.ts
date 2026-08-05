/**
 * AgentService/Run encode/decode (ASK-mode MVP).
 *
 * Recipe: reports/11-agent-run-request-shape.md + spike agent-run-encode.ts.
 *
 * @module llm/providers/cursor/proto/agent-run
 */

import { type CursorMcpExecRequest, decodeExecServerMcpRequest } from "./exec-mcp.ts"
import { type CursorMcpToolWire, encMcpTools } from "./mcp-tools.ts"
import { decodeToolCallUpdate } from "./tool-call-decode.ts"
import {
  concat,
  decodeFields,
  encBool,
  encBoolExplicit,
  encEnum,
  encMsg,
  encRepeatedString,
  encString,
  fieldBytes,
  fieldString,
  fieldVarint,
} from "./wire.ts"

/** Cursor agent mode enum (partial). */
export const AGENT_MODE = {
  UNSPECIFIED: 0,
  AGENT: 1,
  ASK: 2,
  PLAN: 3,
  DEBUG: 4,
  TRIAGE: 5,
  PROJECT: 6,
  MULTITASK: 7,
  CUSTOM: 8,
} as const

/** Alias used by request-body / tests. */
export const AGENT_MODE_ASK = AGENT_MODE.ASK
/** Default wire mode for AgentService/Run (full agent, not read-only ask). */
export const AGENT_MODE_AGENT = AGENT_MODE.AGENT

/** One `agent.v1.RequestedModel.ModelParameterValue` (`{id,value}`). */
export type CursorModelParameterValue = {
  id: string
  value: string
}

/** Options for encoding a minimal Run request. */
export type AgentRunEncodeOpts = {
  text: string
  modelId: string
  /**
   * AgentRunRequest.conversation_id (field 5).
   * When omitted, a fresh UUID is generated (CLI `--new-session-id` proves
   * caller-supplied ids are valid; ordinary CLI persistence is still RE-open).
   */
  conversationId?: string
  /**
   * AgentRunRequest.conversation_group_id (field 16).
   * Distinct from conversation_id. Omitted when unset.
   */
  conversationGroupId?: string
  messageId?: string
  mode?: number
  workspacePath?: string
  shell?: string
  osVersion?: string
  timeZone?: string
  maxMode?: boolean
  builtInModel?: boolean
  /** When true, set RequestedModel.is_variant_string_representation (field 8). */
  isVariantStringRepresentation?: boolean
  /** Effort/reasoning knobs as ModelParameterValue list (RequestedModel.parameters f3). */
  parameters?: ReadonlyArray<CursorModelParameterValue>
  excludeWorkspaceContext?: boolean
  customSystemPrompt?: string
  /** MA tools as agent.v1.McpTools (field 4). Omitted when empty. */
  mcpTools?: readonly CursorMcpToolWire[]
}

function encRequestContextEnv(opts: AgentRunEncodeOpts): Uint8Array {
  const workspace = opts.workspacePath ?? process.cwd()
  return concat(
    encString(1, opts.osVersion ?? process.platform),
    encRepeatedString(2, [workspace]),
    encString(3, opts.shell ?? process.env.SHELL ?? "/bin/sh"),
    encBoolExplicit(5, false),
    encString(10, opts.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone),
    encString(21, workspace),
  )
}

function encRequestContext(opts: AgentRunEncodeOpts): Uint8Array {
  return concat(encMsg(4, encRequestContextEnv(opts)))
}

function encUserMessage(opts: AgentRunEncodeOpts): Uint8Array {
  const mid = opts.messageId ?? crypto.randomUUID()
  // Default AGENT — never ASK. Callers that need ask must pass mode explicitly.
  const mode = opts.mode ?? AGENT_MODE.AGENT
  return concat(encString(1, opts.text), encString(2, mid), encEnum(4, mode))
}

function encUserMessageAction(opts: AgentRunEncodeOpts): Uint8Array {
  return concat(encMsg(1, encUserMessage(opts)), encMsg(2, encRequestContext(opts)))
}

function encConversationAction(opts: AgentRunEncodeOpts): Uint8Array {
  return encMsg(1, encUserMessageAction(opts))
}

/** Encode one ModelParameterValue message `{id, value}`. */
export function encModelParameterValue(param: CursorModelParameterValue): Uint8Array {
  return concat(encString(1, param.id), encString(2, param.value))
}

/**
 * Encode `agent.v1.RequestedModel`.
 * Fields: 1 model_id, 2 max_mode, 3 parameters*, 7 built_in_model, 8 is_variant_string_representation.
 */
export function encRequestedModel(opts: AgentRunEncodeOpts): Uint8Array {
  const parts: Uint8Array[] = [
    encString(1, opts.modelId),
    // Always send max_mode (including false) — matches spike explicit false.
    encBoolExplicit(2, opts.maxMode ?? false),
  ]
  for (const p of opts.parameters ?? []) {
    if (!p.id || !p.value) continue
    parts.push(encMsg(3, encModelParameterValue(p)))
  }
  parts.push(encBool(7, opts.builtInModel ?? true))
  if (opts.isVariantStringRepresentation) {
    parts.push(encBoolExplicit(8, true))
  }
  return concat(...parts)
}

function encModelDetails(opts: AgentRunEncodeOpts): Uint8Array {
  // ModelDetails: 1 model_id, 7 max_mode (opt)
  return concat(encString(1, opts.modelId), encBool(7, opts.maxMode ?? false))
}

/** Encode AgentRunRequest body (without outer AgentClientMessage wrapper). */
export function encodeAgentRunRequest(opts: AgentRunEncodeOpts): Uint8Array {
  const cid = opts.conversationId ?? crypto.randomUUID()
  const parts = [
    encMsg(1, new Uint8Array(0)), // empty conversation_state (no invented rebuild)
    encMsg(2, encConversationAction(opts)),
    encMsg(3, encModelDetails(opts)),
    encString(5, cid),
    encMsg(9, encRequestedModel(opts)),
  ]
  if (opts.customSystemPrompt) parts.push(encString(8, opts.customSystemPrompt))
  if (opts.mcpTools && opts.mcpTools.length > 0) {
    parts.push(encMsg(4, encMcpTools(opts.mcpTools)))
  }
  if (opts.excludeWorkspaceContext) parts.push(encBool(12, true))
  if (opts.conversationGroupId) parts.push(encString(16, opts.conversationGroupId))
  return concat(...parts)
}

/**
 * Encode AgentClientMessage with a nested AgentRunRequest field.
 * This is the protobuf payload placed inside a Connect data frame.
 */
export function encodeAgentClientMessageRun(opts: AgentRunEncodeOpts): Uint8Array {
  return encMsg(1, encodeAgentRunRequest(opts))
}

function msgTextField1(body: Uint8Array): string | undefined {
  for (const tf of decodeFields(body)) {
    if (tf.no === 1) return fieldString(tf) ?? undefined
  }
  return undefined
}

/** Parsed MCP exec request attached to exec_server_message events. */
export type { CursorMcpExecRequest } from "./exec-mcp.ts"

/** Coarse server event extracted from one AgentServerMessage payload. */
export type CursorServerEvent = {
  kind: string
  text?: string
  rawField?: number
  toolCall?: ReturnType<typeof decodeToolCallUpdate>
  execMcp?: CursorMcpExecRequest
  /** InteractionUpdate.token_delta.tokens (int32). */
  tokens?: number
  /** ConversationTokenDetails.used_tokens (uint32). */
  usedTokens?: number
  /** ConversationTokenDetails.max_tokens (uint32). */
  maxTokens?: number
  /** SummaryCompletedUpdate.hook_message (optional). */
  hookMessage?: string
}

/** Decode agent.v1.ConversationTokenDetails (used_tokens#1, max_tokens#2). */
export function decodeConversationTokenDetails(body: Uint8Array): {
  usedTokens?: number
  maxTokens?: number
} {
  let usedTokens: number | undefined
  let maxTokens: number | undefined
  for (const f of decodeFields(body)) {
    const v = fieldVarint(f)
    if (v == null) continue
    if (f.no === 1) usedTokens = v
    else if (f.no === 2) maxTokens = v
  }
  return { usedTokens, maxTokens }
}

/**
 * Decode AgentServerMessage.conversation_checkpoint_update (#3 =
 * ConversationStateStructure) for token_details (#5).
 */
export function decodeCheckpointTokenDetails(checkpointBody: Uint8Array): {
  usedTokens?: number
  maxTokens?: number
} {
  for (const f of decodeFields(checkpointBody)) {
    if (f.no !== 5) continue
    const td = fieldBytes(f)
    if (td) return decodeConversationTokenDetails(td)
  }
  return {}
}

/**
 * Extract events from AgentServerMessage payloads.
 * Path: field1 interaction_update → field1 text_delta → field1 text
 *
 * InteractionUpdate oneof (cursor-agent 2026.07.23): #8 token_delta,
 * #9 summary, #10 summary_started, #11 summary_completed.
 * AgentServerMessage #3 conversation_checkpoint_update carries
 * ConversationStateStructure.token_details (#5).
 */
export function extractServerTextEvents(payload: Uint8Array): CursorServerEvent[] {
  const events: CursorServerEvent[] = []
  for (const f of decodeFields(payload)) {
    if (f.no === 1 && f.wire === 2) {
      const iu = fieldBytes(f)
      if (!iu) continue
      for (const u of decodeFields(iu)) {
        const body = fieldBytes(u)
        if (u.no === 1 && body) {
          events.push({ kind: "text_delta", text: msgTextField1(body), rawField: 1 })
        } else if (u.no === 4 && body) {
          events.push({ kind: "thinking_delta", text: msgTextField1(body), rawField: 4 })
        } else if (u.no === 8 && body) {
          // TokenDeltaUpdate.tokens #1 int32
          let tokens: number | undefined
          for (const tf of decodeFields(body)) {
            const v = fieldVarint(tf)
            if (tf.no === 1 && v != null) tokens = v
          }
          events.push({ kind: "token_delta", rawField: 8, tokens })
        } else if (u.no === 9 && body) {
          // SummaryUpdate.summary #1 string
          events.push({ kind: "summary", text: msgTextField1(body), rawField: 9 })
        } else if (u.no === 10) {
          events.push({ kind: "summary_started", rawField: 10 })
        } else if (u.no === 11) {
          const hookMessage = body ? msgTextField1(body) : undefined
          events.push({ kind: "summary_completed", rawField: 11, hookMessage })
        } else if (u.no === 14) {
          events.push({ kind: "turn_ended", rawField: 14 })
        } else if (u.no === 13) {
          events.push({ kind: "heartbeat", rawField: 13 })
        } else if (u.no === 2 && body) {
          events.push({
            kind: "tool_call_started",
            rawField: 2,
            toolCall: decodeToolCallUpdate(body),
          })
        } else if (u.no === 3 && body) {
          events.push({
            kind: "tool_call_completed",
            rawField: 3,
            toolCall: decodeToolCallUpdate(body),
          })
        } else if (u.no === 6) {
          events.push({ kind: "user_message_appended", rawField: 6 })
        } else {
          events.push({ kind: `interaction_${u.no}`, rawField: u.no })
        }
      }
    } else if (f.no === 2 && f.wire === 2) {
      const execBody = fieldBytes(f)
      if (execBody) {
        events.push({
          kind: "exec_server_message",
          rawField: 2,
          execMcp: decodeExecServerMcpRequest(execBody),
        })
      } else {
        events.push({ kind: "exec_server_message", rawField: 2 })
      }
    } else if (f.no === 3) {
      const checkpoint = fieldBytes(f)
      if (checkpoint) {
        const { usedTokens, maxTokens } = decodeCheckpointTokenDetails(checkpoint)
        events.push({
          kind: "conversation_checkpoint_update",
          rawField: 3,
          usedTokens,
          maxTokens,
        })
      } else {
        events.push({ kind: "conversation_checkpoint_update", rawField: 3 })
      }
    } else if (f.no === 7) {
      // InteractionQuery — opaque until a concrete query oneof is needed.
      // PreCompact is ExecuteHookRequest.pre_compact, not this field.
      events.push({ kind: "interaction_query", rawField: 7 })
    } else {
      events.push({ kind: `server_field_${f.no}`, rawField: f.no })
    }
  }
  return events
}

/** Parsed Connect end-stream trailer (sanitized for logs / Error.message). */
export type ConnectEndStreamError = {
  /** Short host-facing message (no tokens/headers). */
  message: string
  /** Optional Connect/provider code when present. */
  code?: string
  /** Raw JSON text, truncated (may still contain provider details). */
  raw?: string
}

/**
 * Decode Connect end-stream trailer JSON into a safe diagnostic shape.
 * Connect trailers often look like `{"error":{"code":"…","message":"…"}}`.
 */
export function parseConnectEndStreamError(payload: Uint8Array): ConnectEndStreamError | undefined {
  let text: string
  try {
    text = new TextDecoder().decode(payload).trim()
  } catch {
    return undefined
  }
  if (!text) return undefined

  // Prefer structured Connect error JSON.
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as {
        error?: { code?: unknown; message?: unknown; details?: unknown }
        code?: unknown
        message?: unknown
      }
      const errObj = parsed.error && typeof parsed.error === "object" ? parsed.error : undefined
      const codeRaw = errObj?.code ?? parsed.code
      const msgRaw = errObj?.message ?? parsed.message
      const code = typeof codeRaw === "string" ? codeRaw : undefined
      const msg = typeof msgRaw === "string" ? msgRaw : undefined
      const parts = ["cursor connect end-stream"]
      if (code) parts.push(code)
      if (msg) parts.push(msg)
      else parts.push(text.slice(0, 400))
      return {
        message: parts.join(": ").slice(0, 800),
        code,
        raw: text.slice(0, 2000),
      }
    } catch {
      return {
        message: `cursor connect end-stream: ${text.slice(0, 400)}`,
        raw: text.slice(0, 2000),
      }
    }
  }

  // Non-JSON trailer (rare).
  return { message: `cursor connect end-stream: ${text.slice(0, 400)}`, raw: text.slice(0, 2000) }
}

/** Decode end-stream trailer JSON if present (legacy string form). */
export function extractEndStreamError(payload: Uint8Array): string | undefined {
  return parseConnectEndStreamError(payload)?.raw ?? parseConnectEndStreamError(payload)?.message
}

/**
 * Decode one InteractionUpdate / stream frame payload into a coarse tag.
 * Full CanonicalEvent mapping lives in response-stream.ts.
 */
export function decodeInteractionUpdateTag(
  buf: Uint8Array,
): "text_delta" | "thinking_delta" | "turn_ended" | "other" {
  const events = extractServerTextEvents(buf)
  if (events.some((e) => e.kind === "text_delta")) return "text_delta"
  if (events.some((e) => e.kind === "thinking_delta")) return "thinking_delta"
  if (events.some((e) => e.kind === "turn_ended")) return "turn_ended"
  return "other"
}
