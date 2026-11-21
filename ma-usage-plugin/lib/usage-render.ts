/**
 * Pure ANSI renderer for token-usage reports.
 *
 * Produces arrays of styled lines (no trailing newlines) for both the host
 * `usage` CLI command and plugin-owned `/usage` overlays. The renderer is a
 * leaf utility: callers inject host-specific model labeling through options
 * instead of importing the model registry here.
 *
 * @module usage-render
 */

import { displayWidth } from "@minimal-agent/core/plugin-api/utils/term-width"
import {
  USAGE_PERIODS,
  type UsageBreakdownRow,
  type UsagePeriod,
  type UsageReport,
  type UsageTotals,
} from "@minimal-agent/core/plugin-api/utils/usage-report"

import { slots } from "./style.ts"

const c = slots.styles

/** 1/8th-block ramp (shared visual language with quota-status). */
const SLICES = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"] as const
const EMPTY_CELL = "░"

/** Compact token count: `0`, `847`, `12.3k`, `1.2M`, `3.4B`. */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—"
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`
  return String(n)
}

/** Compact USD: `$0.00`, `$1.23`, `$45.60`, `$1.2k`. Sub-cent shows `<$0.01`. */
export function fmtUSD(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0.00"
  if (n < 0.01) return "<$0.01"
  if (n >= 1000) return `$${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`
  return `$${n.toFixed(2)}`
}

/** Human label for a period id (from the catalog; falls back to the id). */
export function periodLabel(period: UsagePeriod): string {
  return USAGE_PERIODS.find((p) => p.id === period)?.label ?? period
}

/**
 * Render a horizontal bar of `cells` width filling `value/max`, using the
 * 1/8th ramp. Returns `{full, empty}` so the caller colors them separately.
 */
function bar(value: number, max: number, cells: number): { full: string; empty: string } {
  if (max <= 0 || value <= 0) return { full: "", empty: EMPTY_CELL.repeat(cells) }
  const frac = Math.min(1, value / max)
  const eighths = Math.max(0, Math.min(cells * 8, Math.round(frac * cells * 8)))
  const full = Math.floor(eighths / 8)
  const part = eighths % 8
  return {
    full: "█".repeat(full) + (part ? SLICES[part]! : ""),
    empty: EMPTY_CELL.repeat(Math.max(0, cells - full - (part ? 1 : 0))),
  }
}

/** Pad a styled label to a fixed display width. */
function padLabel(label: string, width: number): string {
  const w = displayWidth(label)
  if (w >= width) return label
  return label + " ".repeat(width - w)
}

/** Truncate plain text to `width` display columns, ending in `…` when cut. */
function truncate(text: string, width: number): string {
  if (displayWidth(text) <= width) return text
  let out = ""
  for (const ch of text) {
    if (displayWidth(out + ch) > width - 1) break
    out += ch
  }
  return `${out}…`
}

/** A `[R]` / `[E]` / `[~]` marker describing a totals block's provenance. */
function provenanceMark(t: UsageTotals): string {
  if (t.turns === 0) return ""
  if (t.estimatedTurns === 0) return c.green("[R]")
  if (t.estimatedTurns === t.turns) return c.yellow("[E]")
  return c.yellow("[~]")
}

/** Longest label shown before truncating with `…`. */
const MAX_LABEL = 30

/** Column widths shared by every bar row so all sections line up. */
interface RowLayout {
  labelWidth: number
  barCells: number
  tokWidth: number
  /** 0 when no row has a cost (the column is omitted). */
  costWidth: number
}

/** A group of rows plus how to label them. */
interface RowGroup {
  rows: UsageBreakdownRow[]
  labelFn: (k: string) => string
}

/**
 * Compute one layout for all `groups`: the label column fits the longest label
 * (capped so the bar keeps room), and the token/cost columns fit their widest
 * values.
 */
function computeLayout(
  groups: RowGroup[],
  cols: number,
  bar: { min: number; max: number },
): RowLayout {
  let longestLabel = 0
  let tokWidth = 0
  let costWidth = 0
  for (const g of groups) {
    for (const r of g.rows) {
      longestLabel = Math.max(longestLabel, displayWidth(g.labelFn(r.key)))
      tokWidth = Math.max(tokWidth, fmtTokens(r.totals.tokens).length)
      if (r.totals.costUSD > 0) costWidth = Math.max(costWidth, fmtUSD(r.totals.costUSD).length)
    }
  }
  // indent(2) + label + space + bar + space + tok + [2 + cost] + [2 + mark(3)]
  const fixed = 2 + 1 + 1 + tokWidth + (costWidth ? 2 + costWidth : 0) + 5
  const labelCap = Math.max(8, Math.min(MAX_LABEL, cols - fixed - bar.min))
  const labelWidth = Math.min(Math.max(8, longestLabel), labelCap)
  const barCells = Math.max(bar.min, Math.min(bar.max, cols - fixed - labelWidth))
  return { labelWidth, barCells, tokWidth, costWidth }
}

/**
 * One breakdown row as a bar line:
 *   `anthropic   ███████████░░░░  1.2M  $4.56  [R]`
 */
function renderRow(
  row: UsageBreakdownRow,
  maxTokens: number,
  layout: RowLayout,
  labelFn: (k: string) => string,
): string {
  const label = padLabel(c.cyan(truncate(labelFn(row.key), layout.labelWidth)), layout.labelWidth)
  const { full, empty } = bar(row.totals.tokens, maxTokens, layout.barCells)
  const barStr = c.lime(full) + c.dim(empty)
  const tok = fmtTokens(row.totals.tokens).padStart(layout.tokWidth)
  const costText = row.totals.costUSD > 0 ? fmtUSD(row.totals.costUSD) : ""
  const hasMark = row.totals.estimatedTurns > 0
  // Pad the cost column only when a marker follows, so lines carry no trailing blanks.
  const costPad = hasMark ? " ".repeat(layout.costWidth - costText.length) : ""
  const cost = layout.costWidth ? `  ${costText ? c.dim(costText) : ""}${costPad}` : ""
  const mark = hasMark ? `  ${provenanceMark(row.totals)}` : ""
  const line = `  ${label} ${barStr} ${c.faintWhite(tok)}${cost}${mark}`
  return costText || hasMark ? line : `  ${label} ${barStr} ${c.faintWhite(tok)}`
}

/** Render a labeled breakdown section (a heading + bar rows). */
function renderSection(heading: string, group: RowGroup, layout: RowLayout): string[] {
  if (group.rows.length === 0) return []
  const maxTokens = group.rows.reduce((m, r) => Math.max(m, r.totals.tokens), 0)
  const out: string[] = [`  ${c.bold(heading)}`]
  for (const row of group.rows) out.push(renderRow(row, maxTokens, layout, group.labelFn))
  return out
}

/** The totals header lines. */
function renderTotalsLines(t: UsageTotals): string[] {
  if (t.turns === 0) {
    return [`  ${c.dim("no usage recorded in this period")}`]
  }
  const head = `  ${c.bold("Total")} ${c.boldCyan(fmtTokens(t.tokens))} ${c.dim("tok")}  ${provenanceMark(t)}`
  const breakdown =
    t.estimatedTurns === t.turns
      ? `    ${c.dim("(estimated from transcript text — no billed usage saved)")}`
      : `    ${c.dim("in")} ${fmtTokens(t.input)}  ${c.dim("out")} ${fmtTokens(t.output)}  ${c.dim("cache-r")} ${fmtTokens(t.cacheRead)}  ${c.dim("cache-w")} ${fmtTokens(t.cacheCreate)}  ${c.dim("·")}  ${c.green(fmtUSD(t.costUSD))}`
  const unknown = t.unknownTurns ?? 0
  // A turn with no estimator adds 0 tokens: say so, so the total is read
  // as a lower bound and not as an exact count.
  const unknownNote = unknown > 0 ? ` · ${unknown} not known (no estimator)` : ""
  const turns = `    ${c.dim(`${t.turns} turn${t.turns === 1 ? "" : "s"}${t.estimatedTurns > 0 && t.estimatedTurns < t.turns ? ` · ${t.estimatedTurns} estimated` : ""}${unknownNote}`)}`
  return [head, breakdown, turns]
}

export interface RenderUsageOpts {
  /** Total render width in columns. Default 80. */
  cols?: number
  /** Optional host-specific compact label resolver for model ids. */
  modelLabel?: (modelId: string) => string
}

/** Label a model id compactly through an injected resolver when available. */
function modelShort(k: string, opts: RenderUsageOpts): string {
  if (k === "unknown") return "unknown"
  return opts.modelLabel?.(k) || k
}

/**
 * Render the full usage report: a period heading, totals, and provider/model
 * bar charts.
 */
export function renderUsageReport(report: UsageReport, opts: RenderUsageOpts = {}): string[] {
  const cols = Math.max(48, opts.cols ?? 80)
  const out: string[] = []
  const since =
    report.period === "all" ? "all time" : `since ${new Date(report.startMs).toLocaleString()}`
  out.push("")
  out.push(
    `  ${c.bold(c.brightCyan(`Token usage — ${periodLabel(report.period)}`))}  ${c.dim(since)}`,
  )
  out.push("")
  out.push(...renderTotalsLines(report.totals))
  out.push("")

  const providers: RowGroup = { rows: report.byProvider, labelFn: (k) => k }
  const models: RowGroup = { rows: report.byModel, labelFn: (k) => modelShort(k, opts) }
  const layout = computeLayout([providers, models], cols, { min: 8, max: 40 })

  const prov = renderSection("By provider", providers, layout)
  out.push(...prov)
  if (prov.length > 0) out.push("")
  out.push(...renderSection("By model", models, layout))
  out.push("")
  return out
}

/**
 * Render the compact overlay surface (`/usage` footer): period tabs, totals,
 * top model rows, and a key hint.
 */
export function renderUsageOverlay(
  report: UsageReport,
  opts: RenderUsageOpts & { maxRows?: number } = {},
): string[] {
  const cols = Math.max(48, opts.cols ?? 80)
  const maxRows = opts.maxRows ?? 6
  const out: string[] = []

  const tabs = USAGE_PERIODS.map((p) =>
    p.id === report.period ? c.boldCyan(`[${p.label}]`) : c.dim(p.label),
  ).join("  ")
  out.push(`  ${tabs}`)

  const t = report.totals
  if (t.turns === 0) {
    out.push(`  ${c.dim("no usage recorded in this period")}`)
  } else {
    out.push(
      `  ${c.bold("Total")} ${c.boldCyan(fmtTokens(t.tokens))} ${c.dim("tok")}` +
        (t.estimatedTurns < t.turns ? `  ${c.green(fmtUSD(t.costUSD))}` : "") +
        `  ${provenanceMark(t)}  ${c.dim(`${t.turns} turn${t.turns === 1 ? "" : "s"}`)}`,
    )
  }

  const group: RowGroup = {
    rows: report.byModel.slice(0, maxRows),
    labelFn: (k) => modelShort(k, opts),
  }
  const layout = computeLayout([group], cols, { min: 6, max: 24 })
  const maxTokens = group.rows.reduce((m, r) => Math.max(m, r.totals.tokens), 0)
  for (const row of group.rows) out.push(renderRow(row, maxTokens, layout, group.labelFn))
  if (report.byModel.length > maxRows) {
    out.push(`  ${c.dim(`… +${report.byModel.length - maxRows} more model(s)`)}`)
  }

  out.push(`  ${c.dim("← →")} ${c.dim("period")}   ${c.dim("Esc")} ${c.dim("close")}`)
  return out
}
