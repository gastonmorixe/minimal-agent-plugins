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

const DIM = "\x1b[2m"
const RESET_DIM = "\x1b[22m"
const RED = "\x1b[31m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const CYAN = "\x1b[36m"
const RESET_FG = "\x1b[39m"

export function dim(s: string): string {
  return `${DIM}${s}${RESET_DIM}`
}
export function red(s: string): string {
  return `${RED}${s}${RESET_FG}`
}
export function green(s: string): string {
  return `${GREEN}${s}${RESET_FG}`
}
export function yellow(s: string): string {
  return `${YELLOW}${s}${RESET_FG}`
}
export function cyan(s: string): string {
  return `${CYAN}${s}${RESET_FG}`
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
