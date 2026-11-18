/**
 * Tool-result helpers for bidi continuation detection.
 *
 * @module llm/providers/cursor/bidi-tool-results
 */

import { viewPersistedOutcome } from "@minimal-agent/core/plugin-api"
import type {
  CanonicalMessage,
  ToolResultBlock,
} from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import type { CanonicalRequest } from "@minimal-agent/core/plugin-api/llm/canonical-request"

/** Collect trailing tool_result blocks from the latest user message(s). */
export function extractTrailingToolResults(messages: CanonicalMessage[]): ToolResultBlock[] {
  const results: ToolResultBlock[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.role !== "user") break
    let sawToolResult = false
    for (const block of msg.content) {
      if (block.type === "tool_result") {
        results.unshift(block)
        sawToolResult = true
      } else if (block.type === "text" && block.text.trim() && !sawToolResult) {
        // Fresh user text — stop scanning older messages.
        return results
      }
    }
    if (!sawToolResult) break
  }
  return results
}

/** True when the request ends with tool_result blocks (bidi continuation). */
export function requestHasToolResultContinuation(req: CanonicalRequest): boolean {
  return extractTrailingToolResults(req.messages).length > 0
}

/**
 * User text the host injected alongside trailing tool_results (queued follow-up).
 *
 * The agent loop appends queued user text (the core `inputQueue` port) as a
 * `text` block AFTER tool_result blocks in the same user message. Cursor's
 * live AgentService/Run stream never sees that text unless we write a
 * conversation_action frame. Returns null when the trailing user message is
 * tool_results only.
 */
export function extractTrailingFollowUpUserText(messages: CanonicalMessage[]): string | null {
  const parts: string[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.role !== "user") break
    let sawToolResult = false
    for (const block of msg.content) {
      if (block.type === "tool_result") {
        sawToolResult = true
        continue
      }
      if (block.type === "text" && block.text.trim()) {
        if (!sawToolResult) return null
        parts.push(block.text)
      }
    }
    if (sawToolResult) break
  }
  const joined = parts.join("\n").trim()
  return joined.length > 0 ? joined : null
}

/**
 * Turn legacy `<ma::agent::tasks …>` attr lists into a plain OK line.
 * Used when older Task payloads (pre MA-39298 plain-text) still wrap content
 * in harness tags that this stripper must not delete.
 */
export function tasksAttrsToOkLine(attrs: string): string {
  const get = (name: string): string | undefined => {
    const m = new RegExp(`\\b${name}="([^"]*)"`, "i").exec(attrs)
    return m?.[1]
  }
  const result = (get("result") ?? "ok").trim() || "ok"
  const parts: string[] = [`OK ${result}`]
  const action = get("action")
  if (action) parts.push(`action=${action}`)
  const id = get("id")
  if (id) parts.push(`id=#${id.replace(/^#/, "")}`)
  const parentAuto = get("parent_auto_done")
  if (parentAuto) parts.push(`parent_auto_done=#${parentAuto.replace(/^#/, "")}`)
  const coerced = get("coerced")
  if (coerced) parts.push(`coerced=${coerced}`)
  const reason = get("reason")
  if (reason) parts.push(`reason="${reason}"`)
  for (const key of ["total", "done", "doing", "todo", "canceled"] as const) {
    const v = get(key)
    if (v !== undefined) parts.push(`${key}=${v}`)
  }
  return parts.join(" ")
}

/**
 * Remove MA harness annotations before sending tool output to Cursor's wire.
 *
 * `ma::agent::tasks` is special: Task historically wrapped model-facing
 * payloads in that tag, so a full delete emptied every Task tool_result
 * (MA-39298). Unwrap / convert tasks tags to plain text; still strip other
 * harness chrome (mode-active, raw-output, short-term-memory, …).
 */
export function stripMaAgentWireAnnotations(text: string): string {
  let out = text
  // Paired tasks: keep columnar body, promote attrs to an OK header line.
  out = out.replace(
    /<ma::agent::tasks\b([^>]*)>([\s\S]*?)<\/ma::agent::tasks>/gi,
    (_m, attrs: string, body: string) => {
      const head = tasksAttrsToOkLine(attrs)
      const inner = body.replace(/^\n+|\n+$/g, "")
      return inner.length > 0 ? `${head}\n${inner}` : head
    },
  )
  // Self-closing tasks acks → plain OK line (never delete).
  out = out.replace(/<ma::agent::tasks\b([^>]*)\/>/gi, (_m, attrs: string) =>
    tasksAttrsToOkLine(attrs),
  )
  // Other paired tags (output-preview, short-term-memory, …).
  out = out.replace(/<ma::agent::([a-z0-9-]+)\b[^>]*>[\s\S]*?<\/ma::agent::\1>/gi, "")
  // Other self-closing tags (mode-active, raw-output, mode-change, …).
  out = out.replace(/<ma::agent::[^>]+\/>/g, "")
  return out.replace(/\n{3,}/g, "\n\n").trim()
}

/** Start of a harness tag. The strip regex deletes it. */
const MA_AGENT_TAG_PREFIX = "<ma::agent::"
/** Start of a tasks tag. The strip regex converts it, so it stays (MA-39298). */
const MA_AGENT_TASKS_PREFIX = "<ma::agent::tasks"

/**
 * Model-facing text of a tool_result from its stored `outcome`, or `undefined`
 * when the old path must run. The text is the body, then the plain-text
 * annotations (`[truncated: ...]`, `[note: ...]`) in append order with the join
 * "\n\n". Tag annotations are not added: the strip regex would delete them.
 *
 * Returns `undefined` (old path) when:
 * - the block has no `outcome`, or `outcome` does not fit the content;
 * - the block has more than one non-empty text block. The stored offsets refer
 *   to the FIRST text block only (D8 rule 1), and the old path joins all of them.
 */
function outcomeWireText(block: ToolResultBlock): string | undefined {
  if (block.outcome === undefined) return undefined
  let textBlocks = 0
  for (const c of block.content) {
    if (c.type === "text" && c.text) textBlocks++
  }
  if (textBlocks > 1) return undefined
  const view = viewPersistedOutcome(block.content, block.outcome)
  if (view === undefined) return undefined
  let out = view.body
  for (const a of view.annotations) {
    if (a.text.startsWith(MA_AGENT_TAG_PREFIX) && !a.text.startsWith(MA_AGENT_TASKS_PREFIX)) {
      continue
    }
    out += `\n\n${a.text}`
  }
  return out
}

/** Flatten tool_result content to a single string for McpSuccess.content. */
export function toolResultToWireText(block: ToolResultBlock): string {
  const fromOutcome = outcomeWireText(block)
  if (fromOutcome !== undefined) {
    return stripMaAgentWireAnnotations(fromOutcome) || "(empty tool result)"
  }
  const parts: string[] = []
  for (const c of block.content) {
    if (c.type === "text" && c.text) parts.push(c.text)
  }
  const joined = parts.join("\n") || "(empty tool result)"
  return stripMaAgentWireAnnotations(joined) || "(empty tool result)"
}
