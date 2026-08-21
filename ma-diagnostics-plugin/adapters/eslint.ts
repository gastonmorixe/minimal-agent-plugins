/**
 * Adapter: `eslint` JSON output to findings.
 *
 * ESLint's JSON reporter emits a per-file record array. Each record holds
 * `filePath` and a `messages` array with `ruleId`, `severity`, `line`,
 * `column`, and `message`. This module is a pure function: string in,
 * findings out. Malformed or empty JSON (including fatal/config-error runs)
 * yields an empty array. Messages whose `ruleId` is null are parse/syntax
 * errors and get the `syntax` code. The caller handles process exit codes;
 * this only parses stdout.
 *
 * @module plugins/diagnostics/adapters/eslint
 */
import type { Finding, FindingSeverity } from "../lib/types.ts"

interface EslintMessage {
  ruleId?: string | null
  /** 1 = warning, 2 = error. */
  severity?: number
  line?: number
  column?: number
  message?: unknown
}

interface EslintFileRecord {
  filePath?: string
  messages?: EslintMessage[]
}

function severityOf(n: number | undefined): FindingSeverity {
  return n === 2 ? "error" : "warning"
}

/**
 * Parse ESLint `--format json` output into {@link Finding}[]. All files'
 * messages are flattened into one array. Tolerates garbage input by
 * returning [].
 */
export function adaptEslint(stdout: string): Finding[] {
  let records: unknown
  try {
    records = JSON.parse(stdout)
  } catch {
    return []
  }
  if (!Array.isArray(records)) return []

  const findings: Finding[] = []
  for (const rec of records as EslintFileRecord[]) {
    if (!rec || typeof rec !== "object" || !Array.isArray(rec.messages)) continue
    for (const m of rec.messages) {
      if (!m || typeof m !== "object") continue
      findings.push({
        source: "eslint",
        severity: severityOf(m.severity),
        line: m.line,
        col: m.column,
        // Parse errors carry ruleId === null; label them "syntax".
        code: m.ruleId ?? "syntax",
        message:
          typeof m.message === "string" ? m.message : m.message == null ? "" : String(m.message),
        path: rec.filePath,
      })
    }
  }
  return findings
}
