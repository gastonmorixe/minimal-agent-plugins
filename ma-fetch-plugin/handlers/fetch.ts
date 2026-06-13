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

import { join } from "node:path"

import { type BackendCallInput, type BackendDeps, callBackend } from "../lib/backend.ts"
import {
  applyCleanup,
  CLEANUP_LEVELS,
  type CleanupLevel,
  isCleanableFormat,
} from "../lib/cleanup.ts"
import {
  type FetchConfig,
  type FetchFormat,
  loadFetchConfig,
  SESSION_NAME_PATTERN,
  type WaitUntil,
} from "../lib/config.ts"
import { classifyBackendFailure, FetchError, writeTraceLog } from "../lib/errors.ts"
import type { TUIContext, TUIResult } from "../lib/types.ts"

const VALID_FORMATS = new Set<FetchFormat>(["markdown", "text", "html", "links", "original"])
const VALID_WAIT_UNTIL = new Set<WaitUntil>(["load", "domcontentloaded", "networkidle0"])
const VALID_CLEANUP = new Set<CleanupLevel>(CLEANUP_LEVELS)

const PREVIEW_LINES = 12
const PREVIEW_LINE_WIDTH = 300

export interface ParsedInput {
  url: string
  format?: FetchFormat
  selector?: string
  evalExpr?: string
  waitUntil?: WaitUntil
  timeoutSec?: number
  cleanup?: CleanupLevel
  /**
   * Session selector, kept as the source the caller passed:
   *   - `undefined` → use `config.defaults.session` (or no session)
   *   - `""`        → explicit "no session for this call" (override default)
   *   - `<name>`    → use this session (validated against SESSION_NAME_PATTERN)
   *
   * The distinction matters: a missing field falls back to config, an
   * empty string opts out. Same pattern as a Python `None` vs `""`.
   */
  session?: string
}

export type ValidateResult = { ok: true; value: ParsedInput } | { ok: false; error: string }

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
    if (typeof raw.wait_until !== "string" || !VALID_WAIT_UNTIL.has(raw.wait_until as WaitUntil)) {
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

  if (raw.cleanup !== undefined) {
    if (typeof raw.cleanup !== "string" || !VALID_CLEANUP.has(raw.cleanup as CleanupLevel)) {
      return {
        ok: false,
        error: `\`cleanup\` must be one of: ${[...VALID_CLEANUP].join(", ")}`,
      }
    }
    out.cleanup = raw.cleanup as CleanupLevel
  }

  if (raw.session !== undefined) {
    if (typeof raw.session !== "string") {
      return { ok: false, error: "`session` must be a string" }
    }
    // Empty string is a valid "opt-out" sentinel (overrides any config
    // default for this one call). Non-empty must match the regex.
    if (raw.session.length > 0 && !SESSION_NAME_PATTERN.test(raw.session)) {
      return {
        ok: false,
        error:
          "`session` must be 1-64 chars, alphanumeric / `-` / `_` only, starting with alnum. " +
          'Pass `""` to opt out of any config-default session for this call.',
      }
    }
    out.session = raw.session
  }

  return { ok: true, value: out }
}

/**
 * Resolve the session selector + config into an absolute storage directory.
 *
 * Three cases:
 *   1. `parsed.session === ""` → explicit opt-out, returns `undefined`.
 *   2. `parsed.session` is a non-empty name → `<storageRoot>/<name>`.
 *   3. `parsed.session === undefined` and `config.defaults.session` set
 *      → `<storageRoot>/<default-name>`.
 *   4. Otherwise → `undefined` (stateless one-shot fetch).
 *
 * The returned path is guaranteed to be a direct child of `storageRoot`
 * — the model can't escape via `..`, slashes, or any other shape because
 * the name was already constrained by SESSION_NAME_PATTERN at validation.
 *
 * Exposed for tests.
 */
export function resolveSessionDir(parsed: ParsedInput, config: FetchConfig): string | undefined {
  // Case 1: explicit opt-out.
  if (parsed.session === "") return undefined
  // Case 2: per-call name wins over default.
  const name = parsed.session ?? config.defaults.session
  if (!name) return undefined
  // SESSION_NAME_PATTERN already excludes "/", "\\", "..", etc., so the
  // join below cannot path-traverse. Double-check as a belt-and-suspenders
  // hedge against a future regex relaxation.
  if (!SESSION_NAME_PATTERN.test(name)) return undefined
  return join(config.storageRoot, name)
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
    storageDir: resolveSessionDir(parsed, config),
  }
}

/** Resolve the effective cleanup level: per-call beats config default. */
export function resolveCleanup(parsed: ParsedInput, config: FetchConfig): CleanupLevel {
  return parsed.cleanup ?? config.defaults.cleanup
}

// ---------------------------------------------------------------------------
// ANSI display rendering
// ---------------------------------------------------------------------------

const FALLBACK_SGR = {
  dim: "\x1b[2m",
  weightReset: "\x1b[22m",
  red: "\x1b[31m",
  fgReset: "\x1b[39m",
} as const

export interface SgrTokens {
  readonly dim: string
  readonly weightReset: string
  readonly red: string
  readonly fgReset: string
}

/** Resolve style tokens from the host-injected palette environment. */
export function resolveSgr(raw?: string): SgrTokens {
  const palette = parsePaletteEnv(raw)
  return {
    ...FALLBACK_SGR,
    red: palette?.red ?? FALLBACK_SGR.red,
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

let SGR = resolveSgr()

/** Configure display styling from the host-provided context palette. */
export function configureSgr(raw?: string): void {
  SGR = resolveSgr(raw)
}

function dim(s: string): string {
  return `${SGR.dim}${s}${SGR.weightReset}`
}

function red(s: string): string {
  return `${SGR.red}${s}${SGR.fgReset}`
}

/** Compact byte formatter: 1.2 KB, 13.2 KB, 1.5 MB. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

/**
 * Truncate a single line to `max` display cells (ASCII-cell heuristic:
 * one UTF-16 code unit ≈ one cell). Preview-only, so wide/zero-width chars
 * are not measured precisely; the goal is just to keep the transcript row
 * from overflowing.
 */
function truncLine(line: string, max: number): string {
  if (line.length <= max) return line
  return `${line.slice(0, max - 1)}…`
}

/**
 * Backwards-compat re-export of the long-standing markdown normalizer.
 * New code should import `cleanupBasic` from `lib/cleanup.ts` directly.
 *
 * Behavior is unchanged: rstrip per line, collapse 2+ blank-line runs,
 * strip leading/trailing blank lines.
 */
export { cleanupBasic as normalizeMarkdown } from "../lib/cleanup.ts"

/**
 * Apply the configured cleanup level iff the format is markdown/text.
 * Pass-through for HTML / links / original (newlines are significant).
 */
function maybeCleanup(content: string, format: FetchFormat, level: CleanupLevel): string {
  if (!isCleanableFormat(format)) return content
  return applyCleanup(content, level)
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

/** Build the footer line - format · size · line count [· session].
 *
 *  The rendering engine is deliberately NOT shown. The Fetch tool is
 *  backend-agnostic by contract: nothing the caller (model) or the
 *  transcript sees may reveal which engine served the page. Backend
 *  identity lives only in the operator's config + the plugin README. */
export function buildDisplayFooter(opts: {
  format: FetchFormat
  size: number
  lineCount: number
  truncated?: boolean
  /** When set, the call wrote to / read from this session. The footer
   *  shows just the leaf name (`twitter`), not the full path. */
  sessionName?: string
}): string {
  const parts = [opts.format, formatBytes(opts.size), `${opts.lineCount} lines`]
  if (opts.sessionName && opts.sessionName.length > 0) {
    parts.push(`session: ${opts.sessionName}`)
  }
  const main = parts.map(dim).join(dim(" · "))
  if (opts.truncated) {
    return `${main} ${dim("·")} ${dim("preview truncated")}`
  }
  return main
}

/** Default export: the tool handler the loader will invoke. */
const handler = async (ctx: TUIContext): Promise<TUIResult> => {
  configureSgr(ctx.env.MINIMAL_AGENT_PALETTE)

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
      content: 'Fetch: plugin is disabled in user config (plugins["ma-fetch"].enabled = false)',
      is_error: true,
    }
  }

  const input = mergeInputs(v.value, config)
  const cleanup = resolveCleanup(v.value, config)
  return await runWithDeps(ctx, config, input, {}, cleanup)
}

/**
 * Test-injectable inner. Exported so handler tests can pass a fake
 * `spawnFn`/`existsFn` via `BackendDeps` without spawning a real
 * subprocess or hitting disk.
 *
 * `cleanup` defaults to `"basic"` (long-standing behavior) when not
 * supplied — keeps existing tests that call `runWithDeps` directly
 * without a level passing.
 */
export async function runWithDeps(
  ctx: TUIContext,
  config: FetchConfig,
  input: BackendCallInput,
  deps: BackendDeps,
  cleanup: CleanupLevel = "basic",
): Promise<TUIResult> {
  configureSgr(ctx.env.MINIMAL_AGENT_PALETTE)

  const result = await callBackend(ctx.packageDir, config, input, ctx.abort, deps)

  if (result.scriptMissing || result.binUnavailable) {
    // Plugin-misconfiguration path. Generic by design: the model must not
    // learn which render engine is (or isn't) installed. Two distinct causes
    // collapse to one message: the backend SCRIPT is missing (broken plugin
    // checkout), or the managed BINARY couldn't be resolved (provisioning did
    // not run / was skipped, and no operator override is set). Operators fix
    // either via config + the ma-fetch plugin README.
    return fetchErrorResult(
      new FetchError(
        "engine-unavailable",
        "Fetch: the render engine is unavailable (ma-fetch plugin misconfiguration). See the plugin README for setup.",
      ),
      input.url,
      input.format,
    )
  }

  if (result.aborted) {
    // Distinguish a genuine user cancel (Ctrl+C / mode-toggle) from an
    // internal kill. The wall-clock watchdog fires when the backend wedges
    // past its own `--timeout`; reporting that as "aborted by user" is false
    // and misleads the model. Parent-exit shutdown is likewise not the user
    // abandoning this single call.
    const partial = `partial output: ${result.stdout.length} bytes`
    if (result.abortReason === "watchdog") {
      return fetchErrorResult(
        new FetchError(
          "timeout",
          `Fetch: the page exceeded the time budget and was stopped (${partial}).`,
        ),
        input.url,
        input.format,
      )
    }
    if (result.abortReason === "parent-exit") {
      return fetchErrorResult(
        new FetchError(
          "aborted",
          `Fetch: stopped because the agent is shutting down (${partial}).`,
        ),
        input.url,
        input.format,
      )
    }
    return fetchErrorResult(
      new FetchError("aborted", `Fetch: aborted by user (${partial}).`),
      input.url,
      input.format,
    )
  }

  if (!result.ok) {
    // Classify into a typed, backend-agnostic error. Raw stderr never
    // reaches the model: a recognized failure becomes a clean message; an
    // unrecognized one gets a generic message + an opaque ref id, with the
    // full detail (incl. stderr) written to an operator-only trace whose
    // path is never disclosed.
    let err = classifyBackendFailure({ exitCode: result.exitCode, stderr: result.stderr })
    if (err.kind === "unknown") {
      const traceId = writeTraceLog({
        url: input.url,
        backend: result.backend,
        exitCode: result.exitCode,
        stderr: result.stderr,
        kind: err.kind,
      })
      err = new FetchError(
        "unknown",
        `Fetch: the page could not be fetched (exit code ${result.exitCode}).`,
        { exitCode: result.exitCode, traceId },
      )
    }
    return fetchErrorResult(err, input.url, input.format)
  }

  // Success. Run the cleanup pass on `markdown`/`text` BEFORE building
  // `display` + `content`. HTML→markdown converters (notably obscura on
  // Wikipedia / GitHub / Bloomberg) emit massive runs of blank or
  // whitespace-only lines that bloat the model's view of the page
  // without adding signal. Level is set by the caller (per-call param,
  // falling back to config default, falling back to "basic").
  //
  // Pass-through for `html` / `links` / `original` regardless of level
  // (newlines are syntactically significant in those). See `lib/cleanup.ts`.
  const content = maybeCleanup(result.stdout, input.format, cleanup)
  const size = Buffer.byteLength(content, "utf-8")
  const lineCount =
    content.length === 0 ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0)

  const displayBody = buildDisplayBody(content, PREVIEW_LINES)
  const truncated = lineCount > PREVIEW_LINES
  const displayFooter = buildDisplayFooter({
    format: input.format,
    size,
    lineCount,
    truncated,
    sessionName: sessionLeafName(input.storageDir),
  })

  return {
    kind: "tool_result",
    content,
    display: displayBody,
    displayHeader: input.url,
    displayFooter,
  }
}

/** Extract the leaf name from a session directory path for the footer.
 *  Returns `undefined` when no path was set. Pure. */
export function sessionLeafName(storageDir: string | undefined): string | undefined {
  if (!storageDir) return undefined
  // `path.basename` handles trailing slash too; doing it by hand keeps the
  // function dependency-free and self-evident.
  const trimmed = storageDir.replace(/[/\\]+$/, "")
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

/**
 * Render a typed `FetchError` into a `tool_result`.
 *
 * Single choke point for failure output. Everything here is
 * backend-agnostic: `err.message` is a hand-written, engine-free string,
 * and `err.traceId` (when present) is an opaque correlation handle. The
 * trace's filesystem path is never referenced, so the model has no artifact
 * to go hunting for. Pure apart from the ANSI helpers.
 */
export function fetchErrorResult(err: FetchError, url: string, format: FetchFormat): TUIResult {
  const ref = err.traceId ? ` [ref: ${err.traceId}]` : ""
  const body = err.message.replace(/^Fetch:\s*/, "")
  return {
    kind: "tool_result",
    content: `${err.message}${ref}`,
    is_error: true,
    displayHeader: red(`${url}  ${err.kind}`),
    display: dim(`${body}${ref}`),
    displayFooter: dim(format),
  }
}

export default handler
