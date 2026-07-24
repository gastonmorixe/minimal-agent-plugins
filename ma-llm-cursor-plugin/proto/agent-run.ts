/**
 * AgentService/Run encode/decode (ASK-mode MVP).
 *
 * Recipe: reports/11-agent-run-request-shape.md + spike agent-run-encode.ts.
 *
 * @module llm/providers/cursor/proto/agent-run
 */

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

/** Alias used by request-body. */
export const AGENT_MODE_ASK = AGENT_MODE.ASK

/** Options for encoding a minimal Run request. */
export type AgentRunEncodeOpts = {
  text: string
  modelId: string
  conversationId?: string
  messageId?: string
  mode?: number
  workspacePath?: string
  shell?: string
  osVersion?: string
  timeZone?: string
  maxMode?: boolean
  builtInModel?: boolean
  excludeWorkspaceContext?: boolean
  customSystemPrompt?: string
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
  const mode = opts.mode ?? AGENT_MODE.ASK
  return concat(encString(1, opts.text), encString(2, mid), encEnum(4, mode))
}

function encUserMessageAction(opts: AgentRunEncodeOpts): Uint8Array {
  return concat(encMsg(1, encUserMessage(opts)), encMsg(2, encRequestContext(opts)))
}

function encConversationAction(opts: AgentRunEncodeOpts): Uint8Array {
  return encMsg(1, encUserMessageAction(opts))
}

function encRequestedModel(opts: AgentRunEncodeOpts): Uint8Array {
  return concat(
    encString(1, opts.modelId),
    encBoolExplicit(2, opts.maxMode ?? false),
    encBool(7, opts.builtInModel ?? true),
  )
}

function encModelDetails(opts: AgentRunEncodeOpts): Uint8Array {
  return concat(encString(1, opts.modelId), encBool(7, opts.maxMode ?? false))
}

/** Encode AgentRunRequest body (without outer AgentClientMessage wrapper). */
export function encodeAgentRunRequest(opts: AgentRunEncodeOpts): Uint8Array {
  const cid = opts.conversationId ?? crypto.randomUUID()
  const parts = [
    encMsg(1, new Uint8Array(0)), // empty conversation_state
    encMsg(2, encConversationAction(opts)),
    encMsg(3, encModelDetails(opts)),
    encString(5, cid),
    encMsg(9, encRequestedModel(opts)),
  ]
  if (opts.customSystemPrompt) parts.push(encString(8, opts.customSystemPrompt))
  if (opts.excludeWorkspaceContext) parts.push(encBool(12, true))
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

/** Coarse server event extracted from one AgentServerMessage payload. */
export type CursorServerEvent = {
  kind: string
  text?: string
  rawField?: number
}

/**
 * Extract events from AgentServerMessage payloads.
 * Path: field1 interaction_update → field1 text_delta → field1 text
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
        } else if (u.no === 14) {
          events.push({ kind: "turn_ended", rawField: 14 })
        } else if (u.no === 13) {
          events.push({ kind: "heartbeat", rawField: 13 })
        } else if (u.no === 2) {
          events.push({ kind: "tool_call_started", rawField: 2 })
        } else if (u.no === 3) {
          events.push({ kind: "tool_call_completed", rawField: 3 })
        } else if (u.no === 6) {
          events.push({ kind: "user_message_appended", rawField: 6 })
        } else {
          events.push({ kind: `interaction_${u.no}`, rawField: u.no })
        }
      }
    } else if (f.no === 2) {
      events.push({ kind: "exec_server_message", rawField: 2 })
    } else if (f.no === 3) {
      events.push({ kind: "conversation_checkpoint_update", rawField: 3 })
    } else if (f.no === 7) {
      events.push({ kind: "interaction_query", rawField: 7 })
    } else {
      events.push({ kind: `server_field_${f.no}`, rawField: f.no })
    }
  }
  return events
}

/** Decode end-stream trailer JSON if present. */
export function extractEndStreamError(payload: Uint8Array): string | undefined {
  try {
    const t = new TextDecoder().decode(payload)
    if (t.startsWith("{")) return t.slice(0, 2000)
  } catch {
    /* ignore */
  }
  return undefined
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
