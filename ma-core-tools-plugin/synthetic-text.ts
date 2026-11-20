/**
 * Synthetic text provider for the built-in tool results (`tool_text.*`),
 * the tool output notices (`tool_output.preview`, `tool_output.truncated`,
 * `tool_output.streak`) and the mode texts (`mode.*`). Each text is built
 * from its facts only. The texts are the STE rewrite (P4) of the old core
 * texts (tests/text-parity/fixtures/synthetic.json). parity.test.ts maps each
 * old text to the new one.
 *
 * A missing fact or a kind this plugin does not own throws. The core
 * resolver catches it, uses its own text and records a diagnostic.
 *
 * @module ma-core-tools-plugin/synthetic-text
 */

import type {
  SyntheticFacts,
  SyntheticKind,
  SyntheticTextProvider,
} from "@minimal-agent/core/plugin-api/types/synthetic-text"

/** Every kind this plugin owns. */
export const KINDS: readonly SyntheticKind[] = [
  "tool_output.preview",
  "tool_output.truncated",
  "tool_output.streak",
  "tool_text.Bash.cd_no_dir",
  "tool_text.Bash.output_cap",
  "tool_text.Bash.timed_out",
  "tool_text.Bash.exit_code",
  "tool_text.Bash.error",
  "tool_text.Read.whitespace_resolved",
  "tool_text.Read.too_large",
  "tool_text.Read.error",
  "tool_text.Read.binary_rejected",
  "tool_text.Read.unsupported_embedding",
  "tool_text.Read.unsupported_image_modality",
  "tool_text.Read.image_too_large",
  "tool_text.Read.image_summary",
  "tool_text.Write.written",
  "tool_text.Write.error",
  "tool_text.Write.missing_path",
  "tool_text.Write.missing_content",
  "tool_text.Write.arg_not_string",
  "tool_text.Edit.not_found",
  "tool_text.Edit.multiple",
  "tool_text.Edit.edited",
  "tool_text.Edit.error",
  "tool_text.Glob.no_files",
  "tool_text.Glob.missing_pattern",
  "tool_text.Glob.arg_not_string",
  "tool_text.Glob.error",
  "tool_text.Glob.timeout",
  "tool_text.Glob.skipped_dirs",
  "tool_text.Grep.error",
  "tool_text.Grep.no_matches",
  "mode.refusal",
  "mode.active_stamp",
  "mode.change",
  "tool_output.binary_withheld",
  "tool_text.Bash.aborted",
  "tool_text.Write.not_read",
  "tool_text.Write.stale",
  "tool_text.Edit.not_read",
  "tool_text.Edit.stale",
  "tool_text.Grep.timed_out",
  "tool_text.Grep.exit_code",
  "tool_text.FilesStats.empty",
  "tool_text.FilesStats.not_enabled",
  "mode.cli_refusal",
]

/**
 * Human byte size. Exact copy of core `media/types.ts` formatBytes (N1).
 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)}GB`
}

/** A required fact as text. Throws when it is absent. */
function str(kind: string, facts: SyntheticFacts, key: string): string {
  const v = facts[key]
  if (v === undefined) throw new Error(`${kind}: missing fact ${key}`)
  return String(v)
}

/** A required number fact. Throws when it is absent or not a number. */
function num(kind: string, facts: SyntheticFacts, key: string): number {
  const v = facts[key]
  if (typeof v !== "number") throw new Error(`${kind}: fact ${key} must be a number`)
  return v
}

/**
 * An OPTIONAL boolean fact. `undefined` when the fact is absent or not a
 * boolean (an old core does not send the M3c facts). Never throws.
 */
function optBool(facts: SyntheticFacts, key: string): boolean | undefined {
  const v = facts[key]
  return typeof v === "boolean" ? v : undefined
}

/** An OPTIONAL number fact. `undefined` when absent or not a number. Never throws. */
function optNum(facts: SyntheticFacts, key: string): number | undefined {
  const v = facts[key]
  return typeof v === "number" ? v : undefined
}

// --- tool_output.preview (core src/prompts/runtime/output-preview*.md) ---

const PREVIEW_HINT =
  "the user saw only a part of this output. If this output is for the user, give a summary of the important parts in your text reply. The user reads the full text reply."
const PREVIEW_HINT_BASH =
  "the user saw only a part of this output. If you used Bash to show visual content to the user (ASCII art, ANSI TUI preview, formatted tables), put that content in your text reply. The user reads the full text reply."

function previewRecover(rawPath: string): string {
  return `The harness saved the full output at ${rawPath}. If this preview is not sufficient, Read that path. For build or test errors, Read the tail of that path.`
}

function preview(facts: SyntheticFacts): string {
  const k = "tool_output.preview"
  const rawPath = typeof facts.rawPath === "string" ? facts.rawPath : ""
  const recover = rawPath ? ` ${previewRecover(rawPath)}` : ""
  const hint = `${facts.bash === true ? PREVIEW_HINT_BASH : PREVIEW_HINT}${recover}`
  const pathAttr = rawPath ? ` path="${rawPath}"` : ""
  return `<ma::agent::output-preview shown="${str(k, facts, "shown")}" total="${str(k, facts, "total")}" tool="${str(k, facts, "tool")}"${pathAttr}>${hint}</ma::agent::output-preview>`
}

// --- tool_output.truncated (core truncatedOutputNotice + truncationHint) ---

function truncationHint(tool: string, cutLine: number, maxToolOutputBytes: number): string {
  switch (tool) {
    case "Read":
      return `to continue, call Read with offset=${cutLine}. Set limit if necessary.`
    case "Grep":
      return "make the search narrower with a more specific pattern, a glob or a smaller -A/-B/-C. Or set a higher head_limit explicitly."
    case "Bash":
      return `output exceeded ${maxToolOutputBytes} bytes. The harness kept the start of the output, so errors or build failures at the end can be missing. Run the command again and send only the tail to the output (for example, \`... 2>&1 | tail -n 100\`). Or filter the output (\`grep -nE 'error:|FAIL'\`). Or Read the tail of the raw-output blob. The path of that blob is below, and the blob holds the full output.`
    case "Glob":
      return "make the pattern narrower or search a subdirectory."
    case "Fetch":
      return "the harness saved the full body at the `<ma::agent::raw-output ... />` path below. Read that path. Or call Fetch again with a CSS `selector` to get only a specific element."
    case "WebSearch":
      return "set a lower `count` or make the query narrower. Or use the `url` of a result to Fetch a specific page."
    default:
      return "run the tool again with narrower parameters. The harness saved the full body at the `<ma::agent::raw-output ... />` path below."
  }
}

/** The Read notice when the harness does not know the total lines (no offset hint, no line count). */
function readUnknownTotalNotice(shownBytes: string, totalBytes: string): string {
  return `[truncated: shown ${shownBytes} of ${totalBytes} bytes. The harness cut the output; the total number of lines is not known. Use Grep with a specific pattern, or Bash with sed -n/cut -c, to see the part that you need.]`
}

/**
 * The Read notice when only the per-line clamp cut text: every line is shown,
 * and no byte cut is inside a line.
 */
function readLongLinesNotice(
  shownBytes: string,
  totalBytes: string,
  shownLines: string,
  longLines: number,
  lineCharCap: number,
): string {
  const cut = longLines === 1 ? "1 long line" : `${longLines} long lines`
  return `[truncated: shown ${shownBytes} of ${totalBytes} bytes. All ${shownLines} lines are shown, but the harness cut ${cut} at about ${lineCharCap} characters (see "...(+Nch)"). Read cannot show the rest of a line. Use Grep with a specific pattern, or Bash with cut -c on that line.]`
}

function truncated(facts: SyntheticFacts): string {
  const k = "tool_output.truncated"
  const shownBytes = str(k, facts, "shownBytes")
  const cutLine = num(k, facts, "cutLine")
  const tool = str(k, facts, "tool")
  const totalBytes = str(k, facts, "totalBytes")
  const shownLines = str(k, facts, "shownLines")
  // The M3c facts are optional: an old core does not send them, and then the
  // text below is the old text byte for byte. Read only (other tools keep their text).
  if (tool === "Read") {
    // 1. Unknown total: no offset hint, no made-up line count.
    if (optBool(facts, "totalLinesKnown") === false) {
      return readUnknownTotalNotice(shownBytes, totalBytes)
    }
    // 2. Only the per-line clamp cut text: all lines are shown.
    const longLines = optNum(facts, "longLines")
    const lineCharCap = optNum(facts, "lineCharCap")
    const nextOffset = optNum(facts, "nextOffset")
    const totalLines = optNum(facts, "totalLines")
    if (
      optBool(facts, "cutMidLine") === true &&
      optBool(facts, "lastLinePartial") === false &&
      longLines !== undefined &&
      longLines > 0 &&
      lineCharCap !== undefined &&
      nextOffset !== undefined &&
      totalLines !== undefined &&
      nextOffset >= totalLines
    ) {
      return readLongLinesNotice(shownBytes, totalBytes, shownLines, longLines, lineCharCap)
    }
    // 3. The byte cut is inside a line: continue at the start of that line.
    if (optBool(facts, "lastLinePartial") === true && nextOffset !== undefined) {
      const hint = `line ${cutLine} is partial. To continue, call Read with offset=${nextOffset}, which shows that line again from its start. Set limit if necessary.`
      return `[truncated: shown ${shownBytes} of ${totalBytes} bytes, ${shownLines}/${str(k, facts, "totalLines")} lines, cut at byte ${shownBytes}, line ${cutLine}. ${hint}]`
    }
  }
  const hint = truncationHint(tool, cutLine, num(k, facts, "maxToolOutputBytes"))
  return `[truncated: shown ${shownBytes} of ${totalBytes} bytes, ${shownLines}/${str(k, facts, "totalLines")} lines, cut at byte ${shownBytes}, line ${cutLine}. ${hint}]`
}

// --- tool_output.streak (core streakNote) ---

function streakBody(tool: string, threshold: number): string {
  switch (tool) {
    case "Read":
      return `the harness truncated the output of ${threshold} Read calls in a row. Use the totals in the last [truncated: ...] notice to calculate one offset+limit for the part that you need. Do not read page by page from byte 0.`
    case "Grep":
      return `the harness truncated the output of ${threshold} Grep calls in a row. Do one or more of these: use \`output_mode: "files_with_matches"\` (densest), make the pattern more specific, add a \`glob\`/\`path\` filter, set \`head_limit\` explicitly. Do not let the output limit cut the output.`
    case "Bash":
      return `the harness truncated the output of ${threshold} Bash calls in a row. Limit the output in the command itself: \`head -c\`, \`head -n\`, \`tail\`, \`sed -n '1,Np'\`, or a pipe to a filter. The output limit after the run loses data. A limit in the command gives useful output.`
    case "Glob":
      return `the harness truncated the output of ${threshold} Glob calls in a row. Make the pattern narrower, so that it does not match all files. For example, add a subdirectory prefix or specify the file extension.`
    default:
      return `the harness truncated the output of ${threshold} calls of this tool in a row. Change the parameters. The [truncated: ...] notice of each earlier call tells you how to continue.`
  }
}

function streak(facts: SyntheticFacts): string {
  const k = "tool_output.streak"
  return `[note: ${streakBody(str(k, facts, "tool"), num(k, facts, "threshold"))}]`
}

// --- tool_text.Glob notices (core globTimeoutNotice, globSkippedDirsNotice) ---

function globTimeout(facts: SyntheticFacts): string {
  const k = "tool_text.Glob.timeout"
  const skippedDirs = num(k, facts, "skippedDirs")
  const skipped =
    skippedDirs > 0
      ? ` Glob skipped ${skippedDirs} unreadable director${skippedDirs === 1 ? "y" : "ies"}.`
      : ""
  return `[glob stopped after ${str(k, facts, "ms")}ms: partial results. The directory tree was too large to search in full.${skipped} Make the pattern narrower or search a subdirectory.]`
}

function globSkippedDirs(facts: SyntheticFacts): string {
  const count = num("tool_text.Glob.skipped_dirs", facts, "count")
  const noun = count === 1 ? "directory" : "directories"
  return `[glob skipped ${count} unreadable ${noun}: partial results.]`
}

// --- tool_text.Read media texts (core media/PROMPTS.ts, read-file part) ---

function imageSummary(facts: SyntheticFacts): string {
  const k = "tool_text.Read.image_summary"
  const dims =
    facts.width !== undefined ? `${str(k, facts, "width")}x${str(k, facts, "height")} ` : ""
  const base = `[${str(k, facts, "subtype")} image ${dims}${formatBytes(num(k, facts, "sizeBytes"))} shown to the model below]`
  const fitted = facts.fittedStrategy
  if (fitted) return `${base.slice(0, -1)}, resized to fit (${String(fitted)})]`
  return base
}

// --- mode.* (core modes/PROMPTS.ts) ---

function modeRefusal(facts: SyntheticFacts): string {
  const k = "mode.refusal"
  const hint = facts.hint
  const tail = hint ? ` ${String(hint)}` : ""
  return `Tool "${str(k, facts, "tool")}" is not permitted in ${str(k, facts, "label")} mode.${tail}`
}

// --- P3.7 kinds (old core inline text: tools.ts, files-stats.ts,
// binary-guard.ts, modes.ts at 56fc856) ---

/** `tool_text.<Tool>.not_read`. */
function notRead(tool: "Edit" | "Write") {
  return (f: SyntheticFacts): string =>
    `${tool} error: you did not read ${str(`tool_text.${tool}.not_read`, f, "path")} in this session. Read the file first. Then call ${tool} again.`
}

/** `tool_text.<Tool>.stale`. */
function stale(tool: "Edit" | "Write") {
  return (f: SyntheticFacts): string => {
    const k = `tool_text.${tool}.stale`
    const status = str(k, f, "status")
    let reason: string
    if (status === "missing") reason = "the file does not exist now (it existed at the last read)"
    else if (status === "changed") reason = "the file changed after the last read"
    else throw new Error(`${k}: unknown status ${status}`)
    return `${tool} error: ${reason}: ${str(k, f, "path")}. Read the file again. Then call ${tool} again.`
  }
}

function grepTimedOut(f: SyntheticFacts): string {
  const k = "tool_text.Grep.timed_out"
  const engine = str(k, f, "engine")
  const what = engine === "rg" ? "rg" : engine === "js" ? "search" : undefined
  if (what === undefined) throw new Error(`${k}: unknown engine ${engine}`)
  return `Grep error: ${what} timed out after ${str(k, f, "ms")}ms`
}

function filesStatsEmpty(f: SyntheticFacts): string {
  if (f.filtered === true) return "No tracked files matched the filter."
  return [
    "This session has no read or changed files yet.",
    "Each successful Read, Edit or Write call records the size and modified time of the file.",
    "FilesStats reports the live status of each tracked file:",
    "  present: not changed after the last read",
    "  changed: changed after the last read (by you or by a different process)",
    "  missing: deleted after the last read",
  ].join("\n")
}

function binaryWithheld(f: SyntheticFacts): string {
  if (f.optedIn === true) {
    return "The binary body is too large to include as base64 in the tool output budget. Use the path above. Read that path, or ask the user to attach the file to their message."
  }
  const saved = f.hasPath === true ? " The harness saved the full bytes at the path above." : ""
  return `The harness did not put the binary body in the model context. The body is not valid text, and it uses tokens for no purpose.${saved} Do one of these: call the tool again with binary=true to get base64 if the body is small enough, Read the saved path, or ask the user to attach the file.`
}

function modeCliRefusal(f: SyntheticFacts): string {
  const k = "mode.cli_refusal"
  const tool = str(k, f, "tool")
  const reason = str(k, f, "reason")
  if (reason === "deny-all") return `Tool "${tool}" is not permitted because --no-tools is active.`
  if (reason === "allow-list") return `Tool "${tool}" is not in the --tools allow-list.`
  throw new Error(`${k}: unknown reason ${reason}`)
}

/** One text builder per kind. */
const TEXT: Readonly<Record<string, (facts: SyntheticFacts) => string>> = {
  "tool_output.preview": preview,
  "tool_output.truncated": truncated,
  "tool_output.streak": streak,
  "tool_text.Bash.cd_no_dir": (f) =>
    `cd: no such directory: ${str("tool_text.Bash.cd_no_dir", f, "path")}`,
  "tool_text.Bash.output_cap": (f) =>
    `[output exceeded ${str("tool_text.Bash.output_cap", f, "maxBytes")} bytes: the harness stopped the command and truncated the output]`,
  // `clamped` is true when core decreased the input to its maximum.
  "tool_text.Bash.timed_out": (f) =>
    `[timed out after ${str("tool_text.Bash.timed_out", f, "timeoutMs")}ms${optBool(f, "clamped") ? " (clamped to the max)" : ""}]`,
  // A null exit code has no `exitCode` fact. The old text printed "null".
  "tool_text.Bash.exit_code": (f) =>
    `Exit code ${f.exitCode === undefined ? "null" : String(f.exitCode)}`,
  "tool_text.Bash.error": (f) => `Bash error: ${str("tool_text.Bash.error", f, "detail")}`,
  "tool_text.Read.whitespace_resolved": (f) =>
    `Note: resolved to "${str("tool_text.Read.whitespace_resolved", f, "path")}" (the whitespace did not match).\n`,
  "tool_text.Read.too_large": (f) =>
    `File is ${str("tool_text.Read.too_large", f, "sizeMb")} MB. The read limit is ${str("tool_text.Read.too_large", f, "limitMb")} MB. Use offset/limit to read a part of the file, or use Grep to search the file.`,
  "tool_text.Read.error": (f) => `Read error: ${str("tool_text.Read.error", f, "detail")}`,
  "tool_text.Read.binary_rejected": (f) => {
    const k = "tool_text.Read.binary_rejected"
    return `${str(k, f, "mimeType")} (${formatBytes(num(k, f, "sizeBytes"))}) is a binary document. Tool output can contain text and images, but not documents. Thus the harness cannot put this document in the tool output. Ask the user to attach the document to their message. Or convert the document to text or images first.`
  },
  "tool_text.Read.unsupported_embedding": (f) => {
    const k = "tool_text.Read.unsupported_embedding"
    return `${str(k, f, "mimeType")} (${formatBytes(num(k, f, "sizeBytes"))}): tool output cannot contain this file. Ask the user to attach the file to their message instead.`
  },
  "tool_text.Read.unsupported_image_modality": (f) => {
    const k = "tool_text.Read.unsupported_image_modality"
    return `${str(k, f, "modelId")} does not accept image input. Thus the harness cannot show this ${str(k, f, "mimeType")} (${formatBytes(num(k, f, "sizeBytes"))}) to the model. Describe the image for the user from the context. Or change to a model with vision support.`
  },
  "tool_text.Read.image_too_large": (f) => {
    const k = "tool_text.Read.image_too_large"
    return `${formatBytes(num(k, f, "sizeBytes"))} image is too large to embed, also after resizing (limit per item: ${formatBytes(num(k, f, "limitBytes"))} encoded for ${str(k, f, "modelId")}).`
  },
  "tool_text.Read.image_summary": imageSummary,
  "tool_text.Write.written": (f) => `File written: ${str("tool_text.Write.written", f, "path")}`,
  "tool_text.Write.error": (f) => `Write error: ${str("tool_text.Write.error", f, "detail")}`,
  "tool_text.Write.missing_path": () => "Write requires `file_path`.",
  "tool_text.Write.missing_content": () => "Write requires `content` (or alias `contents`).",
  "tool_text.Write.arg_not_string": (f) => {
    const k = "tool_text.Write.arg_not_string"
    return `Write \`${str(k, f, "key")}\` must be a string. Received type: ${str(k, f, "got")}.`
  },
  "tool_text.Edit.not_found": (f) =>
    `Edit error: old_string does not occur in ${str("tool_text.Edit.not_found", f, "path")}`,
  "tool_text.Edit.multiple": (f) => {
    const k = "tool_text.Edit.multiple"
    return `Edit error: old_string matches ${str(k, f, "count")} locations in ${str(k, f, "path")}. Use replace_all, or add more context to old_string.`
  },
  "tool_text.Edit.edited": (f) => {
    const k = "tool_text.Edit.edited"
    return `File edited: ${str(k, f, "path")} (${str(k, f, "replacements")} replacement(s))`
  },
  "tool_text.Edit.error": (f) => `Edit error: ${str("tool_text.Edit.error", f, "detail")}`,
  "tool_text.Glob.no_files": () => "No files matched the pattern.",
  "tool_text.Glob.missing_pattern": () => "Glob requires `pattern` (or alias `glob_pattern`).",
  "tool_text.Glob.arg_not_string": (f) => {
    const k = "tool_text.Glob.arg_not_string"
    return `Glob \`${str(k, f, "key")}\` must be a string. Received type: ${str(k, f, "got")}.`
  },
  "tool_text.Glob.error": (f) => `Glob error: ${str("tool_text.Glob.error", f, "detail")}`,
  "tool_text.Glob.timeout": globTimeout,
  "tool_text.Glob.skipped_dirs": globSkippedDirs,
  "tool_text.Grep.error": (f) => `Grep error: ${str("tool_text.Grep.error", f, "detail")}`,
  "tool_text.Grep.no_matches": () => "No matches found.",
  "mode.refusal": modeRefusal,
  "mode.active_stamp": (f) =>
    `<ma::agent::mode-active id="${str("mode.active_stamp", f, "id")}" since="${str("mode.active_stamp", f, "since")}" />`,
  "mode.change": (f) =>
    `<ma::agent::mode-change from="${str("mode.change", f, "from")}" to="${str("mode.change", f, "to")}" at="${str("mode.change", f, "at")}" />`,
  "tool_output.binary_withheld": binaryWithheld,
  "tool_text.Bash.aborted": () => "[aborted by user]",
  "tool_text.Write.not_read": notRead("Write"),
  "tool_text.Write.stale": stale("Write"),
  "tool_text.Edit.not_read": notRead("Edit"),
  "tool_text.Edit.stale": stale("Edit"),
  "tool_text.Grep.timed_out": grepTimedOut,
  "tool_text.Grep.exit_code": (f) =>
    `Grep error: rg exited with code ${str("tool_text.Grep.exit_code", f, "exitCode")}`,
  "tool_text.FilesStats.empty": filesStatsEmpty,
  "tool_text.FilesStats.not_enabled": () =>
    "FilesStats: file tracking is not enabled in this host. Thus the host does not record Read/Edit/Write calls, and this report is not available.",
  "mode.cli_refusal": modeCliRefusal,
}

/** Create the provider. It throws on a kind it does not own or a missing fact. */
export function createCoreToolsSyntheticProvider(): SyntheticTextProvider {
  return {
    kinds: KINDS,
    text(kind: SyntheticKind, facts: SyntheticFacts): string {
      const build = Object.hasOwn(TEXT, kind) ? TEXT[kind] : undefined
      if (build === undefined) throw new Error(`ma-core-tools-plugin: kind not owned: ${kind}`)
      return build(facts)
    },
  }
}
