/**
 * Prettier `--check` text output → {@link Finding}[] adapter.
 *
 * `prettier --check <file>` prints one `[warn] <path>` line per unformatted
 * file (plus a trailing summary line we must NOT turn into a finding), and
 * exits non-zero when anything differs from the project's formatting. The exit
 * code is unreliable across versions, so the provider treats output + exit
 * together; this adapter only judges the text.
 *
 * The finding is intentionally GENERIC: formatters are heavily project-
 * configured, so we never suggest a command ("run prettier --write" is wrong
 * more often than right). The concrete expected-content diff is embedded later
 * by {@link ../providers/prettier-provider.ts | PrettierProvider}.
 *
 * @module plugins/diagnostics/adapters/prettier
 */
import type { Finding } from "../lib/types.ts"

/**
 * Generic message for every prettier `--check` hit. Exactly one shape, no
 * command suggestions anywhere.
 */
export const PRETTIER_GENERIC_MESSAGE =
  "File does not match the project's formatting rules (reported by prettier)."

/** One `[warn] <path>` line from `prettier --check`. */
const WARN_LINE_RE = /^\[warn\]\s+(.+)$/

/**
 * Parse `prettier --check` stdout into findings. Malformed or empty input
 * yields []. Summary / non-path lines are skipped.
 */
export function adaptPrettier(stdout: string): Finding[] {
  const findings: Finding[] = []
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim()
    const m = WARN_LINE_RE.exec(line)
    if (!m) continue
    const path = m[1]?.trim()
    // The summary line ("Code style issues found in the above file(s)...")
    // also carries a [warn] prefix; it names no file, so skip it.
    if (!path || !isPathEntry(path)) continue
    findings.push({
      source: "prettier",
      severity: "warning",
      code: "format",
      message: PRETTIER_GENERIC_MESSAGE,
      path,
    })
  }
  return findings
}

/** True when the [warn] payload looks like a file path, false for summaries. */
function isPathEntry(path: string): boolean {
  return !/^Code style issues\b/.test(path)
}
