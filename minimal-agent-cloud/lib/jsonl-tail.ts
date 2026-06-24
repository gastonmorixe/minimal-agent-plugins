/**
 * Read NEW complete records from a session's local JSONL, after a cursor.
 *
 * The session transcript (`~/.minimal-agent/sessions/<sid>.jsonl`) is the SOURCE
 * OF TRUTH: the CLI appends one JSON record per line as a turn streams. The
 * uploader ships records the cloud hasn't seen, identified by their 0-based line
 * index (`clientLine`), matching the backend's `(sid, clientLine)` dedupe key.
 *
 * Two rules borrowed from the host's own JSONL handling:
 *   - Skip a TORN final line: a record being written right now may be a partial
 *     line with no trailing newline / invalid JSON. We never ship it; it'll be
 *     complete on the next flush. We detect this by only treating lines as
 *     complete records when they parse as JSON; a trailing non-parsing fragment
 *     is held back.
 *   - Blank lines don't count as records but DO advance nothing — we index by
 *     parsed-record position to stay aligned with how the backend counts.
 *
 * Pure given the file text (injected by the caller), so it's testable without
 * disk.
 *
 * @module lib/jsonl-tail
 */

/** One record read from the JSONL, with its 0-based line index. */
export interface TailRecord {
  /** 0-based index of this record's line in the file. */
  readonly clientLine: number
  /** The parsed record object (shipped as-is to ingestRecords). */
  readonly record: unknown
}

/** Result of reading new records after a cursor. */
export interface TailResult {
  /** New complete records whose clientLine is past afterClientLine. */
  readonly records: readonly TailRecord[]
  /** The clientLine of the last COMPLETE record in the file (-1 when none). */
  readonly lastCompleteLine: number
  /** True when the final line looked torn (held back). Diagnostic only. */
  readonly heldTornLine: boolean
}

/**
 * Parse the JSONL text into indexed records, returning only those AFTER
 * `afterClientLine` (exclusive). `clientLine` is the position counting EVERY
 * line (so it matches the file's literal line numbering, which is what the
 * backend's `fromClientLine` expects: line N of the JSONL).
 *
 * A final line with no trailing newline that fails to parse is treated as torn
 * and held back (not shipped, not counted as complete).
 */
export function readNewRecords(text: string, afterClientLine: number): TailResult {
  if (text.length === 0) {
    return { records: [], lastCompleteLine: -1, heldTornLine: false }
  }
  // Split on newlines. A trailing newline yields a final empty element we drop.
  const hasTrailingNewline = text.endsWith("\n")
  const rawLines = text.split("\n")
  if (hasTrailingNewline) rawLines.pop() // drop the empty tail from the final \n

  const records: TailRecord[] = []
  let lastCompleteLine = -1
  let heldTornLine = false

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i] ?? ""
    const isLast = i === rawLines.length - 1
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      // Blank line: not a record. It still occupies a line index, so a record
      // after it keeps its true file-line number.
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      // Unparseable. If it's the LAST line AND the file has no trailing newline,
      // it's a torn in-progress write — hold it back. Otherwise it's genuinely
      // corrupt mid-file; skip it (don't ship junk) but it still consumed a line.
      if (isLast && !hasTrailingNewline) heldTornLine = true
      continue
    }
    lastCompleteLine = i
    if (i > afterClientLine) records.push({ clientLine: i, record: parsed })
  }

  return { records, lastCompleteLine, heldTornLine }
}
