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

function renderTaskLines(
  t: Task,
  n: number,
  indent: string,
  lines: string[],
  childrenByParent: ReadonlyMap<string, readonly Task[]>,
): void {
  const marker = `${n}. `
  const dur = fmtDur(t.active_ms)
  const durSuffix = dur.length > 0 ? ` _${dur}_` : ""
  lines.push(`${indent}${marker}${t.status} \`#${t.id}\` ${cleanText(t.title)}${durSuffix}`)
  if (t.status === "canceled" && t.reason) {
    lines.push(`${indent}${" ".repeat(marker.length)}- reason: ${cleanText(t.reason)}`)
  }

  const children = childrenByParent.get(t.id) ?? []
  const childIndent = `${indent}${" ".repeat(marker.length)}`
  children.forEach((child, idx) =>
    renderTaskLines(child, idx + 1, childIndent, lines, childrenByParent),
  )
}

/** Render tasks as Markdown-compatible ordered-list content for the model. */
export function renderTasksMarkdown(tasks: readonly Task[]): string {
  if (tasks.length === 0) return "_No tasks._"

  const ids = new Set(tasks.map((t) => t.id))
  const childrenByParent = new Map<string, Task[]>()
  const roots: Task[] = []
  const orphans: Task[] = []

  for (const t of tasks) {
    if (t.parent === null) {
      roots.push(t)
    } else if (!ids.has(t.parent)) {
      orphans.push(t)
    } else {
      const children = childrenByParent.get(t.parent) ?? []
      children.push(t)
      childrenByParent.set(t.parent, children)
    }
  }

  const lines: string[] = []
  const top = [...roots, ...orphans]
  top.forEach((t, idx) => renderTaskLines(t, idx + 1, "", lines, childrenByParent))
  return lines.join("\n")
}

/** Wrap the model-facing Markdown task list in a `<ma::agent::tasks>` block. */
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
  return `<ma::agent::tasks ${attrs.join(" ")}>\n${renderTasksMarkdown(tasks)}\n</ma::agent::tasks>`
}
