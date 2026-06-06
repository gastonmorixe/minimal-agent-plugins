/**
 * Bounded, model-facing reads of a job's raw log file.
 *
 * The on-disk log is the full verbatim output (ANSI preserved). What crosses
 * into the model's context must be bounded, so this module supports tail / line
 * range / grep / a byte `since` cursor, strips ANSI by default, and caps the
 * returned bytes. The pure transform ({@link selectLog}) is separated from the
 * IO ({@link readLog}) so it is exhaustively testable without a filesystem.
 *
 * @module lib/log-read
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

/** Strip ANSI escape sequences. Pure. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "")
}

/** Options for selecting a slice of a log. */
export interface SelectOptions {
  /** Last N lines (after grep). */
  readonly tail?: number
  /** Zero-based first line of a range (after grep). */
  readonly offset?: number
  /** Max lines of a range (after grep). */
  readonly limit?: number
  /** Only lines matching this regex source. */
  readonly grep?: string
  /** Keep ANSI escapes (default false = strip). */
  readonly raw?: boolean
  /** Hard byte cap on the returned text. */
  readonly maxBytes: number
}

/** Result of a {@link selectLog}. */
export interface SelectResult {
  /** The selected text (already ANSI-handled + byte-capped). */
  readonly text: string
  /** Total lines in the source (before selection). */
  readonly totalLines: number
  /** Lines actually returned. */
  readonly shownLines: number
  /** True when the byte cap clipped the output. */
  readonly clippedByBytes: boolean
  /** True when a grep filtered the lines. */
  readonly filtered: boolean
}

/** Count bytes of a UTF-8 string. */
function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8")
}

/**
 * Select a bounded slice of log text. Order of operations:
 *   1. split into lines,
 *   2. optional grep filter,
 *   3. tail OR offset/limit range,
 *   4. ANSI strip unless `raw`,
 *   5. byte cap (keep the TAIL within the cap: recent output matters most).
 *
 * Pure: string in, structured result out.
 */
export function selectLog(content: string, opts: SelectOptions): SelectResult {
  const allLines = content.length === 0 ? [] : content.split("\n")
  // A trailing newline yields a final empty element, drop it so counts are sane.
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") allLines.pop()
  const totalLines = allLines.length

  let lines = allLines
  let filtered = false
  if (opts.grep !== undefined) {
    const re = new RegExp(opts.grep)
    lines = lines.filter((l) => re.test(l))
    filtered = true
  }

  if (opts.tail !== undefined) {
    lines = lines.slice(Math.max(0, lines.length - opts.tail))
  } else if (opts.offset !== undefined || opts.limit !== undefined) {
    const start = opts.offset ?? 0
    const end = opts.limit !== undefined ? start + opts.limit : undefined
    lines = lines.slice(start, end)
  }

  let text = lines.join("\n")
  if (!opts.raw) text = stripAnsi(text)

  let clippedByBytes = false
  if (byteLen(text) > opts.maxBytes) {
    clippedByBytes = true
    // Keep the tail: decode-safe clip by slicing on a Buffer then re-decoding.
    const buf = Buffer.from(text, "utf8")
    const tail = buf.subarray(buf.length - opts.maxBytes)
    // The slice may start mid-codepoint, TextDecoder with fatal:false replaces
    // the partial leading byte(s) with U+FFFD, which is fine for a log tail.
    text = new TextDecoder("utf-8").decode(tail)
  }

  return {
    text,
    totalLines,
    shownLines: lines.length,
    clippedByBytes,
    filtered,
  }
}

// ---------------------------------------------------------------------------
// IO shell
// ---------------------------------------------------------------------------

/** Injectable IO for {@link readLog}. */
export interface LogIO {
  /** Read the whole file as UTF-8, or `undefined` when absent/unreadable. */
  readonly readFile: (path: string) => string | undefined
  /** Byte size of the file, or `undefined` when absent. */
  readonly size: (path: string) => number | undefined
}

/** A `since`-aware read result, adding the new byte cursor. */
export interface ReadResult extends SelectResult {
  /** Whether the log file existed. */
  readonly exists: boolean
  /** Current byte size of the log (the next `since` cursor). */
  readonly byteCursor: number
}

/**
 * Read + select from a log file via injected IO. When `since` is set, only the
 * bytes after that cursor are considered (incremental streaming reads), and the
 * returned `byteCursor` is the new end for the next call.
 */
export function readLog(
  path: string,
  opts: SelectOptions & { since?: number },
  io: LogIO,
): ReadResult {
  const size = io.size(path)
  if (size === undefined) {
    return {
      text: "",
      totalLines: 0,
      shownLines: 0,
      clippedByBytes: false,
      filtered: false,
      exists: false,
      byteCursor: 0,
    }
  }
  const full = io.readFile(path) ?? ""
  let content = full
  if (opts.since !== undefined && opts.since > 0) {
    const buf = Buffer.from(full, "utf8")
    content =
      opts.since >= buf.length ? "" : new TextDecoder("utf-8").decode(buf.subarray(opts.since))
  }
  const sel = selectLog(content, opts)
  return { ...sel, exists: true, byteCursor: size }
}
