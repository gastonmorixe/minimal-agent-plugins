/**
 * The live fleet widget: a multi-line string that the supervisor heartbeat
 * gives to the sticky bottom live area. The look is the same as the live
 * tool tree of the CLI:
 *
 * ```
 * ● Fleet 3f2a · 2 running · 46 done · 6 incomplete · 2 failed · Σctx 1200k · out 80k
 * ├ ● A55 step14-wp opus-5.5:high 15m47 ✎ Now S5 (built-in tool text) 103 tools ✘3 · 146k
 * ├ ○ A57 step14-wp sonnet:max     6m20 Bash sleep 60; cat /tmp/v3.log 55 tools ✘1 · 109k
 * ╰ ✘ 2 failed · ⚠ 6 incomplete · ✔ 46 done · +51 more · SubAgentsListAgents
 * ```
 *
 * - Only active workers (running, then queued) get a row, at most `maxRows`.
 * - Terminal workers (done, incomplete, failed, stopped) do not get a row.
 *   Their counts go into one summary row at the bottom, together with
 *   `+N more` for the active workers that do not fit.
 * - The dot of a running row blinks `●` / `○`, one frame each second. The
 *   period (2 to 5 frames) and the phase of a row come from a hash of its id,
 *   so the rows blink independently and do not stay in step.
 *   With `fade`, the `●` goes from the color to dim in {@link FADE_STEPS} steps.
 * - No row is wider than `columns - 1` cells.
 * - The widget is `null` (no lines) when no worker is active.
 *
 * Pure: records and options go in, a string or null comes out. The core
 * multi-row live-area seam (it splits a slot value on `"\n"`) paints it.
 *
 * @module sub-agents/lib/widget
 */

import { displayWidth, truncateDisplayWidth } from "@minimal-agent/core/plugin-api/utils/term-width"

import { ANSI, color, fmtElapsed, fmtFleetSpend, fmtTokens, GLYPHS } from "./style.ts"
import { fleetStats, type Progress, type SubagentRecord } from "./types.ts"

/** Options for {@link renderWidget}. */
export interface WidgetOptions {
  readonly ansi: boolean
  /** Monotonic tick. Kept for compatibility: the blink uses `nowMs`. */
  readonly tick: number
  /** Epoch ms (for elapsed times and for the blink). */
  readonly nowMs: number
  /** The lead session id (its first 4 chars label the fleet). */
  readonly leadSid: string
  /** Max worker rows before the rest goes into the summary row. Default 6. */
  readonly maxRows?: number
  /** Token total above which the fleet total is painted GOLD (cost warning). */
  readonly tokenBudget?: number
  /** Terminal width. Rows are at most `columns - 1` cells. Default 120. */
  readonly columns?: number
  /** Fade the `●` in truecolor. `false` (default): only the glyph changes. */
  readonly fade?: boolean
}

/** One blink frame lasts this long. A full cycle is two frames. */
export const BLINK_FRAME_MS = 1000

/** The steps of the fade of a `●` in truecolor. */
export const FADE_STEPS = 5

/** The default terminal width when the host gives none. */
export const DEFAULT_COLUMNS = 120

/** The maximum width of the model column. */
const MODEL_COL_MAX = 18

/** Seconds without a stream event before a running row shows `idle`. */
export const IDLE_HINT_SEC = 60

type RGB = readonly [number, number, number]

/** The dim end of the fade. */
const DIM_RGB: RGB = [96, 96, 96]

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const

/** The RGB of a foreground SGR open sequence (`38;2` or `38;5`), or `null`. */
function sgrToRgb(open: string): RGB | null {
  const rgb = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(open)
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  const idx = /\x1b\[38;5;(\d+)m/.exec(open)
  if (!idx) return null
  const i = Number(idx[1])
  if (i >= 232) {
    const level = 8 + (i - 232) * 10
    return [level, level, level]
  }
  if (i < 16) return null
  const n = i - 16
  return [
    CUBE_LEVELS[Math.floor(n / 36)] ?? 0,
    CUBE_LEVELS[Math.floor(n / 6) % 6] ?? 0,
    CUBE_LEVELS[n % 6] ?? 0,
  ]
}

function mix(from: RGB, to: RGB, t: number): RGB {
  const at = (i: 0 | 1 | 2): number => Math.round(from[i] + (to[i] - from[i]) * t)
  return [at(0), at(1), at(2)]
}

/** The blink rhythm of a row: `period` frames per cycle, shifted by `phase` frames. */
export interface BlinkPattern {
  readonly period: number
  readonly phase: number
}

/** The header dot: a plain on/off cycle of two frames. */
export const HEADER_BLINK: BlinkPattern = { period: 2, phase: 0 }

/** The cycle lengths (in frames) that a row can get. */
const BLINK_PERIODS = [2, 3, 4, 5] as const

/** FNV-1a hash of a string (32 bit). Ids that differ by one char get far values. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * The blink rhythm of a row, from a stable hash of the worker id. The period
 * and the phase both come from the hash, so rows go in and out of step and do
 * not blink together.
 */
export function blinkPattern(id: string): BlinkPattern {
  const h = fnv1a(id)
  const period = BLINK_PERIODS[h % BLINK_PERIODS.length] ?? 2
  const phase = Math.floor(h / BLINK_PERIODS.length) % period
  return { period, phase }
}

/**
 * The blinking dot at `nowMs`. In each cycle of `period` frames, the first
 * `ceil(period / 2)` frames show `●`, the others `○`. With `fade` (and `ansi`),
 * the `●` goes from SKY to dim over its frame.
 */
export function blinkDot(
  pattern: BlinkPattern,
  nowMs: number,
  ansi: boolean,
  fade: boolean,
): string {
  const frame = Math.floor(nowMs / BLINK_FRAME_MS)
  const at = (((frame + pattern.phase) % pattern.period) + pattern.period) % pattern.period
  const on = at < Math.ceil(pattern.period / 2)
  if (!on) return color(ansi, ANSI.SKY, GLYPHS.dotOff)
  const from = ansi && fade ? sgrToRgb(ANSI.SKY) : null
  if (!from) return color(ansi, ANSI.SKY, GLYPHS.dotOn)
  const into = nowMs - frame * BLINK_FRAME_MS
  const step = Math.min(FADE_STEPS - 1, Math.floor((into / BLINK_FRAME_MS) * FADE_STEPS))
  const [r, g, b] = mix(from, DIM_RGB, step / FADE_STEPS)
  return color(ansi, `\x1b[38;2;${r};${g};${b}m`, GLYPHS.dotOn)
}

function shortSid(sid: string): string {
  return sid.replace(/-/g, "").slice(0, 4)
}

const TIERS = ["opus", "sonnet", "haiku", "fable"] as const

/**
 * Short model + effort tag for a row: `opus-5.5:high`, `haiku-4.5`,
 * `sonnet:max`. The tier word and the version come from the model id; a
 * date suffix is removed. An unknown id is shown as it is, clipped to 16
 * chars. The effort is added when set. Empty when nothing is known.
 */
export function modelTag(model: string | undefined, effort: string | undefined): string {
  const raw = (model ?? "").trim()
  const m = raw.toLowerCase()
  const tier = TIERS.find((t) => m.includes(t))
  let base = ""
  if (tier) {
    // The version: the number parts after the tier word, without a date (8 digits).
    const after = m.slice(m.indexOf(tier) + tier.length)
    const parts = (after.match(/\d+/g) ?? []).filter((p) => p.length < 8).slice(0, 2)
    base = parts.length > 0 ? `${tier}-${parts.join(".")}` : tier
  } else if (raw) {
    base = raw.length <= 16 ? raw : `${raw.slice(0, 15)}…`
  }
  if (!base) return effort ?? ""
  return effort ? `${base}:${effort}` : base
}

/** The model tag of a record: the resolved values first, then the plan. */
function tagFor(r: SubagentRecord): string {
  const p = r.status.kind === "running" ? r.status.progress : undefined
  return modelTag(p?.model ?? r.model, p?.effort ?? r.effort)
}

/**
 * What a running worker is doing at this instant. With stream telemetry this
 * is exact: the tool in flight and for how long, `thinking…`, or the text
 * being written. Without it (an old worker) it falls back to the last
 * activity parsed from the transcript.
 */
function liveActivity(p: Progress, nowMs: number): string {
  // No event and no transcript activity yet: the worker is still booting.
  const fresh = p.tools === 0 && p.tokens === 0 && !p.lastActivity && !p.lastTool
  if (fresh && (p.phase === undefined || p.phase === "starting")) return "starting…"
  const base = (p.lastActivity ?? p.lastTool ?? "working").replace(/\s+/g, " ").trim()
  switch (p.phase) {
    case "starting":
      return "starting…"
    case "thinking":
      return "thinking…"
    case "writing":
      return `✎ ${base}`
    case "tool": {
      const took = p.toolSince !== undefined ? fmtElapsed(nowMs - p.toolSince) : ""
      return took ? `${base} (${took})` : base
    }
    default:
      return base
  }
}

/** `9 tools` or `9 tools ✘1`, the failed-call count in red. */
function toolCount(p: { tools: number; toolErrors?: number }, ansi: boolean): string {
  const tools = color(ansi, ANSI.DGRAY, `${p.tools} tools`)
  return p.toolErrors
    ? `${tools} ${color(ansi, ANSI.RED, `${GLYPHS.failed}${p.toolErrors}`)}`
    : tools
}

/** Cut `text` to `budget` cells, with `…` at the end. */
function cut(text: string, budget: number): string {
  if (budget <= 0) return ""
  return truncateDisplayWidth(text, budget, "…")
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

/** The fixed columns of one row, shared by all rows. */
interface Layout {
  readonly idW: number
  readonly tagW: number
  readonly budget: number
}

/** One active worker row (running or queued), at most `budget` cells. */
function agentRow(r: SubagentRecord, tree: string, layout: Layout, opts: WidgetOptions): string {
  const { ansi, nowMs } = opts
  const s = r.status
  const tag = tagFor(r)
  const tagText = tag ? cut(tag, layout.tagW) : GLYPHS.unknown
  const tagPad = " ".repeat(Math.max(0, layout.tagW - displayWidth(tagText)))
  const tagCol = tag
    ? color(ansi, ANSI.DIM, `${tagText}${tagPad}`)
    : `${color(ansi, ANSI.DIM, tagText)}${tagPad}`
  const id = color(ansi, ANSI.BOLD, r.id.padEnd(layout.idW))
  const label = color(ansi, ANSI.LGRAY, r.label.padEnd(9).slice(0, 9))
  const elapsed = s.kind === "running" ? fmtElapsed(nowMs - Date.parse(s.startedAt)) : ""
  const el = color(ansi, ANSI.DGRAY, elapsed.padStart(5))
  const lead = color(ansi, ANSI.DGRAY, tree)

  if (s.kind !== "running") {
    const dot = color(ansi, ANSI.DIM, GLYPHS.dotQueued)
    const row = `${lead} ${dot} ${id} ${label} ${tagCol} ${el} ${color(ansi, ANSI.DIM, "queued…")}`
    return cut(row, layout.budget)
  }

  const p = s.progress
  const dot = blinkDot(blinkPattern(r.id), nowMs, ansi, opts.fade === true)
  const head = `${lead} ${dot} ${id} ${label} ${tagCol} ${el} `
  const idleMs = p.lastEventAt !== undefined ? nowMs - p.lastEventAt : 0
  // A tool call can run long legitimately, so only flag a silent stream
  // when no tool is in flight. In the grace after SIGTERM, say "stopping".
  const idle = s.grace
    ? ` ${color(ansi, ANSI.GOLD, "stopping")}`
    : p.phase !== "tool" && idleMs >= IDLE_HINT_SEC * 1000
      ? ` ${color(ansi, ANSI.GOLD, `idle ${fmtElapsed(idleMs)}`)}`
      : ""
  const right = ` ${toolCount(p, ansi)} ${color(ansi, ANSI.DGRAY, `${GLYPHS.bullet} ${fmtTokens(p.tokens)}`)}`
  const room = layout.budget - displayWidth(head) - displayWidth(idle) - displayWidth(right)
  const act = cut(oneLine(liveActivity(p, nowMs)), room)
  // The last cut is a guard for a very narrow terminal.
  return cut(`${head}${act}${idle}${right}`, layout.budget)
}

/** The summary row: terminal counts, `+N more`, and the list hint. Or null. */
function summaryRow(
  stats: ReturnType<typeof fleetStats>,
  more: number,
  ansi: boolean,
  budget: number,
): string | null {
  const parts: string[] = []
  if (stats.failed > 0) parts.push(color(ansi, ANSI.RED, `${GLYPHS.failed} ${stats.failed} failed`))
  if (stats.incomplete > 0)
    parts.push(color(ansi, ANSI.GOLD, `${GLYPHS.incomplete} ${stats.incomplete} incomplete`))
  if (stats.done > 0) parts.push(color(ansi, ANSI.LIME, `${GLYPHS.done} ${stats.done} done`))
  if (stats.stopped > 0)
    parts.push(color(ansi, ANSI.RED, `${GLYPHS.failed} ${stats.stopped} stopped`))
  if (more > 0) parts.push(color(ansi, ANSI.LGRAY, `+${more} more`))
  if (parts.length === 0) return null
  parts.push(color(ansi, ANSI.DGRAY, "SubAgentsListAgents"))
  const sep = ` ${color(ansi, ANSI.DGRAY, GLYPHS.bullet)} `
  return cut(`${color(ansi, ANSI.DGRAY, GLYPHS.treeLast)} ${parts.join(sep)}`, budget)
}

/**
 * Render the fleet widget, or `null` when no worker is active (queued or
 * running): the fleet is done, so the sticky area collapses to nothing.
 */
export function renderWidget(
  records: readonly SubagentRecord[],
  opts: WidgetOptions,
): string | null {
  const stats = fleetStats(records)
  const active = stats.queued + stats.running
  if (active === 0) return null

  const ansi = opts.ansi
  const maxRows = Math.max(1, opts.maxRows ?? 6)
  const budget = Math.max(20, (opts.columns ?? DEFAULT_COLUMNS) - 1)
  const sep = ` ${color(ansi, ANSI.DGRAY, GLYPHS.bullet)} `

  // Header: ● Fleet 3f2a · 2 running · 1 queued · 46 done · ... · <spend>
  const dot = blinkDot(HEADER_BLINK, opts.nowMs, ansi, opts.fade === true)
  const counts = [color(ansi, ANSI.SKY, `${stats.running} running`)]
  if (stats.queued > 0) counts.push(color(ansi, ANSI.DIM, `${stats.queued} queued`))
  if (stats.done > 0) counts.push(color(ansi, ANSI.LIME, `${stats.done} done`))
  if (stats.incomplete > 0) counts.push(color(ansi, ANSI.GOLD, `${stats.incomplete} incomplete`))
  if (stats.failed > 0) counts.push(color(ansi, ANSI.RED, `${stats.failed} failed`))
  if (stats.stopped > 0) counts.push(color(ansi, ANSI.RED, `${stats.stopped} stopped`))
  const overBudget = opts.tokenBudget !== undefined && stats.tokens > opts.tokenBudget
  counts.push(color(ansi, overBudget ? ANSI.GOLD : ANSI.DGRAY, fmtFleetSpend(stats)))
  const fleet = color(ansi, ANSI.BOLD, `Fleet ${shortSid(opts.leadSid)}`)
  const header = cut(`${dot} ${fleet}${sep}${counts.join(sep)}`, budget)

  // Active rows only: running first, then queued (the order of the records stays).
  const activeRecs = [
    ...records.filter((r) => r.status.kind === "running"),
    ...records.filter((r) => r.status.kind === "queued"),
  ]
  const shown = activeRecs.slice(0, maxRows)
  const more = activeRecs.length - shown.length
  const tags = shown.map((r) => tagFor(r) || GLYPHS.unknown)
  const layout: Layout = {
    idW: Math.max(3, ...shown.map((r) => r.id.length)),
    tagW: Math.min(MODEL_COL_MAX, Math.max(1, ...tags.map((t) => displayWidth(t)))),
    budget,
  }
  const summary = summaryRow(stats, more, ansi, budget)
  const lines = [header]
  shown.forEach((r, i) => {
    const last = summary === null && i === shown.length - 1
    lines.push(agentRow(r, last ? GLYPHS.treeLast : GLYPHS.treeMid, layout, opts))
  })
  if (summary !== null) lines.push(summary)
  return lines.join("\n")
}
