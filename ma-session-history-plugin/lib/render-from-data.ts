/**
 * Rebuild the model-facing text of session records from structured data
 * (parts, facts, raw numbers) that the host provides. Pure functions.
 *
 * @module plugins/session-history/lib/render-from-data
 */

import type {
  BodyPart,
  RecordFacts,
  RecordView,
  SearchHit,
  SessionMetaView,
  ToolCallHit,
} from "./host-types.ts"

const ELLIPSIS = "…"

/** Clip to `max` chars. The last char becomes an ellipsis when it clips. */
export function clip(s: string, max: number): { text: string; clipped: boolean } {
  if (s.length <= max) return { text: s, clipped: false }
  return { text: `${s.slice(0, max - 1)}${ELLIPSIS}`, clipped: true }
}

function partText(p: BodyPart): string {
  switch (p.kind) {
    case "thinking":
      return `[thinking] ${p.text}`
    case "tool_use":
      return `[tool_use ${p.toolName}] ${p.text}`
    case "message":
      return `${p.role}: ${p.text}`
    default:
      return p.text
  }
}

/** Full body text (pre-clip) from the parts. */
export function bodyFromParts(parts: readonly BodyPart[]): string {
  return parts.map(partText).join("\n")
}

/** Summary line from raw facts and parts. */
export function summaryFromFacts(kind: string, f: RecordFacts, parts: readonly BodyPart[]): string {
  switch (kind) {
    case "meta":
      return `meta · model ${f.model} · cwd ${f.cwd}`
    case "user": {
      if (f.contentIsString) return "user · text"
      const bits: string[] = []
      if (f.toolResultCount > 0) bits.push(`${f.toolResultCount} tool_result`)
      if (f.textBlockCount > 0) bits.push("text")
      return `user · ${bits.length > 0 ? bits.join(" + ") : `${f.blockCount} block(s)`}`
    }
    case "assistant": {
      const bits: string[] = []
      if (f.hasText) bits.push("text")
      if (f.toolNames.length > 0) {
        bits.push(`${f.toolNames.length} tool_use (${f.toolNames.join(", ")})`)
      }
      const stop = f.stopReason ? ` · stop=${f.stopReason}` : ""
      return `assistant · ${bits.length > 0 ? bits.join(" + ") : "(empty)"}${stop}`
    }
    case "tool_result":
      return `tool_result · ${f.isError ? "ERROR" : "ok"} · id ${f.toolUseId}`
    case "note":
      return "note"
    case "compact":
      return `compact · ${f.compactKind} · ${f.reason} · ${f.messagesBefore}→${f.messagesAfter}`
    case "rewind":
      return `rewind · to ${f.rewindTo} · dropped ${f.droppedCount}`
    case "history_edit":
      return `history edit · backup ${f.backupSid} · dropped ${f.droppedRecordCount}`
    case "attach":
      return `attach · pid ${f.pid} on ${f.hostname}`
    case "detach":
      return `detach · pid ${f.pid} · ${f.reason}`
    case "round_checkpoint":
      return `round checkpoint · round ${f.round}`
    case "target_switch":
      return `target switch · model ${f.model}`
    default:
      return `unknown · ${parts[0]?.text ?? ""}`
  }
}

/** Summary line of a record. */
export function summaryOf(r: RecordView): string {
  return summaryFromFacts(r.kind, r.facts, r.parts)
}

/** Clipped preview and clip flag of a record. */
export function previewOf(r: RecordView): { text: string; clipped: boolean; fullChars: number } {
  const body = bodyFromParts(r.parts)
  const c = clip(body, r.previewChars)
  return { text: c.text, clipped: c.clipped, fullChars: body.length }
}

/** Snippet of a search hit, with the match in context. */
export function snippetOf(h: SearchHit): string {
  const body = bodyFromParts(h.parts)
  const lead = Math.floor((h.previewChars - h.matchLength) / 2)
  const start = Math.max(0, h.matchAt - lead)
  const end = Math.min(body.length, start + h.previewChars)
  const core = body.slice(start, end).replace(/\s+/g, " ").trim()
  return `${start > 0 ? ELLIPSIS : ""}${core}${end < body.length ? ELLIPSIS : ""}`
}

/** Clipped input preview of a tool call. */
export function inputPreviewOf(h: ToolCallHit): string {
  return clip(h.inputJson ?? "[unserializable]", h.inputPreviewChars).text
}

/** First prompt line of a session, or null. */
export function firstPromptOf(m: SessionMetaView): string | null {
  if (m.firstPromptParts === null) return null
  const oneLine = m.firstPromptParts.join(" ").replace(/\s+/g, " ").trim()
  const max = m.firstPromptChars
  const text = oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine
  return text || null
}
