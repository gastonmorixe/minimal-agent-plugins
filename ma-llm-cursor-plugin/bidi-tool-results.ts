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
import type { SidebandApi, SidebandNode } from "@minimal-agent/core/plugin-api/types/sideband"

import { cursorBidiLog } from "./bidi-debug.ts"

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

/** The kind of the Task board node. The strip step keeps its data as an OK line. */
const TASKS_KIND = "tasks"

let warnedNoSideband = false

/** Log one time that the strip step has no sideband codec (debug channel). */
function noteNoSideband(): void {
  if (warnedNoSideband) return
  warnedNoSideband = true
  cursorBidiLog("tool-result.no-sideband", "no sideband codec: tool result text sent unchanged")
}

/**
 * True when the strip step removes a node of `kind`: a to-model kind that is
 * not a system section, or a kind that no plugin declares.
 */
function removable(sb: SidebandApi, kind: string): boolean {
  const info = sb.kindInfo(kind)
  return info === undefined || (info.direction === "to-model" && info.placement !== "system")
}

/** True when `sb` can read the harness tags. */
const canRead = (sb: SidebandApi | undefined): sb is SidebandApi => sb?.ready === true

/**
 * Turn the attributes of an old Task board node into a plain OK line.
 * Used when older Task payloads (pre MA-39298 plain-text) still wrap content
 * in a harness tag that this stripper must not delete.
 *
 * @param attrs - The node attributes as written (`SidebandNode.attrs`).
 */
export function tasksAttrsToOkLine(attrs: Readonly<Record<string, string>>): string {
  const get = (name: string): string | undefined =>
    Object.hasOwn(attrs, name) ? attrs[name] : undefined
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

/** The plain text of a Task board node: the OK line, then the rows of its body. */
function tasksNodeText(text: string, n: SidebandNode): string {
  const head = tasksAttrsToOkLine(n.attrs)
  if (n.selfClosing) return head
  // The body as written (the codec decodes `n.body`; the old path kept the raw text).
  const raw = n.open && n.close ? text.slice(n.open.end, n.close.start) : (n.body ?? "")
  const inner = raw.replace(/^\n+|\n+$/g, "")
  return inner.length > 0 ? `${head}\n${inner}` : head
}

/**
 * Remove MA harness annotations before sending tool output to Cursor's wire.
 *
 * The session sideband API reads the nodes. Each node of a to-model kind
 * goes, and each node of a kind that no plugin declares (an old harness tag
 * of a resumed session). A from-model kind and a system kind (a prompt
 * section) stay. The Task board kind is special: Task historically wrapped
 * model-facing payloads in that node, so a full delete emptied every Task
 * tool_result (MA-39298). Its node becomes an OK line and its rows.
 *
 * With no codec (`sb` absent or not ready) the text does not change: no
 * parser can find a tag, and a guess can delete tool output. The plugin logs
 * this one time on its debug channel.
 *
 * @param text - The tool result text.
 * @param sb - The session sideband API (`RunContext.sideband`).
 */
export function stripMaAgentWireAnnotations(text: string, sb: SidebandApi | undefined): string {
  if (!canRead(sb)) {
    noteNoSideband()
    return text
  }
  const out = sb.replace(text, (n) => {
    // A kind that the model writes, or a prompt section, is data here: keep it.
    if (!removable(sb, n.kind)) return undefined
    return n.kind === TASKS_KIND ? tasksNodeText(text, n) : ""
  })
  return out.replace(/\n{3,}/g, "\n\n").trim()
}

/** Core kinds that hold plain text, with the prefix that the text must have. */
const PLAIN_TEXT_KINDS: Readonly<Record<string, string>> = {
  "output-truncated": "[truncated:",
  "output-streak": "[note:",
}

/** True when the lenient reader of the codec finds no tag part in `text` (also a broken one). */
const noTagPart = (text: string, sb: SidebandApi): boolean =>
  sb.strip(text, { lenient: true }) === text

/**
 * Model-facing text of a tool_result from its stored `outcome`, or `undefined`
 * when the old path must run. The old path joins the text blocks with `"\n"` and
 * strips the harness tags. This function gives the SAME bytes as the old path
 * in every case where it returns a string. The result is the body, then the
 * plain-text annotations (`[truncated: ...]`, `[note: ...]`) in append order,
 * each after `"\n\n"`. Tag annotations are not added: the strip step deletes them.
 *
 * Returns `undefined` (old path) unless ALL of these rules hold:
 * - (a) `block.outcome` is set and `viewPersistedOutcome` gives a view, and
 *   `sb` can read tags.
 * - (b) At most one text block has text. If one has, it is the FIRST text
 *   block, because the stored offsets refer to the first text block only.
 * - (c) The stored spans tile the text: the body, then each annotation, with
 *   nothing after the last annotation (so the content was not edited).
 * - (d) The lenient reader finds no tag part in the body (also a broken or
 *   upper-case one), so the strip step finds no node in the body.
 * - (e) Each annotation is of a core kind. A plain-text kind
 *   (`output-truncated`, `output-streak`) has the right prefix and no tag
 *   part. A tag kind is exactly one node of the full text, of the same kind,
 *   and the lenient reader also removes all of its text. The full text has
 *   no other node, so the strip step removes the tag annotations only.
 * - (f) Each gap between two spans is `"\n\n"` or `"\n"`, and the newlines before
 *   each plain-text annotation (gaps of the tag annotations before it
 *   included) are at least two, and exactly `"\n\n"` when no tag lies between.
 *   When the body only has white space, the first gap can also be empty
 *   (the strip step trims it in both paths).
 *
 * @param block - The tool_result block.
 * @param sb - The session sideband API (`RunContext.sideband`).
 * @returns The text before the strip step, or `undefined` for the old path.
 */
export function outcomeWireText(
  block: ToolResultBlock,
  sb: SidebandApi | undefined,
): string | undefined {
  // (a)
  if (block.outcome === undefined || !canRead(sb)) return undefined
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
  if (!noTagPart(view.body, sb)) return undefined

  // (e) Each node of the full text, in text order. Each must be a tag annotation.
  const nodes = sb.find(view.text)
  let nodeAt = 0

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
      const n = nodes[nodeAt++]
      if (n === undefined || n.kind !== a.kind) return undefined
      if (n.span.start !== a.start || n.span.end !== a.end) return undefined
      if (sb.kindInfo(n.kind) === undefined || !removable(sb, n.kind)) return undefined
      // Only the name as the codec writes it (an upper-case name is not a harness write).
      if (n.legacyQname !== undefined && n.legacyQname !== sb.name(n.kind)) return undefined
      if (sb.strip(a.text, { lenient: true }) !== "") return undefined
      sawTag = true
      continue
    }
    if (!a.text.startsWith(prefix) || !noTagPart(a.text, sb)) return undefined
    // (f) join
    if (!blankLead && (newlines < 2 || (!sawTag && gap !== "\n\n"))) return undefined
    out += `\n\n${a.text}`
    blankLead = false
    newlines = 0
    sawTag = false
  }
  // (e) no node outside the tag annotations
  if (nodeAt !== nodes.length) return undefined
  return out
}

/**
 * Flatten tool_result content to a single string for McpSuccess.content.
 *
 * @param block - The tool_result block.
 * @param sb - The session sideband API (`RunContext.sideband`).
 */
export function toolResultToWireText(block: ToolResultBlock, sb: SidebandApi | undefined): string {
  const fromOutcome = outcomeWireText(block, sb)
  if (fromOutcome !== undefined) {
    return stripMaAgentWireAnnotations(fromOutcome, sb) || "(empty tool result)"
  }
  const parts: string[] = []
  for (const c of block.content) {
    if (c.type === "text" && c.text) parts.push(c.text)
  }
  const joined = parts.join("\n") || "(empty tool result)"
  return stripMaAgentWireAnnotations(joined, sb) || "(empty tool result)"
}
