import type { Task } from "./parse.ts"
import type { Stats } from "./store.ts"

export interface TaskModelMeta {
  action?: string
  result?: string
  id?: string
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
 * Render tasks as a hash-only columnar table for the model.
 *
 * Each row is `#HASH  STATUS  TITLE` with optional `  DURATION` suffix.
 * Children are indented two spaces (tree cue only — not an addressable id).
 * Position numbers and `1a`-style coords are intentionally omitted so the
 * model has one stable address: the `#hash`.
 *
 * Named `renderTasksColumnar` (not `renderTasksMarkdown`) because the output
 * is a fixed-width columnar table, not a Markdown ordered list.
 */
export function renderTasksColumnar(tasks: readonly Task[]): string {
  if (tasks.length === 0) return "_No tasks._"

  let idWidth = 0
  for (const t of tasks) {
    idWidth = Math.max(idWidth, t.id.length + 1) // +1 for leading '#'
  }

  const lines: string[] = []
  for (const t of tasks) {
    const indent = t.parent !== null ? "  " : ""
    const idCol = `#${t.id}`.padEnd(idWidth)
    const statusCol = t.status.padEnd(8)
    const durText = fmtDur(t.active_ms)
    const durSuffix = durText.length > 0 ? `  ${durText}` : ""
    const reasonSuffix = t.status === "canceled" && t.reason ? ` (${cleanText(t.reason)})` : ""
    lines.push(`${indent}${idCol}  ${statusCol}  ${cleanText(t.title)}${reasonSuffix}${durSuffix}`)
  }
  return lines.join("\n")
}

/** Wrap the model-facing columnar task list in a `<ma::agent::tasks>` block. */
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
