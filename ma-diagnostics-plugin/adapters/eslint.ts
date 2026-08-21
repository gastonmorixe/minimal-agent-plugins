/**
 * Adapter: `eslint <file> --format json` stdout -> {@link Finding}[].
 *
 * ESLint's JSON reporter emits a per-file record array:
 *
 *   [{ filePath, messages: [{ ruleId, severity (1=warn, 2=error),
 *      line, column, message }], errorCount, warningCount, ... }]
 *
 * Pure function: string in, Finding[] out. Malformed or empty JSON (which
 * includes a fatal/config-error run, exit code 2) yields []. Messages whose
 * `ruleId` is null are parse/syntax errors and get the "syntax" code. The
 * caller handles process exit codes: this only ever parses stdout.
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
  message?: string
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
        message: typeof m.message === "string" ? m.message : String(m.message ?? ""),
        path: rec.filePath,
      })
    }
  }
  return findings
}
