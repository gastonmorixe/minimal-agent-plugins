/**
 * ANSI display helpers + transcript shaping for the speech tools.
 *
 * Pure functions only: given a {@link SpeechJob} (or a list), produce the
 * `display` / `displayHeader` / `displayFooter` strings the loader paints in
 * the transcript. No process state, no IO, fully unit-testable.
 *
 * The model-facing `content` strings live in the handlers; this module owns
 * the human-facing transcript chrome.
 *
 * @module lib/render
 */

import type { SpeechJob, SpeechState } from "./registry.ts"

const FALLBACK_SGR = {
  dim: "\x1b[2m",
  weightReset: "\x1b[22m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  fgReset: "\x1b[39m",
} as const

export interface SgrTokens {
  readonly dim: string
  readonly weightReset: string
  readonly red: string
  readonly green: string
  readonly yellow: string
  readonly cyan: string
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

/** A glyph + colorizer per state, for compact status rendering. */
export function stateGlyph(state: SpeechState): string {
  switch (state) {
    case "speaking":
      return cyan("♪ speaking")
    case "done":
      return green("✔ done")
    case "failed":
      return red("✘ failed")
    case "stopped":
      return yellow("■ stopped")
  }
}

/** Plain (uncolored) state word, for the model-facing `content`. */
export function stateWord(state: SpeechState): string {
  return state
}

/** Format a millisecond duration compactly: `0.4s`, `12s`, `1m03s`. */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0
  const totalSec = ms / 1000
  if (totalSec < 10) return `${totalSec.toFixed(1)}s`
  const sec = Math.round(totalSec)
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}m${String(s).padStart(2, "0")}s`
}

/** Elapsed time for a job: ended-started if terminal, else now-started. */
export function jobElapsedMs(job: SpeechJob, now: number): number {
  const end = job.endedAt ?? now
  return end - job.startedAt
}

/**
 * One transcript line summarizing a job:
 *   `s1  ♪ speaking  pid 4242  ·  "hello there"`
 */
export function renderJobLine(job: SpeechJob, now: number): string {
  const parts = [
    cyan(job.id),
    stateGlyph(job.state),
    dim(`pid ${job.pid || "?"}`),
    dim(formatDuration(jobElapsedMs(job, now))),
  ]
  const head = parts.join(dim("  "))
  return `${head}  ${dim("·")}  ${dim(`"${job.preview}"`)}`
}

/** Multi-line body for a list of jobs (used by SpeakStatus with no id). */
export function renderJobList(jobs: SpeechJob[], now: number): string {
  if (jobs.length === 0) return dim("(no speech jobs this session)")
  return jobs.map((j) => renderJobLine(j, now)).join("\n")
}

/** Footer: `macos-say · 123 chars`, optionally with state. */
export function renderFooter(job: SpeechJob): string {
  const parts = [job.backend, `${job.charCount} chars`]
  return parts.map(dim).join(dim(" · "))
}
