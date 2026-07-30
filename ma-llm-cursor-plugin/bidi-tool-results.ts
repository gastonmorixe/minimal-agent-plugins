/**
 * Tool-result helpers for bidi continuation detection.
 *
 * @module llm/providers/cursor/bidi-tool-results
 */

import type { CanonicalMessage, ToolResultBlock } from "./lib/canonical-messages.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"

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

/** Remove MA harness annotations before sending tool output to Cursor's wire. */
export function stripMaAgentWireAnnotations(text: string): string {
  let out = text
  // Paired tags (output-preview, tasks, short-term-memory, …).
  out = out.replace(/<ma::agent::([a-z0-9-]+)\b[^>]*>[\s\S]*?<\/ma::agent::\1>/gi, "")
  // Self-closing tags (mode-active, raw-output, mode-change, …).
  out = out.replace(/<ma::agent::[^>]+\/>/g, "")
  return out.replace(/\n{3,}/g, "\n\n").trim()
}

/** Flatten tool_result content to a single string for McpSuccess.content. */
export function toolResultToWireText(block: ToolResultBlock): string {
  const parts: string[] = []
  for (const c of block.content) {
    if (c.type === "text" && c.text) parts.push(c.text)
  }
  const joined = parts.join("\n") || "(empty tool result)"
  return stripMaAgentWireAnnotations(joined) || "(empty tool result)"
}
