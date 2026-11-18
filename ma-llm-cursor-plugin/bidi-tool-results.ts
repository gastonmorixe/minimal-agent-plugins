/**
 * Tool-result helpers for bidi continuation detection.
 *
 * @module llm/providers/cursor/bidi-tool-results
 */

import { CORE_ANNOTATION_KINDS, viewPersistedOutcome } from "@minimal-agent/core/plugin-api"
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

/** True when `text` holds a harness opener or closer. Case-insensitive: the strip regexes use the i flag. */
const hasHarnessLiteral = (text: string): boolean => /<\/?ma::agent::/i.test(text)

/** True when the strip step deletes ALL of `text`, white space included (no trim hides a leftover). */
const stripsToNothing = (text: string): boolean =>
  stripMaAgentWireAnnotations(`\u0001${text}\u0001`) === "\u0001\u0001"

/** Start of a harness closing tag. */
const MA_AGENT_CLOSER_PREFIX = "</ma::agent::"

/** Core kinds that hold plain text, with the prefix that the text must have. */
const PLAIN_TEXT_KINDS: Readonly<Record<string, string>> = {
  "output-truncated": "[truncated:",
  "output-streak": "[note:",
}

/**
 * Model-facing text of a tool_result from its stored `outcome`, or `undefined`
 * when the old path must run. The old path joins the text blocks with `"\n"` and
 * strips the harness tags. This function gives the SAME bytes as the old path
 * in every case where it returns a string. The result is the body, then the
 * plain-text annotations (`[truncated: ...]`, `[note: ...]`) in append order,
 * each after `"\n\n"`. Tag annotations are not added: the strip regex deletes them.
 *
 * Returns `undefined` (old path) unless ALL of these rules hold:
 * - (a) `block.outcome` is set and `viewPersistedOutcome` gives a view.
 * - (b) At most one text block has text. If one has, it is the FIRST text
 *   block, because the stored offsets refer to the first text block only.
 * - (c) The stored spans tile the text: the body, then each annotation, with
 *   nothing after the last annotation (so the content was not edited).
 * - (d) The body has no harness opener or closer (`<ma::agent::` or
 *   `</ma::agent::`), in any letter case, so the strip regex finds no tag
 *   in the body (a tag opener in the body can swallow the text after it).
 * - (e) Each annotation is of a core kind. A plain-text kind
 *   (`output-truncated`, `output-streak`) has the right prefix and no harness
 *   opener or closer (any letter case). A tag kind starts with `<ma::agent::`
 *   (any letter case). The strip step must remove ALL of its text, with no white
 *   space left (no trim hides a leftover), and it has no closer inside it
 *   except as its last text.
 * - (f) Each gap between two spans is `"\n\n"` or `"\n"`, and the newlines before
 *   each plain-text annotation (gaps of the tag annotations before it
 *   included) are at least two, and exactly `"\n\n"` when no tag lies between.
 *   When the body only has white space, the first gap can also be empty
 *   (the strip step trims it in both paths).
 *
 * @param block - The tool_result block.
 * @returns The text before the strip step, or `undefined` for the old path.
 */
export function outcomeWireText(block: ToolResultBlock): string | undefined {
  // (a)
  if (block.outcome === undefined) return undefined
  const view = viewPersistedOutcome(block.content, block.outcome)
  if (view === undefined) return undefined

  // (b)
  const first = block.content.find((c) => c.type === "text")
  for (const c of block.content) {
    if (c.type === "text" && c.text && c !== first) return undefined
  }

  // (c) `viewPersistedOutcome` checks the order and the range of the spans.
  const last = view.annotations[view.annotations.length - 1]
  if ((last === undefined ? view.bodyEnd : last.end) !== view.text.length) return undefined

  // (d)
  if (hasHarnessLiteral(view.body)) return undefined

  let out = view.body
  let previousEnd = view.bodyEnd
  // Before the first plain-text annotation, a body with only white space is trimmed in both paths.
  let blankLead = view.body.trim() === ""
  let newlines = 0
  let sawTag = false
  for (const a of view.annotations) {
    // (f) gap
    const gap = view.text.slice(previousEnd, a.start)
    if (gap !== "\n\n" && gap !== "\n" && !(blankLead && gap === "")) return undefined
    newlines += gap.length
    previousEnd = a.end

    // (e)
    if (!(CORE_ANNOTATION_KINDS as readonly string[]).includes(a.kind)) return undefined
    const prefix = PLAIN_TEXT_KINDS[a.kind]
    if (prefix === undefined) {
      if (!/^<ma::agent::/i.test(a.text)) return undefined
      if (!stripsToNothing(a.text)) return undefined
      // A closer is allowed only as the last text of the annotation.
      const closer = a.text.indexOf(MA_AGENT_CLOSER_PREFIX)
      if (closer !== -1) {
        const close = a.text.indexOf(">", closer)
        if (close !== a.text.length - 1) return undefined
        if (a.text.indexOf(MA_AGENT_CLOSER_PREFIX, closer + 1) !== -1) return undefined
      }
      sawTag = true
      continue
    }
    if (!a.text.startsWith(prefix) || hasHarnessLiteral(a.text)) return undefined
    // (f) join
    if (!blankLead && (newlines < 2 || (!sawTag && gap !== "\n\n"))) return undefined
    out += `\n\n${a.text}`
    blankLead = false
    newlines = 0
    sawTag = false
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
