import type { Task } from "./parse.ts"
import type { Stats } from "./store.ts"

export interface TaskModelMeta {
  action?: string
  result?: string
  id?: string
}

/** Extra fields for plain-text tool_result lines (not used on attachment tags). */
export interface TaskToolMeta extends TaskModelMeta {
  coerced?: readonly string[]
  parentAutoDone?: string
  reason?: string
  /** Rows replaced by an explicit replace_plan action. */
  replaced?: number
}

function cleanText(s: string): string {
  return s
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function attr(s: string): string {
  return cleanText(s).replace(/"/g, "&quot;")
}

function fmtDur(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return ""
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return `${m}m${rs.toString().padStart(2, "0")}s`
  const h = Math.floor(m / 60)
  const rm = m % 60
  if (h < 24) return `${h}h${rm.toString().padStart(2, "0")}m`
  const d = Math.floor(h / 24)
  const rh = h % 24
  return `${d}d${rh.toString().padStart(2, "0")}h`
}

/**
 * Render tasks as a canonical-id columnar table for the model.
 *
 * Each row is `ID  STATUS  TITLE` with optional `  DURATION` suffix.
 * Children are indented two spaces. Canonical ids are ordinal roots (`1`)
 * and child ids (`1a`), with no extra position or internal-id column.
 *
 * Named `renderTasksColumnar` (not `renderTasksMarkdown`) because the output
 * is a fixed-width columnar table, not a Markdown ordered list.
 */
export function renderTasksColumnar(tasks: readonly Task[]): string {
  if (tasks.length === 0) return "_No tasks._"

  let idWidth = 0
  for (const t of tasks) {
    idWidth = Math.max(idWidth, t.id.length)
  }

  const lines: string[] = []
  for (const t of tasks) {
    const indent = t.parent !== null ? "  " : ""
    const idCol = t.id.padEnd(idWidth)
    const statusCol = t.status.padEnd(8)
    const durText = fmtDur(t.active_ms)
    const durSuffix = durText.length > 0 ? `  ${durText}` : ""
    const reasonSuffix = t.status === "canceled" && t.reason ? ` (${cleanText(t.reason)})` : ""
    lines.push(`${indent}${idCol}  ${statusCol}  ${cleanText(t.title)}${reasonSuffix}${durSuffix}`)
  }
  return lines.join("\n")
}

/**
 * One-line plain-text ack / header for tool_result content.
 *
 * Shape: `OK <result> [action=…] [id=…] … total=N done=N doing=N todo=N canceled=N`
 * No XML. Survives Cursor `stripMaAgentWireAnnotations` (MA-39298).
 */
export function formatTasksOkLine(stats: Stats, meta: TaskToolMeta = {}): string {
  const result = (meta.result ?? "ok").replace(/[\r\n\t]+/g, " ").trim() || "ok"
  const parts: string[] = [`OK ${result}`]
  if (meta.action) parts.push(`action=${meta.action.replace(/[\s=]+/g, "_")}`)
  if (meta.id) {
    const id = meta.id.replace(/^#/, "").replace(/[\s=]+/g, "")
    if (id) parts.push(`id=${id}`)
  }
  if (meta.parentAutoDone) {
    const id = meta.parentAutoDone.replace(/^#/, "").replace(/[\s=]+/g, "")
    if (id) parts.push(`parent_auto_done=${id}`)
  }
  if (meta.coerced?.length) {
    parts.push(`coerced=${meta.coerced.map((c) => c.replace(/[\s,=]+/g, "_")).join(",")}`)
  }
  if (meta.reason) {
    const safe = meta.reason
      .replace(/[\r\n\t]+/g, " ")
      .replace(/"/g, "'")
      .slice(0, 120)
    parts.push(`reason="${safe}"`)
  }
  if (meta.replaced !== undefined) parts.push(`replaced=${meta.replaced}`)
  parts.push(
    `total=${stats.total}`,
    `done=${stats.done}`,
    `doing=${stats.doing}`,
    `todo=${stats.todo}`,
    `canceled=${stats.canceled}`,
  )
  return parts.join(" ")
}

/**
 * Full-board tool_result: OK header + canonical-id rows.
 * Used for create/list/clear and other actions that dump the board mid-turn.
 */
export function renderTasksToolContent(
  tasks: readonly Task[],
  stats: Stats,
  meta: TaskToolMeta = {},
): string {
  return `${formatTasksOkLine(stats, meta)}\n${renderTasksColumnar(tasks)}`
}

/**
 * Compact mutation ack (start/done/status): OK line only, no board dump.
 * Next-turn attachment still carries the board for human+model.
 */
export function renderTasksCompactAck(stats: Stats, meta: TaskToolMeta = {}): string {
  return formatTasksOkLine(stats, meta)
}

/**
 * Wrap the columnar task list in a `<ma::agent::tasks>` block.
 *
 * For **turn attachments / harness inject only**. Do not put this in
 * tool_result `content` — Cursor strips `ma::agent::*` from the wire
 * (MA-39298). Prefer {@link renderTasksToolContent} for tool results.
 */
export function renderTasksAgentBlock(
  tasks: readonly Task[],
  stats: Stats,
  meta: TaskModelMeta = {},
): string {
  const attrs: string[] = []
  if (meta.action) attrs.push(`action="${attr(meta.action)}"`)
  if (meta.result) attrs.push(`result="${attr(meta.result)}"`)
  if (meta.id) attrs.push(`id="${attr(meta.id.replace(/^#/, ""))}"`)
  attrs.push(
    `total="${stats.total}"`,
    `done="${stats.done}"`,
    `doing="${stats.doing}"`,
    `todo="${stats.todo}"`,
    `canceled="${stats.canceled}"`,
  )
  return `<ma::agent::tasks ${attrs.join(" ")}>\n${renderTasksColumnar(tasks)}\n</ma::agent::tasks>`
}
