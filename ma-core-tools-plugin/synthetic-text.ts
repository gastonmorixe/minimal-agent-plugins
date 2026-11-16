/**
 * Synthetic text provider for the built-in tool results (`tool_text.*`),
 * the tool output notices (`tool_output.preview`, `tool_output.truncated`,
 * `tool_output.streak`) and the mode texts (`mode.*`). Each text is built
 * from its facts only. The bytes equal the old core texts (core
 * `src/tools/PROMPTS.ts`, the read-file part of `src/media/PROMPTS.ts`,
 * `src/modes/PROMPTS.ts` and `src/prompts/runtime/output-preview*.md`).
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

// --- tool_output.preview (core src/prompts/runtime/output-preview*.md) ---

const PREVIEW_HINT =
  "the user only saw a fraction of this output. If you intended this for the user, summarize the key parts in your text reply (the user reads it in full)."
const PREVIEW_HINT_BASH =
  "the user only saw a fraction of this output. If you used Bash to render visual content (ASCII art, ANSI TUI preview, formatted tables) for the user, put it in your text reply instead : the user reads that in full."

function previewRecover(rawPath: string): string {
  return `The full untruncated output is saved at ${rawPath} : Read that path (its tail for build/test errors) when this preview isn't enough.`
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
      return `to continue, call Read with offset=${cutLine} (and limit as needed).`
    case "Grep":
      return "narrow with a more specific pattern, glob, or smaller -A/-B/-C. Or raise head_limit explicitly."
    case "Bash":
      return `output exceeded ${maxToolOutputBytes} bytes and the FRONT was kept, so trailing errors/build failures may be cut. Re-run scoped to the tail (e.g. \`... 2>&1 | tail -n 100\`) or filtered (\`grep -nE 'error:|FAIL'\`). Or Read the tail of the raw-output blob whose path is appended below, which holds the full output.`
    case "Glob":
      return "narrow the pattern or search a subdirectory."
    case "Fetch":
      return "the full body is preserved at the `<ma::agent::raw-output ... />` path below. Use Read on that path, or re-call Fetch with a CSS `selector` to scope to a specific element."
    case "WebSearch":
      return "lower `count`, narrow the query, or use the result's `url` to Fetch a specific page."
    default:
      return "re-run with narrower parameters. The full body is preserved at the `<ma::agent::raw-output ... />` path below."
  }
}

function truncated(facts: SyntheticFacts): string {
  const k = "tool_output.truncated"
  const shownBytes = str(k, facts, "shownBytes")
  const cutLine = num(k, facts, "cutLine")
  const hint = truncationHint(str(k, facts, "tool"), cutLine, num(k, facts, "maxToolOutputBytes"))
  return `[truncated: shown ${shownBytes} of ${str(k, facts, "totalBytes")} bytes, ${str(k, facts, "shownLines")}/${str(k, facts, "totalLines")} lines, cut at byte ${shownBytes}, line ${cutLine}. ${hint}]`
}

// --- tool_output.streak (core streakNote) ---

function streakBody(tool: string, threshold: number): string {
  switch (tool) {
    case "Read":
      return `you've truncated ${threshold} Read calls in a row. Use the totals from the last [truncated: ...] notice to compute a single offset+limit that lands where you need to read, instead of paging from byte 0.`
    case "Grep":
      return `you've truncated ${threshold} Grep calls in a row. Try \`output_mode: "files_with_matches"\` (densest), tighten the pattern, add a \`glob\`/\`path\` filter, or set \`head_limit\` explicitly rather than letting the cap fire.`
    case "Bash":
      return `you've truncated ${threshold} Bash calls in a row. Bound output at the source: \`head -c\`, \`head -n\`, \`tail\`, \`sed -n '1,Np'\`, or pipe through a filter. The post-hoc cap is lossy. Pre-bounding gives usable signal.`
    case "Glob":
      return `you've truncated ${threshold} Glob calls in a row. Narrow the pattern (e.g. add a subdirectory prefix or restrict the file extension) instead of matching the world.`
    default:
      return `you've truncated ${threshold} calls of this tool in a row. Re-think the parameters. See the [truncated: ...] notice on each prior call for resume hints.`
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
      ? ` ${skippedDirs} unreadable director${skippedDirs === 1 ? "y was" : "ies were"} skipped.`
      : ""
  return `[glob stopped after ${str(k, facts, "ms")}ms: partial results, the tree was too large to walk in full.${skipped} Narrow the pattern or search a subdirectory.]`
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
    `${tool} error: ${str(`tool_text.${tool}.not_read`, f, "path")} has not been read in this session. Read it first, then retry the ${tool.toLowerCase()}.`
}

/** `tool_text.<Tool>.stale`. */
function stale(tool: "Edit" | "Write") {
  return (f: SyntheticFacts): string => {
    const k = `tool_text.${tool}.stale`
    const status = str(k, f, "status")
    let reason: string
    if (status === "missing") reason = "file no longer exists (it was present when last read)"
    else if (status === "changed") reason = "file changed since it was last read"
    else throw new Error(`${k}: unknown status ${status}`)
    return `${tool} error: ${reason}: ${str(k, f, "path")}. Read it again, then retry the ${tool.toLowerCase()}.`
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
    "No files have been read or modified yet this session.",
    "Every successful Read, Edit, or Write records the file's size and modified-time.",
    "FilesStats reports each tracked file's live status:",
    "  present: unchanged since last read",
    "  changed: modified since last read (by you or another process)",
    "  missing: deleted since last read",
  ].join("\n")
}

function binaryWithheld(f: SyntheticFacts): string {
  if (f.optedIn === true) {
    return "Binary body is too large to inline as base64 under the tool-output budget. Use the path above (Read it, or ask the user to attach the file to their message)."
  }
  const saved = f.hasPath === true ? " Full bytes saved at the path above." : ""
  return `Binary body withheld from model context (not valid text, and dumping it wastes tokens).${saved} Re-call with binary=true for base64 when small enough, Read the saved path, or ask the user to attach the file.`
}

function modeCliRefusal(f: SyntheticFacts): string {
  const k = "mode.cli_refusal"
  const tool = str(k, f, "tool")
  const reason = str(k, f, "reason")
  if (reason === "deny-all") return `Tool "${tool}" is not permitted (--no-tools is active).`
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
    `[output exceeded ${str("tool_text.Bash.output_cap", f, "maxBytes")} bytes: command terminated and output truncated]`,
  "tool_text.Bash.timed_out": (f) =>
    `[timed out after ${str("tool_text.Bash.timed_out", f, "timeoutMs")}ms]`,
  // A null exit code has no `exitCode` fact. The old text printed "null".
  "tool_text.Bash.exit_code": (f) =>
    `Exit code ${f.exitCode === undefined ? "null" : String(f.exitCode)}`,
  "tool_text.Bash.error": (f) => `Bash error: ${str("tool_text.Bash.error", f, "detail")}`,
  "tool_text.Read.whitespace_resolved": (f) =>
    `Note: resolved to "${str("tool_text.Read.whitespace_resolved", f, "path")}" (whitespace mismatch).\n`,
  "tool_text.Read.too_large": (f) =>
    `File is ${str("tool_text.Read.too_large", f, "sizeMb")} MB, exceeds the ${str("tool_text.Read.too_large", f, "limitMb")} MB read limit. Use offset/limit to read a portion, or Grep to search it.`,
  "tool_text.Read.error": (f) => `Read error: ${str("tool_text.Read.error", f, "detail")}`,
  "tool_text.Read.binary_rejected": (f) => {
    const k = "tool_text.Read.binary_rejected"
    return `${str(k, f, "mimeType")} (${formatBytes(num(k, f, "sizeBytes"))}) is a binary document. Tool output can include text and images but not documents, so it can't be embedded here. Ask the user to attach it to their message, or convert it to text/images first.`
  },
  "tool_text.Read.unsupported_embedding": (f) => {
    const k = "tool_text.Read.unsupported_embedding"
    return `${str(k, f, "mimeType")} (${formatBytes(num(k, f, "sizeBytes"))}) can't be embedded in tool output. Ask the user to attach it to their message instead.`
  },
  "tool_text.Read.unsupported_image_modality": (f) => {
    const k = "tool_text.Read.unsupported_image_modality"
    return `${str(k, f, "modelId")} doesn't accept image input, so this ${str(k, f, "mimeType")} (${formatBytes(num(k, f, "sizeBytes"))}) can't be shown to the model. Describe it for the user from context, or switch to a vision-capable model.`
  },
  "tool_text.Read.image_too_large": (f) => {
    const k = "tool_text.Read.image_too_large"
    return `${formatBytes(num(k, f, "sizeBytes"))} image is too large to embed even after resizing (per-item cap ${formatBytes(num(k, f, "limitBytes"))} encoded for ${str(k, f, "modelId")}).`
  },
  "tool_text.Read.image_summary": imageSummary,
  "tool_text.Write.written": (f) => `File written: ${str("tool_text.Write.written", f, "path")}`,
  "tool_text.Write.error": (f) => `Write error: ${str("tool_text.Write.error", f, "detail")}`,
  "tool_text.Write.missing_path": () => "Write requires `file_path`.",
  "tool_text.Write.missing_content": () => "Write requires `content` (or alias `contents`).",
  "tool_text.Write.arg_not_string": (f) => {
    const k = "tool_text.Write.arg_not_string"
    return `Write \`${str(k, f, "key")}\` must be a string, got ${str(k, f, "got")}.`
  },
  "tool_text.Edit.not_found": (f) =>
    `Edit error: old_string not found in ${str("tool_text.Edit.not_found", f, "path")}`,
  "tool_text.Edit.multiple": (f) => {
    const k = "tool_text.Edit.multiple"
    return `Edit error: old_string matches ${str(k, f, "count")} locations in ${str(k, f, "path")}. Use replace_all or provide more context.`
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
    return `Glob \`${str(k, f, "key")}\` must be a string, got ${str(k, f, "got")}.`
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
    "FilesStats: file tracking is not enabled in this host. Read/Edit/Write observations and this report are unavailable here.",
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
