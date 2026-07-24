/**
 * CanonicalRequest → framed AgentClientMessage for AgentService/Run.
 *
 * MVP: flatten system+history into a single user text, mode ASK,
 * empty conversation_state, fresh conversation_id per run.
 *
 * @module llm/providers/cursor/request-body
 */

import type { CanonicalBlock, CanonicalMessage } from "./lib/canonical-messages.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import type { ModelView } from "./lib/provider-plugin.ts"
import { cursorWireModelId } from "./models.ts"
import {
  AGENT_MODE_ASK,
  type AgentRunEncodeOpts,
  encodeAgentClientMessageRun,
} from "./proto/agent-run.ts"

/**
 * Build the protobuf body for AgentService/Run (AgentClientMessage).
 * Caller wraps with Connect frame via connectFrameProto.
 */
export function buildCursorAgentRunBody(req: CanonicalRequest, model: ModelView): Uint8Array {
  const systemParts: string[] = []
  for (const block of req.system ?? []) {
    const t = blockText(block)
    if (t) systemParts.push(t)
  }
  const userText = summarizeMessages(req.messages)
  const opts: AgentRunEncodeOpts = {
    // Bare Cursor API slug (not host-namespaced id).
    modelId: cursorWireModelId(model),
    text: userText || "(empty)",
    mode: AGENT_MODE_ASK,
    customSystemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    // Do NOT set excludeWorkspaceContext: live API returns
    // invalid_argument "Workspace context exclusion is not allowed for this
    // user, team, or selected model" for typical MA accounts (E2E 2026-07-23).
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
