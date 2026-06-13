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
 * stop it. The live panel mirrors the sub-agents fleet widget: a header row
 * (counts) plus one breathing row per job, so the user always sees what is
 * running in the background.
 *
 * @module lib/render
 */

import { formatDuration } from "./duration.ts"
import { type JobRecord, type JobStats, type JobStatus, jobStats } from "./types.ts"

const FALLBACK_SGR = {
  bold: "\x1b[1m",
  weightReset: "\x1b[22m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  fgReset: "\x1b[39m",
} as const

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

/** Resolve style tokens from the host-injected palette environment. */
export function resolveSgr(raw = process.env.MINIMAL_AGENT_PALETTE): SgrTokens {
  const palette = parsePaletteEnv(raw)
  return {
    ...FALLBACK_SGR,
    red: palette?.red ?? FALLBACK_SGR.red,
    green: palette?.green ?? FALLBACK_SGR.green,
    yellow: palette?.yellow ?? FALLBACK_SGR.yellow,
    cyan: palette?.cyan ?? FALLBACK_SGR.cyan,
    gray: palette?.gray ?? FALLBACK_SGR.gray,
    fgReset: palette?._fgReset ?? FALLBACK_SGR.fgReset,
  }
}

function parsePaletteEnv(raw: string | undefined): Record<string, string> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") out[key] = value
    }
    return out
  } catch {
    return null
  }
}

const SGR = resolveSgr()

/** Wrap a string in the ANSI bold attribute. */
export function bold(s: string): string {
  return `${SGR.bold}${s}${SGR.weightReset}`
}
/** Wrap a string in the ANSI dim attribute. */
export function dim(s: string): string {
  return `${SGR.dim}${s}${SGR.weightReset}`
}
/** Color a string red (ANSI foreground). */
export function red(s: string): string {
  return `${SGR.red}${s}${SGR.fgReset}`
}
/** Color a string green (ANSI foreground). */
export function green(s: string): string {
  return `${SGR.green}${s}${SGR.fgReset}`
}
/** Color a string yellow (ANSI foreground). */
export function yellow(s: string): string {
  return `${SGR.yellow}${s}${SGR.fgReset}`
}
/** Color a string cyan (ANSI foreground). */
export function cyan(s: string): string {
  return `${SGR.cyan}${s}${SGR.fgReset}`
}
/** Color a string gray (ANSI bright-black foreground). */
export function gray(s: string): string {
  return `${SGR.gray}${s}${SGR.fgReset}`
}

/** A middot bullet for separating chunks on one line. */
const DOT = gray("·")

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
  const trail = trailer.length > 0 ? ` ${DOT} ${trailer.join(` ${DOT} `)}` : ""
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
  lines.push(stateBits.join(` ${DOT} `))

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

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

/** Options for {@link renderWidget}. */
export interface WidgetOptions {
  readonly tick: number
  readonly nowMs: number
  /** Max job rows before collapsing to a `+N more` line. Default 6. */
  readonly maxRows?: number
  /** Terminal width, for clipping the per-row label. Default 80. */
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

/** The spinner glyph (running) or the terminal status dot, for a panel row. */
function rowGlyph(s: JobStatus, tick: number): string {
  if (s.kind === "running") return cyan(SPINNER[tick % SPINNER.length])
  return statusDot(s)
}

/**
 * Render the live-area panel, or `null` when nothing is running (the panel
 * collapses to zero rows). One header row with counts, then one breathing row
 * per job (running first), then a `+N more` overflow line. The slot value is a
 * multi-line string; the host splits it on `\n` into footer rows. Pure.
 */
export function renderWidget(records: readonly JobRecord[], opts: WidgetOptions): string | null {
  const stats: JobStats = jobStats(records)
  if (stats.running === 0) return null

  const maxRows = opts.maxRows ?? 6
  const cols = opts.cols ?? 80

  // Header: ◆ jobs · ● R running · ✔ D done [· ✘ F failed]
  const done = stats.succeeded
  const failed = stats.exited - stats.succeeded + stats.timedout
  const headerBits = [
    `${cyan("◆")} ${cyan("jobs")}`,
    `${cyan("●")} ${cyan(`${stats.running} running`)}`,
  ]
  if (done > 0) headerBits.push(`${green("✔")} ${dim(`${done} done`)}`)
  if (failed > 0) headerBits.push(`${red("✘")} ${dim(`${failed} failed`)}`)
  if (stats.stopped > 0) headerBits.push(`${yellow("■")} ${dim(`${stats.stopped} stopped`)}`)
  const header = ` ${headerBits.join(` ${DOT} `)}`

  // Rows: running first, then most-recent terminal. Cap at maxRows.
  const ordered = [...records].sort((a, b) => rowRank(a.status) - rowRank(b.status))
  const shown = ordered.slice(0, maxRows)
  // Budget for the label = cols minus the fixed prefix (glyph+id+elapsed+gutter).
  const labelMax = Math.max(16, cols - 22)
  const lines = [header]
  for (const r of shown) {
    const glyph = rowGlyph(r.status, opts.tick)
    const id = bold(r.id.padEnd(4))
    const el = dim(elapsed(r, opts.nowMs).padStart(4))
    const label = clip(jobLabel(r, labelMax), labelMax)
    lines.push(`   ${glyph} ${id} ${el}  ${label}`)
  }
  if (ordered.length > shown.length) {
    const more = ordered.length - shown.length
    lines.push(dim(`   … +${more} more ${DOT} BackgroundStatus for all`))
  }
  return lines.join("\n")
}
