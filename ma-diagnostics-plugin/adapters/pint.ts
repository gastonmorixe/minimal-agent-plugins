/**
 * Adapter: Laravel Pint `--test --format=json -v` (and text fallback) → Finding[].
 *
 * Prefer JSON from the PHP-CS-Fixer reporter: a top-level `files` array of
 * objects with `name` (or `path`), optional `appliedFixers` (or `fixers`), and
 * optional `diff`. Verbose (`-v`) may wrap that JSON in other text, so we extract
 * the first object blob. Optional `diff` is appended (truncated) when the
 * installed Pint provides it. Never suggest running pint or php commands.
 *
 * Text fallback scans FAIL / cross-mark lines that name a `.php` path, with an
 * optional fixer list after the path.
 *
 * @module plugins/diagnostics/adapters/pint
 */
import type { Finding } from "../lib/types.ts"

/**
 * Generic message for every pint format hit with no fixer ids. Exactly one
 * shape, no command suggestions anywhere.
 */
export const PINT_GENERIC_MESSAGE =
  "File does not match the project's formatting rules (reported by pint)."

/** Max diff lines embedded in one finding message before truncation. */
const MAX_DIFF_LINES = 20

/** FAIL / cross-mark line with a php path and optional fixer list. */
const FAIL_LINE_RE = /(?:FAIL|⨯|✗|✖|×)\s+(\S+\.php\b)(?:\s+([a-zA-Z0-9_,\s-]+))?/

interface PintFileRecord {
  name?: unknown
  path?: unknown
  appliedFixers?: unknown
  fixers?: unknown
  diff?: unknown
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((x): x is string => typeof x === "string" && x.length > 0)
}

function messageFor(fixers: string[]): string {
  if (fixers.length === 0) return PINT_GENERIC_MESSAGE
  return `${PINT_GENERIC_MESSAGE.slice(0, -1)}: ${fixers.join(", ")}.`
}

function appendDiff(message: string, diff: string): string {
  const lines = diff.split("\n")
  let body = lines
  let truncated = false
  if (body.length > MAX_DIFF_LINES) {
    body = body.slice(0, MAX_DIFF_LINES)
    truncated = true
  }
  return (
    `${message}\nExpected content diff (- current / + expected):\n` +
    `${body.join("\n")}${truncated ? "\n…(truncated)" : ""}`
  )
}

function findingFor(path: string, fixers: string[], diff?: string): Finding {
  let message = messageFor(fixers)
  if (diff && diff.trim()) message = appendDiff(message, diff.trim())
  return {
    source: "pint",
    severity: "warning",
    code: "format",
    path,
    message,
  }
}

/** Pull the first JSON object from mixed reporter / progress output. */
function extractJsonObject(output: string): object | undefined {
  const start = output.indexOf("{")
  const end = output.lastIndexOf("}")
  if (start < 0 || end <= start) return undefined
  try {
    const parsed: unknown = JSON.parse(output.slice(start, end + 1))
    if (parsed !== null && typeof parsed === "object") return parsed
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Parse a JSON object that looks like pint / PHP-CS-Fixer `--format=json`.
 * Returns null when the shape is not recognized so the caller can try text.
 */
function adaptPintJson(parsed: unknown): Finding[] | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const files = (parsed as { files?: unknown }).files
  if (!Array.isArray(files)) return null

  const findings: Finding[] = []
  for (const rec of files as PintFileRecord[]) {
    if (!rec || typeof rec !== "object") continue
    const path =
      typeof rec.name === "string" ? rec.name : typeof rec.path === "string" ? rec.path : undefined
    if (!path) continue
    const fixers =
      asStringList(rec.appliedFixers).length > 0
        ? asStringList(rec.appliedFixers)
        : asStringList(rec.fixers)
    const diff = typeof rec.diff === "string" ? rec.diff : undefined
    findings.push(findingFor(path, fixers, diff))
  }
  return findings
}

/** Text fallback when JSON is absent or unusable. */
function adaptPintText(output: string): Finding[] {
  const findings: Finding[] = []
  const seen = new Set<string>()
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const m = FAIL_LINE_RE.exec(line)
    if (!m) continue
    const path = m[1]?.trim()
    if (!path || seen.has(path)) continue
    seen.add(path)
    const fixerPart = m[2]?.trim() ?? ""
    const fixers = fixerPart
      ? fixerPart
          .split(/[,\s]+/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0 && /^[a-zA-Z0-9_-]+$/.test(s))
      : []
    findings.push(findingFor(path, fixers))
  }
  return findings
}

/**
 * Parse pint check-only JSON (or text) output into {@link Finding}[].
 * Malformed or empty input yields []. Exit 1 with valid JSON is a diagnostic
 * hit, not a parse failure.
 */
export function adaptPint(output: string): Finding[] {
  const trimmed = output.trim()
  if (!trimmed) return []

  const parsed = extractJsonObject(trimmed)
  if (parsed !== undefined) {
    const fromJson = adaptPintJson(parsed)
    if (fromJson !== null) return fromJson
  }

  return adaptPintText(output)
}
