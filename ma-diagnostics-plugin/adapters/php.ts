/**
 * Adapter: `php -l` stdout+stderr → {@link Finding}[].
 *
 * `php -l <file>` prints either a clean line:
 *   No syntax errors detected in /path/file.php
 * or a parse error plus a summary:
 *   Parse error: syntax error, unexpected token ";" in /path/file.php on line 12
 *   Errors parsing /path/file.php
 * Older builds prefix with `PHP Parse error:`.
 *
 * Pure function: string in, findings out. Clean output and garbage yield [].
 * Messages are the useful error text. Never suggest a php command.
 *
 * @module plugins/diagnostics/adapters/php
 */
import type { Finding } from "../lib/types.ts"

/** Parse error with path + line (optional `PHP ` prefix). */
const PARSE_ERROR_RE = /^(?:PHP\s+)?Parse error:\s*(.+?)\s+in\s+(.+?)\s+on\s+line\s+(\d+)\s*$/i

/** Summary line emitted after a failed `php -l` run. */
const ERRORS_PARSING_RE = /^Errors parsing\s+(.+?)\s*$/i

/** Clean success line. Skipped (yields no finding). */
const CLEAN_RE = /^No syntax errors detected in\b/i

/**
 * Parse `php -l` combined stdout+stderr into {@link Finding}[]. Malformed or
 * empty input and clean runs yield [].
 */
export function adaptPhp(output: string): Finding[] {
  const findings: Finding[] = []
  const seenPaths = new Set<string>()

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || CLEAN_RE.test(line)) continue

    const parseMatch = PARSE_ERROR_RE.exec(line)
    if (parseMatch) {
      const message = line
      const path = parseMatch[2]?.trim()
      const lineNum = Number(parseMatch[3])
      if (path) seenPaths.add(path)
      findings.push({
        source: "php",
        severity: "error",
        code: "syntax",
        message,
        ...(path ? { path } : {}),
        ...(Number.isFinite(lineNum) ? { line: lineNum } : {}),
      })
      continue
    }

    const errorsMatch = ERRORS_PARSING_RE.exec(line)
    if (errorsMatch) {
      const path = errorsMatch[1]?.trim()
      // Prefer the detailed Parse error finding when both lines appear.
      if (path && seenPaths.has(path)) continue
      if (path) seenPaths.add(path)
      findings.push({
        source: "php",
        severity: "error",
        code: "syntax",
        message: line,
        ...(path ? { path } : {}),
      })
    }
  }

  return findings
}
