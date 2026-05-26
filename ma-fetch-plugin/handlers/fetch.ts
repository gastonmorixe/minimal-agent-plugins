/**
 * Tool-call handler for `Fetch`.
 *
 * Pipeline:
 *   1. Validate `ctx.trigger.input` (URL, format, etc.).
 *   2. Load plugin config from `~/.minimal-agent/config.jsonc`.
 *   3. Merge `defaults` with per-call input → BackendCallInput.
 *   4. Invoke the backend via `lib/backend.ts:callBackend`.
 *   5. Shape `TUIResult.tool_result` with ANSI `display` for the
 *      transcript and raw page content for `content` (the model).
 *
 * The handler is backend-agnostic: everything obscura-specific lives in
 * `backends/obscura.ts`. Tomorrow we swap to a different backend by
 * changing `plugins["ma-fetch"].backend` in user config and dropping a
 * `backends/<name>.ts` next to it - no handler edit required.
 *
 * @module handlers/fetch
 */

import { callBackend, type BackendCallInput, type BackendDeps } from "../lib/backend.ts"
import {
  defaultConfig,
  loadFetchConfig,
  type FetchConfig,
  type FetchFormat,
  type WaitUntil,
} from "../lib/config.ts"
import type { TUIContext, TUIResult } from "../lib/types.ts"

const VALID_FORMATS = new Set<FetchFormat>(["markdown", "text", "html", "links", "original"])
const VALID_WAIT_UNTIL = new Set<WaitUntil>(["load", "domcontentloaded", "networkidle0"])

const PREVIEW_LINES = 12
const PREVIEW_LINE_WIDTH = 300

export interface ParsedInput {
  url: string
  format?: FetchFormat
  selector?: string
  evalExpr?: string
  waitUntil?: WaitUntil
  timeoutSec?: number
}

export type ValidateResult =
  | { ok: true; value: ParsedInput }
  | { ok: false; error: string }

/** Validate the raw tool input. Returns parsed values or an error message. */
export function validateInput(raw: Record<string, unknown>): ValidateResult {
  // url (required, http/https only)
  if (typeof raw.url !== "string" || raw.url.trim().length === 0) {
    return { ok: false, error: "`url` is required and must be a non-empty string" }
  }
  const url = raw.url.trim()
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, error: "`url` must start with http:// or https://" }
  }
  if (url.length > 4096) {
    return { ok: false, error: "`url` exceeds 4096 characters" }
  }

  const out: ParsedInput = { url }

  if (raw.format !== undefined) {
    if (typeof raw.format !== "string" || !VALID_FORMATS.has(raw.format as FetchFormat)) {
      return {
        ok: false,
        error: `\`format\` must be one of: ${[...VALID_FORMATS].join(", ")}`,
      }
    }
    out.format = raw.format as FetchFormat
  }

  if (raw.selector !== undefined) {
    if (typeof raw.selector !== "string") {
      return { ok: false, error: "`selector` must be a string" }
    }
    const s = raw.selector.trim()
    if (s.length > 0) out.selector = s
  }

  if (raw.eval !== undefined) {
    if (typeof raw.eval !== "string") {
      return { ok: false, error: "`eval` must be a string" }
    }
    if (raw.eval.length > 0) out.evalExpr = raw.eval
  }

  if (raw.wait_until !== undefined) {
    if (
      typeof raw.wait_until !== "string" ||
      !VALID_WAIT_UNTIL.has(raw.wait_until as WaitUntil)
    ) {
      return {
        ok: false,
        error: `\`wait_until\` must be one of: ${[...VALID_WAIT_UNTIL].join(", ")}`,
      }
    }
    out.waitUntil = raw.wait_until as WaitUntil
  }

  if (raw.timeout_sec !== undefined) {
    if (
      typeof raw.timeout_sec !== "number" ||
      !Number.isFinite(raw.timeout_sec) ||
      raw.timeout_sec < 1 ||
      raw.timeout_sec > 120
    ) {
      return { ok: false, error: "`timeout_sec` must be an integer between 1 and 120" }
    }
    out.timeoutSec = Math.floor(raw.timeout_sec)
  }

  return { ok: true, value: out }
}

/** Merge config defaults with parsed input → finalized BackendCallInput. */
export function mergeInputs(parsed: ParsedInput, config: FetchConfig): BackendCallInput {
  return {
    url: parsed.url,
    format: parsed.format ?? config.defaults.format,
    waitUntil: parsed.waitUntil ?? config.defaults.waitUntil,
    timeoutSec: parsed.timeoutSec ?? config.defaults.timeoutSec,
    selector: parsed.selector,
    evalExpr: parsed.evalExpr,
  }
}

// ---------------------------------------------------------------------------
// ANSI display rendering
// ---------------------------------------------------------------------------

const DIM = "\x1b[2m"
const RESET = "\x1b[22m"
const RED = "\x1b[31m"
const RESET_FG = "\x1b[39m"

function dim(s: string): string {
  return `${DIM}${s}${RESET}`
}

function red(s: string): string {
  return `${RED}${s}${RESET_FG}`
}

/** Compact byte formatter: 1.2 KB, 13.2 KB, 1.5 MB. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

/** Truncate a single line's display width (ASCII-cell heuristic). */
function truncLine(line: string, max: number): string {
  // Cheap heuristic: strip control bytes for width counting, then slice.
  if (line.length <= max) return line
  return `${line.slice(0, max - 1)}…`
}

/**
 * Normalize whitespace noise in markdown / text output.
 *
 * Stopgap fix for HTML→markdown converter quirks (notably obscura on
 * Wikipedia / GitHub / MDPI) that emit massive runs of blank or
 * whitespace-only lines for empty container elements. On a Wikipedia
 * article the conversion produces 651 lines, 85 % of which are blank
 * or whitespace, with one run of 47 consecutive blank lines. This
 * helper collapses that to 175 lines (-73 %) without touching content.
 *
 * Three transformations, all idempotent:
 *   1. `rstrip` every line (drop trailing spaces/tabs).
 *   2. Collapse runs of 2+ blank-or-whitespace-only lines into a SINGLE
 *      blank line.
 *   3. Strip leading + trailing blank lines.
 *
 * Applied ONLY to `markdown` and `text` formats. `html`, `links`, and
 * `original` pass through verbatim: HTML newlines are syntactically
 * significant in <pre>/<textarea>, link lists are one-per-line by
 * design, and `original` is the raw byte stream from the backend.
 *
 * Exported so tests and future tooling can call it directly.
 */
export function normalizeMarkdown(input: string): string {
  if (input.length === 0) return input
  const lines = input.split("\n")
  for (let i = 0; i < lines.length; i++) {
    lines[i] = lines[i].replace(/[\t ]+$/, "")
  }
  const out: string[] = []
  let prevBlank = false
  for (const l of lines) {
    const isBlank = l.length === 0
    if (isBlank && prevBlank) continue
    out.push(l)
    prevBlank = isBlank
  }
  while (out.length > 0 && out[0] === "") out.shift()
  while (out.length > 0 && out[out.length - 1] === "") out.pop()
  return out.join("\n")
}

/** Formats for which `normalizeMarkdown` is a sound transformation. */
const NORMALIZABLE_FORMATS = new Set<FetchFormat>(["markdown", "text"])

/**
 * Apply the markdown normalizer iff the format is one of the
 * normalizable ones. Pass-through for HTML / links / original.
 */
function maybeNormalize(content: string, format: FetchFormat): string {
  return NORMALIZABLE_FORMATS.has(format) ? normalizeMarkdown(content) : content
}

/** Build the body lines (`display` field) - first N lines, width-clamped. */
export function buildDisplayBody(content: string, lines: number = PREVIEW_LINES): string {
  if (content.length === 0) return dim("(empty response)")
  const all = content.split("\n")
  // Drop a single trailing empty line (common when content ends in `\n`).
  if (all.length > 0 && all[all.length - 1] === "") all.pop()
  const slice = all.slice(0, lines)
  return slice.map((l) => truncLine(l, PREVIEW_LINE_WIDTH)).join("\n")
}

/** Build the footer line - format · size · line count · backend. */
export function buildDisplayFooter(opts: {
  format: FetchFormat
  size: number
  lineCount: number
  backend: string
  truncated?: boolean
}): string {
  const parts = [
    opts.format,
    formatBytes(opts.size),
    `${opts.lineCount} lines`,
    `via ${opts.backend}`,
  ]
  const main = parts.map(dim).join(dim(" · "))
  if (opts.truncated) {
    return `${main} ${dim("·")} ${dim("preview truncated")}`
  }
  return main
}

/** Default export: the tool handler the loader will invoke. */
const handler = async (ctx: TUIContext): Promise<TUIResult> => {
  if (ctx.trigger.type !== "tool") {
    return { kind: "tool_result", content: "Fetch: wrong trigger type", is_error: true }
  }

  const v = validateInput(ctx.trigger.input)
  if (!v.ok) {
    return {
      kind: "tool_result",
      content: `Fetch: ${v.error}`,
      is_error: true,
      displayHeader: red("invalid input"),
      display: dim(v.error),
    }
  }

  const config = loadFetchConfig()
  if (!config.enabled) {
    return {
      kind: "tool_result",
      content: "Fetch: plugin is disabled in user config (plugins[\"ma-fetch\"].enabled = false)",
      is_error: true,
    }
  }

  const input = mergeInputs(v.value, config)
  return await runWithDeps(ctx, config, input, {})
}

/**
 * Test-injectable inner. Exported so handler tests can pass a fake
 * `spawnFn`/`existsFn` via `BackendDeps` without spawning a real
 * subprocess or hitting disk.
 */
export async function runWithDeps(
  ctx: TUIContext,
  config: FetchConfig,
  input: BackendCallInput,
  deps: BackendDeps,
): Promise<TUIResult> {
  const result = await callBackend(ctx.packageDir, config, input, ctx.abort, deps)

  if (result.scriptMissing) {
    return {
      kind: "tool_result",
      content: `Fetch: ${result.stderr}\n\nCheck plugins["ma-fetch"].backend in ~/.minimal-agent/config.jsonc, or drop a backends/<name>.ts in the plugin directory.`,
      is_error: true,
      displayHeader: red("backend missing"),
      display: dim(result.stderr),
      displayFooter: dim(`backend: ${config.backend}`),
    }
  }

  if (result.aborted) {
    return {
      kind: "tool_result",
      content: `Fetch: aborted by user (partial stdout: ${result.stdout.length} bytes)`,
      is_error: true,
      displayHeader: red(`${input.url}  aborted`),
      display: dim("(aborted)"),
      displayFooter: dim(`via ${result.backend}`),
    }
  }

  if (!result.ok) {
    // Surface obscura's stderr to the model. Keep it concise.
    const stderrTail = result.stderr.trim().split("\n").slice(-10).join("\n")
    return {
      kind: "tool_result",
      content: `Fetch: backend exited with code ${result.exitCode}\n\n${stderrTail || "(no stderr output)"}`,
      is_error: true,
      displayHeader: red(`${input.url}  exit ${result.exitCode}`),
      display: stderrTail ? dim(stderrTail) : dim("(no diagnostics)"),
      displayFooter: dim(`${input.format} · via ${result.backend}`),
    }
  }

  // Success. Run the markdown normalizer on `markdown` and `text` formats
  // BEFORE building `display` + `content`. HTML→markdown converters
  // (notably obscura on Wikipedia / GitHub) emit massive runs of
  // whitespace-only lines that bloat the model's view of the page
  // without adding signal; the normalizer collapses 47-line blank
  // runs to a single blank without touching content. Pass-through
  // for `html` / `links` / `original` (newlines are significant
  // there). See `normalizeMarkdown` JSDoc.
  const content = maybeNormalize(result.stdout, input.format)
  const size = Buffer.byteLength(content, "utf-8")
  const lineCount = content.length === 0 ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0)

  const displayBody = buildDisplayBody(content, PREVIEW_LINES)
  const truncated = lineCount > PREVIEW_LINES
  const displayFooter = buildDisplayFooter({
    format: input.format,
    size,
    lineCount,
    backend: result.backend,
    truncated,
  })

  return {
    kind: "tool_result",
    content,
    display: displayBody,
    displayHeader: input.url,
    displayFooter,
  }
}

export default handler
