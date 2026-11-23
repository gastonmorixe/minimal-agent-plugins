/**
 * ANSI display helpers + transcript shaping for the background-job tools.
 *
 * Pure functions only: given a {@link JobRecord} (or a list), produce the
 * `display` / `displayHeader` / `displayFooter` chrome the loader paints in the
 * transcript, plus the breathing multi-line live-area panel. No process state,
 * no IO.
 *
 * The model-facing `content` strings live in the handlers, this module owns the
 * human-facing transcript chrome.
 *
 * # What the user sees
 *
 * A `BackgroundRun` / `BackgroundStatus` block no longer collapses a job into a
 * single opaque line. It shows the **command actually run**, the **state +
 * elapsed + pid**, the **timeout**, the **cwd**, the **log file path** (so the
 * user can `tail -f` it), and the **exact follow-up tool calls** to read or
 * stop it. The live panel uses the layout of the sub-agents fleet widget:
 *
 * ```
 * ● Jobs · 1 running · 1 done · 1 failed
 * ├ ● j1     5s build the app
 * ├ ✔ j2     3s bun test
 * ├ ✘ j3     1s bun run lint
 * ╰ ✘ 1 failed · ✔ 1 done · BackgroundStatus
 * ```
 *
 * The header dot and each running dot blink `●` and `○` by `nowMs`. Each job
 * gets one tree row, running jobs first. Terminal jobs keep their rows. The
 * `╰` summary row shows the terminal counts and `+N more`. When there is no
 * summary, the last job row gets the `╰`. No row is wider than `cols - 1`.
 *
 * @module lib/render
 */

import { displayWidth } from "@minimal-agent/core/plugin-api/utils/term-width"

import { blinkDot, blinkPattern, cut, HEADER_BLINK } from "./blink.ts"
import { formatDuration } from "./duration.ts"
import { slots } from "./style.ts"
import { type JobRecord, type JobStats, type JobStatus, jobStats } from "./types.ts"

export interface SgrTokens {
  readonly bold: string
  readonly weightReset: string
  readonly dim: string
  readonly red: string
  readonly green: string
  readonly yellow: string
  readonly cyan: string
  readonly gray: string
  readonly fgReset: string
}

/**
 * The style tokens of this module (S41). They come from the style slots,
 * read at call time, so they are plain until the CLI runs `ui/setup.ts`.
 */
function sgr(): SgrTokens {
  return {
    bold: slots.codes.BOLD,
    weightReset: slots.codes.BOLD_CLOSE,
    dim: slots.codes.DIM,
    red: slots.palette.red,
    green: slots.palette.green,
    yellow: slots.palette.yellow,
    cyan: slots.palette.cyan,
    gray: slots.codes.BRIGHT_BLACK,
    fgReset: slots.codes.FG_RESET,
  }
}

/** Wrap a string in the ANSI bold attribute. */
export function bold(s: string): string {
  return `${sgr().bold}${s}${sgr().weightReset}`
}
/** Wrap a string in the ANSI dim attribute. */
export function dim(s: string): string {
  return `${sgr().dim}${s}${sgr().weightReset}`
}
/** Color a string red (ANSI foreground). */
export function red(s: string): string {
  return `${sgr().red}${s}${sgr().fgReset}`
}
/** Color a string green (ANSI foreground). */
export function green(s: string): string {
  return `${sgr().green}${s}${sgr().fgReset}`
}
/** Color a string yellow (ANSI foreground). */
export function yellow(s: string): string {
  return `${sgr().yellow}${s}${sgr().fgReset}`
}
/** Color a string cyan (ANSI foreground). */
export function cyan(s: string): string {
  return `${sgr().cyan}${s}${sgr().fgReset}`
}
/** Color a string gray (ANSI bright-black foreground). */
export function gray(s: string): string {
  return `${sgr().gray}${s}${sgr().fgReset}`
}

/** A middot bullet for separating chunks on one line. */
function dot(): string {
  return gray("·")
}

/** Clip to one bounded line (collapse whitespace, ellipsize). Pure. */
export function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim()
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`
}

/** Replace a leading `$HOME` with `~` for a shorter, friendlier path. Pure. */
export function tildify(path: string, home?: string): string {
  const h = (home ?? process.env.HOME ?? "").replace(/\/+$/, "")
  if (h.length > 0 && (path === h || path.startsWith(`${h}/`))) {
    return `~${path.slice(h.length)}`
  }
  return path
}

/** A colored glyph + word per status, for compact rendering. */
export function statusGlyph(s: JobStatus): string {
  switch (s.kind) {
    case "running":
      return cyan("● running")
    case "exited":
      return s.exitCode === 0 ? green("✔ done") : red(`✘ exit ${s.exitCode ?? "?"}`)
    case "timedout":
      return yellow("⧖ timed out")
    case "stopped":
      return yellow("■ stopped")
    case "orphaned":
      return gray("⚠ orphaned")
    default: {
      const _exhaustive: never = s
      throw new Error(`unhandled status kind: ${String(_exhaustive)}`)
    }
  }
}

/** Just the colored glyph (no word) per status, for dense rows. */
export function statusDot(s: JobStatus): string {
  switch (s.kind) {
    case "running":
      return cyan("●")
    case "exited":
      return s.exitCode === 0 ? green("✔") : red("✘")
    case "timedout":
      return yellow("⧖")
    case "stopped":
      return yellow("■")
    case "orphaned":
      return gray("⚠")
    default: {
      const _exhaustive: never = s
      throw new Error(`unhandled status kind: ${String(_exhaustive)}`)
    }
  }
}

/** Plain (uncolored) status word, for the model-facing `content`. */
export function statusWord(s: JobStatus): string {
  switch (s.kind) {
    case "exited":
      return s.exitCode === 0 ? "done" : `failed (exit ${s.exitCode ?? "?"})`
    case "running":
      return "running"
    case "timedout":
      return "timed out"
    case "stopped":
      return "stopped"
    case "orphaned":
      return "orphaned"
    default: {
      const _exhaustive: never = s
      throw new Error(`unhandled status kind: ${String(_exhaustive)}`)
    }
  }
}

/**
 * Elapsed/total time descriptor for a record relative to `nowMs`. Pure.
 *
 * Sub-second elapsed renders as `"0s"`, NOT via `formatDuration`: a 0 ms
 * duration would otherwise hit the `INFINITE_MS` (0) sentinel and print `∞`
 * for a job that just started (the exact confusing glyph in the original
 * widget).
 */
export function elapsed(r: JobRecord, nowMs: number): string {
  const startMs = Date.parse(r.spawnedAt)
  if (!Number.isFinite(startMs)) return ""
  const endMs = endMsOf(r.status)
  const ms = Math.max(0, (endMs ?? nowMs) - startMs)
  if (ms < 1000) return "0s"
  return formatDuration(ms)
}

function endMsOf(s: JobStatus): number | undefined {
  switch (s.kind) {
    case "exited":
    case "timedout":
    case "stopped":
    case "orphaned":
      return Date.parse(s.endedAt)
    case "running":
      return undefined
    default: {
      const _exhaustive: never = s
      throw new Error(`unhandled status kind: ${String(_exhaustive)}`)
    }
  }
}

/** Short label for a job: its description, else the (clipped) command. Pure. */
export function jobLabel(r: JobRecord, max = 56): string {
  return clip(r.description ? r.description : r.command, max)
}

// ---------------------------------------------------------------------------
// Transcript blocks (the bordered ╭ … ╰ tool result)
// ---------------------------------------------------------------------------

/**
 * Header content slot for a job block (rendered after the manifest icon+label,
 * before the agent's ` · HH:MM:SS` time suffix). Compact identity + live state:
 *
 *   `j13 ● running · 0s · pid 4823`
 *   `j7 ✔ done · 1m`
 *
 * Pure.
 */
export function jobHeaderContent(r: JobRecord, nowMs: number): string {
  const el = elapsed(r, nowMs)
  const bits = [bold(r.id), statusGlyph(r.status)]
  const trailer: string[] = []
  if (el) trailer.push(dim(el))
  if (r.status.kind === "running") trailer.push(dim(`pid ${r.jobPid ?? r.runnerPid}`))
  const trail = trailer.length > 0 ? ` ${dot()} ${trailer.join(` ${dot()} `)}` : ""
  return `${bits.join(" ")}${trail}`
}

/**
 * The multi-line body of a job block, rendered between the `╭` header and the
 * `╰` closer. Each returned line is one transcript row (the host adds the
 * `│`/`╰` gutter). Answers, at a glance: what ran, where it logs, how to follow
 * it live, how it ended. Pure.
 */
export function jobBlock(r: JobRecord, nowMs: number): string {
  const lines: string[] = []

  // 1. The command actually run (the thing the user had no visibility into).
  const cmdFirstLine = r.command.split("\n")[0] ?? r.command
  const multiline = r.command.includes("\n")
  const cmd = clip(cmdFirstLine, 110)
  lines.push(`${cyan("$")} ${cmd}${multiline ? dim(" ↵ …") : ""}`)

  // 2. Optional human description, when distinct from the command.
  if (r.description && r.description.trim() !== cmdFirstLine.trim()) {
    lines.push(dim(`“${clip(r.description, 96)}”`))
  }

  // 3. State line: status · elapsed · pid · timeout/end-reason.
  const stateBits: string[] = [statusGlyph(r.status)]
  const el = elapsed(r, nowMs)
  if (el) stateBits.push(dim(el))
  if (r.status.kind === "running") {
    stateBits.push(dim(`pid ${r.jobPid ?? r.runnerPid}`))
    stateBits.push(
      dim(r.timeoutMs === 0 ? "no timeout" : `times out in ${formatDuration(r.timeoutMs)}`),
    )
  } else if (r.status.kind === "stopped" && r.status.reason) {
    stateBits.push(dim(r.status.reason))
  } else if (r.status.kind === "orphaned") {
    stateBits.push(dim(r.status.reason))
  } else if (r.status.kind === "exited" && r.status.signal) {
    stateBits.push(dim(`signal ${r.status.signal}`))
  }
  lines.push(stateBits.join(` ${dot()} `))

  // 4. cwd · log file path (so the user can tail -f it in another terminal).
  lines.push(`${dim("cwd")} ${dim(tildify(r.cwd))}`)
  lines.push(`${dim("log")} ${dim(tildify(r.logPath))}`)

  // 5. Exact follow-up calls. Live jobs get read/stop; finished get read.
  const actions =
    r.status.kind === "running"
      ? `${cyan("▤")} BackgroundLogs ${r.id}   ${cyan("◎")} BackgroundStatus ${r.id}   ${red("■")} BackgroundStop ${r.id}`
      : `${cyan("▤")} BackgroundLogs ${r.id}`
  lines.push(dim(actions))

  return lines.join("\n")
}

/** One compact line describing a job, for list bodies. Pure. */
export function jobLine(r: JobRecord, nowMs: number): string {
  const time = elapsed(r, nowMs)
  const meta = [time, jobLabel(r, 56)].filter((x) => x.length > 0).join(" · ")
  return `${bold(r.id)}  ${statusGlyph(r.status)}  ${dim(meta)}`
}

/** Render many jobs as lines (one per job). Pure. */
export function jobLines(records: readonly JobRecord[], nowMs: number): string {
  if (records.length === 0) return dim("(no background jobs)")
  return records.map((r) => jobLine(r, nowMs)).join("\n")
}

// ---------------------------------------------------------------------------
// Live-area panel (the breathing footer) — multi-line, like the fleet widget
// ---------------------------------------------------------------------------

/** Options for {@link renderWidget}. */
export interface WidgetOptions {
  /** Monotonic tick. Kept for compatibility: the blink uses `nowMs`. */
  readonly tick: number
  /** Epoch ms, for the elapsed times and for the blink. */
  readonly nowMs: number
  /** Max job rows before the rest goes into the `+N more` of the summary row. Default 6. */
  readonly maxRows?: number
  /** Terminal width. No row is wider than `cols - 1` cells. Default 80. */
  readonly cols?: number
}

/** Sort key: running first, then timed out / orphaned, then stopped, then done. */
function rowRank(s: JobStatus): number {
  switch (s.kind) {
    case "running":
      return 0
    case "timedout":
      return 1
    case "orphaned":
      return 2
    case "stopped":
      return 3
    case "exited":
      return 4
    default: {
      const _exhaustive: never = s
      throw new Error(`unhandled status kind: ${String(_exhaustive)}`)
    }
  }
}

/** Paint `text` in the dark gray of the fleet chrome (tree glyphs, separators). */
function chrome(text: string): string {
  return slots.color(true, slots.codes.DARK_GRAY, text)
}

/** Paint `text` in a palette color. Plain until the UI setup runs. */
function paint(open: string, text: string): string {
  return slots.color(true, open, text)
}

/** The ` · ` separator of the panel, in the chrome color. */
function sep(): string {
  return ` ${chrome("·")} `
}

/** The counts of the panel that the header and the summary row show. */
interface PanelCounts {
  readonly running: number
  readonly done: number
  readonly failed: number
  readonly stopped: number
}

function panelCounts(stats: JobStats): PanelCounts {
  return {
    running: stats.running,
    done: stats.succeeded,
    // A timed out job counts as failed, as before.
    failed: stats.exited - stats.succeeded + stats.timedout,
    stopped: stats.stopped,
  }
}

/** The header row: blink dot, bold `Jobs`, then the colored counts. */
function headerRow(c: PanelCounts, nowMs: number, budget: number): string {
  const counts = [paint(slots.palette.sky, `${c.running} running`)]
  if (c.done > 0) counts.push(paint(slots.palette.lime, `${c.done} done`))
  if (c.failed > 0) counts.push(paint(slots.palette.red, `${c.failed} failed`))
  if (c.stopped > 0) counts.push(paint(slots.palette.gold, `${c.stopped} stopped`))
  const title = bold("Jobs")
  return cut(`${blinkDot(HEADER_BLINK, nowMs)} ${title}${sep()}${counts.join(sep())}`, budget)
}

/** The dot of a job row: a blink dot when the job runs, else its status glyph. */
function rowDot(r: JobRecord, nowMs: number): string {
  if (r.status.kind === "running") return blinkDot(blinkPattern(r.id), nowMs)
  return statusDot(r.status)
}

/** One job row, at most `budget` cells: tree glyph, dot, id, elapsed, label. */
function jobRow(r: JobRecord, tree: string, idW: number, nowMs: number, budget: number): string {
  const id = bold(r.id.padEnd(idW))
  const el = chrome(elapsed(r, nowMs).padStart(5))
  const head = `${chrome(tree)} ${rowDot(r, nowMs)} ${id} ${el} `
  const text = (r.description ? r.description : r.command).replace(/\s+/g, " ").trim()
  const label = cut(text, budget - displayWidth(head))
  // The last cut is a guard for a very narrow terminal.
  return cut(`${head}${label}`, budget)
}

/** The summary row: terminal counts, `+N more`, and the status hint. Or null. */
function summaryRow(c: PanelCounts, more: number, budget: number): string | null {
  const parts: string[] = []
  if (c.failed > 0) parts.push(paint(slots.palette.red, `✘ ${c.failed} failed`))
  if (c.stopped > 0) parts.push(paint(slots.palette.gold, `■ ${c.stopped} stopped`))
  if (c.done > 0) parts.push(paint(slots.palette.lime, `✔ ${c.done} done`))
  if (more > 0) parts.push(slots.color(true, slots.codes.LIGHT_GRAY, `+${more} more`))
  if (parts.length === 0) return null
  parts.push(chrome("BackgroundStatus"))
  return cut(`${chrome("╰")} ${parts.join(sep())}`, budget)
}

/**
 * Render the live-area panel, or `null` when no job runs (the panel then has
 * no rows). The layout is the same as the sub-agents fleet widget: a header
 * row, one tree row for each job (running first), and a `╰` summary row with
 * the terminal counts and `+N more`. Terminal jobs keep their rows. No row is
 * wider than `cols - 1` cells. The host splits the value on `\n`. Pure.
 */
export function renderWidget(records: readonly JobRecord[], opts: WidgetOptions): string | null {
  const stats: JobStats = jobStats(records)
  if (stats.running === 0) return null

  const maxRows = Math.max(1, opts.maxRows ?? 6)
  const budget = Math.max(20, (opts.cols ?? 80) - 1)
  const counts = panelCounts(stats)

  // Rows: running first, then the terminal jobs. At most maxRows.
  const ordered = [...records].sort((a, b) => rowRank(a.status) - rowRank(b.status))
  const shown = ordered.slice(0, maxRows)
  const idW = Math.max(3, ...shown.map((r) => r.id.length))
  const summary = summaryRow(counts, ordered.length - shown.length, budget)

  const lines = [headerRow(counts, opts.nowMs, budget)]
  shown.forEach((r, i) => {
    const last = summary === null && i === shown.length - 1
    lines.push(jobRow(r, last ? "╰" : "├", idW, opts.nowMs, budget))
  })
  if (summary !== null) lines.push(summary)
  return lines.join("\n")
}
