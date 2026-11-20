/**
 * Byte parity with today's core text (core-prompts decouple P2.3).
 *
 * (a) `buildToolDefinitions([provider])` equals the captured `tools.json`
 *     except for the description strings. P4 rewrote those in STE: the param
 *     descriptions equal STE_PARAMS. Each tool description equals its full
 *     STE text (STE_TOOL_DESCRIPTIONS) and keeps its verbatim tokens
 *     (STE_TOOL_TOKENS).
 * (b) Every `synthetic.json` entry whose kind this plugin owns: the case runs
 *     through the real core helper (so the facts are exactly what core
 *     passes), with a strict resolver that calls this provider and never the
 *     core fallback. The text equals the fixture text after the P4 STE
 *     rewrites (STE_SYNTHETIC) are applied to it.
 *
 * Core source is imported through the installed package directory
 * (`node_modules/@minimal-agent/core`), never through a sibling checkout: see
 * `scripts/no-sibling-core-imports.test.ts`.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import type {
  SyntheticFacts,
  SyntheticKind,
} from "@minimal-agent/core/plugin-api/types/synthetic-text"

import type { SyntheticTextResolver } from "../node_modules/@minimal-agent/core/src/agent/synthetic-text.ts"
import {
  binaryRejectedText,
  imageSummaryText,
  imageTooLargeText,
  unsupportedEmbeddingText,
  unsupportedImageModalityText,
} from "../node_modules/@minimal-agent/core/src/media/read-file.ts"
import { formatBytes as coreFormatBytes } from "../node_modules/@minimal-agent/core/src/media/types.ts"
import {
  modeActiveStampText,
  modeChangeText,
  modeCliRefusalText,
  modeRefusalText,
} from "../node_modules/@minimal-agent/core/src/modes/mode-text.ts"
import { ToolFeedbackTracker } from "../node_modules/@minimal-agent/core/src/tools/feedback-tracker.ts"
import { buildToolDefinitions } from "../node_modules/@minimal-agent/core/src/tools/tool-definitions.ts"
import * as T from "../node_modules/@minimal-agent/core/src/tools/tool-result-text.ts"

import { createCoreToolsSyntheticProvider, formatBytes, KINDS } from "./synthetic-text.ts"
import { createCoreToolTextProvider } from "./tool-text.ts"

const FIXTURES = join(import.meta.dir, "..", "tests", "text-parity", "fixtures")

interface FixtureCase {
  args: unknown[]
  text: string
}
interface FixtureEntry {
  fn: string
  file: string
  proposedKind: string
  cases: FixtureCase[]
}

const entries = (
  JSON.parse(readFileSync(join(FIXTURES, "synthetic.json"), "utf8")) as {
    entries: FixtureEntry[]
  }
).entries

const OWN = new Set<string>(KINDS)
const kindOf = (e: FixtureEntry): string => e.proposedKind.split("{")[0] ?? ""
const rows = entries.filter((e) => OWN.has(kindOf(e)))

const provider = createCoreToolsSyntheticProvider()

/** A resolver that asks only this provider. The core fallback fails the test. */
function strict(calls: SyntheticKind[]): SyntheticTextResolver {
  return {
    resolve(kind: SyntheticKind, facts: SyntheticFacts): string {
      calls.push(kind)
      const text = provider.text(kind, facts)
      if (text === "") throw new Error(`empty text for ${kind}`)
      return text
    },
  }
}

/** The tuiPreviewHint fixture text for a tool and a raw path. */
function previewHint(tool: string, rawPath: string | undefined): string {
  const cases = entries.find((e) => e.fn === "tuiPreviewHint")?.cases ?? []
  const key = tool === "Bash" ? "Bash" : "Read"
  const hit = cases.find((c) => c.args[0] === key && (c.args[1] ?? "") === (rawPath ?? ""))
  if (!hit) throw new Error(`no tuiPreviewHint fixture for ${key} ${rawPath}`)
  return hit.text
}

/** The truncationHint fixture case whose text is `hint`. */
function truncationHintCase(hint: string): FixtureCase {
  const hit = entries.find((e) => e.fn === "truncationHint")?.cases.find((c) => c.text === hint)
  if (!hit) throw new Error(`no truncationHint fixture for ${hint}`)
  return hit
}

/**
 * P4 STE rewrite of the synthetic text: old fixture text to new text. Each
 * pair is applied in order to the fixture text of every case. The fixtures
 * stay the old core bytes (core reads them), so the new text lives here.
 */
const STE_SYNTHETIC: ReadonlyArray<readonly [string | RegExp, string]> = [
  // tool_output.preview
  [
    "the user only saw a fraction of this output. If you intended this for the user, summarize the key parts in your text reply (the user reads it in full).",
    "the user saw only a part of this output. If this output is for the user, give a summary of the important parts in your text reply. The user reads the full text reply.",
  ],
  [
    "the user only saw a fraction of this output. If you used Bash to render visual content (ASCII art, ANSI TUI preview, formatted tables) for the user, put it in your text reply instead : the user reads that in full.",
    "the user saw only a part of this output. If you used Bash to show visual content to the user (ASCII art, ANSI TUI preview, formatted tables), put that content in your text reply. The user reads the full text reply.",
  ],
  [
    /The full untruncated output is saved at (\S+) : Read that path \(its tail for build\/test errors\) when this preview isn't enough\./g,
    "The harness saved the full output at $1. If this preview is not sufficient, Read that path. For build or test errors, Read the tail of that path.",
  ],
  // tool_output.truncated hints
  [
    /to continue, call Read with offset=(\d+) \(and limit as needed\)\./g,
    "to continue, call Read with offset=$1. Set limit if necessary.",
  ],
  [
    "narrow with a more specific pattern, glob, or smaller -A/-B/-C. Or raise head_limit explicitly.",
    "make the search narrower with a more specific pattern, a glob or a smaller -A/-B/-C. Or set a higher head_limit explicitly.",
  ],
  [
    /output exceeded (\d+) bytes and the FRONT was kept, so trailing errors\/build failures may be cut\. Re-run scoped to the tail \(e\.g\. `\.\.\. 2>&1 \| tail -n 100`\) or filtered \(`grep -nE 'error:\|FAIL'`\)\. Or Read the tail of the raw-output blob whose path is appended below, which holds the full output\./g,
    "output exceeded $1 bytes. The harness kept the start of the output, so errors or build failures at the end can be missing. Run the command again and send only the tail to the output (for example, `... 2>&1 | tail -n 100`). Or filter the output (`grep -nE 'error:|FAIL'`). Or Read the tail of the raw-output blob. The path of that blob is below, and the blob holds the full output.",
  ],
  [
    "the full body is preserved at the `<ma::agent::raw-output ... />` path below. Use Read on that path, or re-call Fetch with a CSS `selector` to scope to a specific element.",
    "the harness saved the full body at the `<ma::agent::raw-output ... />` path below. Read that path. Or call Fetch again with a CSS `selector` to get only a specific element.",
  ],
  [
    "lower `count`, narrow the query, or use the result's `url` to Fetch a specific page.",
    "set a lower `count` or make the query narrower. Or use the `url` of a result to Fetch a specific page.",
  ],
  [
    "re-run with narrower parameters. The full body is preserved at the `<ma::agent::raw-output ... />` path below.",
    "run the tool again with narrower parameters. The harness saved the full body at the `<ma::agent::raw-output ... />` path below.",
  ],
  // tool_output.streak
  [
    /you've truncated (\d+) Read calls in a row\. Use the totals from the last \[truncated: \.\.\.\] notice to compute a single offset\+limit that lands where you need to read, instead of paging from byte 0\./g,
    "the harness truncated the output of $1 Read calls in a row. Use the totals in the last [truncated: ...] notice to calculate one offset+limit for the part that you need. Do not read page by page from byte 0.",
  ],
  [
    /you've truncated (\d+) Grep calls in a row\. Try `output_mode: "files_with_matches"` \(densest\), tighten the pattern, add a `glob`\/`path` filter, or set `head_limit` explicitly rather than letting the cap fire\./g,
    'the harness truncated the output of $1 Grep calls in a row. Do one or more of these: use `output_mode: "files_with_matches"` (densest), make the pattern more specific, add a `glob`/`path` filter, set `head_limit` explicitly. Do not let the output limit cut the output.',
  ],
  [
    /you've truncated (\d+) Bash calls in a row\. Bound output at the source: `head -c`, `head -n`, `tail`, `sed -n '1,Np'`, or pipe through a filter\. The post-hoc cap is lossy\. Pre-bounding gives usable signal\./g,
    "the harness truncated the output of $1 Bash calls in a row. Limit the output in the command itself: `head -c`, `head -n`, `tail`, `sed -n '1,Np'`, or a pipe to a filter. The output limit after the run loses data. A limit in the command gives useful output.",
  ],
  [
    /you've truncated (\d+) Glob calls in a row\. Narrow the pattern \(e\.g\. add a subdirectory prefix or restrict the file extension\) instead of matching the world\./g,
    "the harness truncated the output of $1 Glob calls in a row. Make the pattern narrower, so that it does not match all files. For example, add a subdirectory prefix or specify the file extension.",
  ],
  [
    /you've truncated (\d+) calls of this tool in a row\. Re-think the parameters\. See the \[truncated: \.\.\.\] notice on each prior call for resume hints\./g,
    "the harness truncated the output of $1 calls of this tool in a row. Change the parameters. The [truncated: ...] notice of each earlier call tells you how to continue.",
  ],
  // tool_text.Glob.timeout (before the generic Glob hint below)
  [
    "partial results, the tree was too large to walk in full.",
    "partial results. The directory tree was too large to search in full.",
  ],
  [/ (\d+) unreadable directory was skipped\./g, " Glob skipped $1 unreadable directory."],
  [/ (\d+) unreadable directories were skipped\./g, " Glob skipped $1 unreadable directories."],
  [
    " Narrow the pattern or search a subdirectory.]",
    " Make the pattern narrower or search a subdirectory.]",
  ],
  [
    "narrow the pattern or search a subdirectory.",
    "make the pattern narrower or search a subdirectory.",
  ],
  // tool_text.Bash.output_cap
  [
    "bytes: command terminated and output truncated]",
    "bytes: the harness stopped the command and truncated the output]",
  ],
  // tool_text.Read.*
  ["(whitespace mismatch).", "(the whitespace did not match)."],
  [
    /MB, exceeds the (\d+) MB read limit\. Use offset\/limit to read a portion, or Grep to search it\./g,
    "MB. The read limit is $1 MB. Use offset/limit to read a part of the file, or use Grep to search the file.",
  ],
  [
    "is a binary document. Tool output can include text and images but not documents, so it can't be embedded here. Ask the user to attach it to their message, or convert it to text/images first.",
    "is a binary document. Tool output can contain text and images, but not documents. Thus the harness cannot put this document in the tool output. Ask the user to attach the document to their message. Or convert the document to text or images first.",
  ],
  [
    ") can't be embedded in tool output. Ask the user to attach it to their message instead.",
    "): tool output cannot contain this file. Ask the user to attach the file to their message instead.",
  ],
  [
    /(\S+) doesn't accept image input, so this (\S+) (\(\S+\)) can't be shown to the model\. Describe it for the user from context, or switch to a vision-capable model\./g,
    "$1 does not accept image input. Thus the harness cannot show this $2 $3 to the model. Describe the image for the user from the context. Or change to a model with vision support.",
  ],
  [
    /image is too large to embed even after resizing \(per-item cap (\S+) encoded for/g,
    "image is too large to embed, also after resizing (limit per item: $1 encoded for",
  ],
  // tool_text.Write.* / Edit.* / Glob.*
  [/` must be a string, got (\w+)\./g, "` must be a string. Received type: $1."],
  ["Edit error: old_string not found in ", "Edit error: old_string does not occur in "],
  [
    "Use replace_all or provide more context.",
    "Use replace_all, or add more context to old_string.",
  ],
  [
    /(Write|Edit) error: (\S+) has not been read in this session\. Read it first, then retry the (write|edit)\./g,
    "$1 error: you did not read $2 in this session. Read the file first. Then call $1 again.",
  ],
  [
    "error: file no longer exists (it was present when last read):",
    "error: the file does not exist now (it existed at the last read):",
  ],
  ["error: file changed since it was last read:", "error: the file changed after the last read:"],
  [/\. Read it again, then retry the write\./g, ". Read the file again. Then call Write again."],
  [/\. Read it again, then retry the edit\./g, ". Read the file again. Then call Edit again."],
  // tool_text.FilesStats.*
  [
    "Read/Edit/Write observations and this report are unavailable here.",
    "Thus the host does not record Read/Edit/Write calls, and this report is not available.",
  ],
  [
    "No files have been read or modified yet this session.\nEvery successful Read, Edit, or Write records the file's size and modified-time.\nFilesStats reports each tracked file's live status:\n  present: unchanged since last read\n  changed: modified since last read (by you or another process)\n  missing: deleted since last read",
    "This session has no read or changed files yet.\nEach successful Read, Edit or Write call records the size and modified time of the file.\nFilesStats reports the live status of each tracked file:\n  present: not changed after the last read\n  changed: changed after the last read (by you or by a different process)\n  missing: deleted after the last read",
  ],
  // tool_output.binary_withheld
  [
    "Binary body is too large to inline as base64 under the tool-output budget. Use the path above (Read it, or ask the user to attach the file to their message).",
    "The binary body is too large to include as base64 in the tool output budget. Use the path above. Read that path, or ask the user to attach the file to their message.",
  ],
  [
    "Binary body withheld from model context (not valid text, and dumping it wastes tokens).",
    "The harness did not put the binary body in the model context. The body is not valid text, and it uses tokens for no purpose.",
  ],
  [" Full bytes saved at the path above.", " The harness saved the full bytes at the path above."],
  [
    "Re-call with binary=true for base64 when small enough, Read the saved path, or ask the user to attach the file.",
    "Do one of these: call the tool again with binary=true to get base64 if the body is small enough, Read the saved path, or ask the user to attach the file.",
  ],
  // mode.cli_refusal
  ["is not permitted (--no-tools is active).", "is not permitted because --no-tools is active."],
]

/** The number of fixture texts that each STE_SYNTHETIC rule changed. */
const steHits: number[] = STE_SYNTHETIC.map(() => 0)

/** The fixture text with the P4 STE rewrites applied. Counts the hit of each rule. */
function ste(text: string): string {
  let out = text
  STE_SYNTHETIC.forEach(([from, to], i) => {
    const next = typeof from === "string" ? out.split(from).join(to) : out.replace(from, to)
    if (next !== out) steHits[i] = (steHits[i] ?? 0) + 1
    out = next
  })
  return out
}

type Obj = Record<string, unknown>
const s = (v: unknown): string => v as string
const n = (v: unknown): number => v as number

/**
 * One fixture fn: how a case runs through the core helper, and (where the
 * old fn took a hint argument) how the fixture text maps to today's text.
 * Same mapping as core tool-result-text.parity.test.ts and
 * runtime-text.parity.test.ts.
 */
interface Row {
  run: (t: SyntheticTextResolver, args: unknown[]) => string
  expect?: (c: FixtureCase) => string
}

const ROWS: Record<string, Row> = {
  bashErrorResult: { run: (t, a) => T.bashErrorText(t, s(a[0])) },
  bashExitCodeResult: { run: (t, a) => T.bashExitCodeText(t, a[0] as number | null) },
  bashOutputCapMarker: { run: (t, a) => T.bashOutputCapText(t, n(a[0])) },
  bashTimedOutMarker: { run: (t, a) => T.bashTimedOutText(t, n(a[0])) },
  cdNoSuchDirectoryResult: { run: (t, a) => T.bashCdNoDirText(t, s(a[0])) },
  editErrorResult: { run: (t, a) => T.editErrorText(t, s(a[0])) },
  editOldStringMultipleMatchesResult: { run: (t, a) => T.editMultipleText(t, n(a[0]), s(a[1])) },
  editOldStringNotFoundResult: { run: (t, a) => T.editNotFoundText(t, s(a[0])) },
  fileEditedResult: { run: (t, a) => T.editEditedText(t, s(a[0]), n(a[1])) },
  fileWrittenResult: { run: (t, a) => T.writeWrittenText(t, s(a[0])) },
  globArgNotStringResult: { run: (t, a) => T.globArgNotStringText(t, s(a[0]), s(a[1])) },
  globErrorResult: { run: (t, a) => T.globErrorText(t, s(a[0])) },
  globMissingPatternResult: { run: (t) => T.globMissingPatternText(t) },
  globSkippedDirsNotice: { run: (t, a) => T.globSkippedDirsText(t, n(a[0])) },
  globTimeoutNotice: { run: (t, a) => T.globTimeoutText(t, n(a[0]), n(a[1])) },
  grepErrorResult: { run: (t, a) => T.grepErrorText(t, s(a[0])) },
  noFilesMatchedResult: { run: (t) => T.globNoFilesText(t) },
  noMatchesFoundResult: { run: (t) => T.grepNoMatchesText(t) },
  readErrorResult: { run: (t, a) => T.readErrorText(t, s(a[0])) },
  readTooLargeResult: { run: (t, a) => T.readTooLargeText(t, s(a[0]), n(a[1])) },
  whitespaceResolvedNote: { run: (t, a) => T.readWhitespaceText(t, s(a[0])) },
  writeArgNotStringResult: { run: (t, a) => T.writeArgNotStringText(t, s(a[0]), s(a[1])) },
  writeErrorResult: { run: (t, a) => T.writeErrorText(t, s(a[0])) },
  writeMissingContentResult: { run: (t) => T.writeMissingContentText(t) },
  writeMissingPathResult: { run: (t) => T.writeMissingPathText(t) },
  // P3.7 kinds (old text: core 56fc856 inline strings).
  writeTrackedFileNotReadResult: { run: (t, a) => T.notReadText(t, "Write", s(a[1])) },
  editTrackedFileNotReadResult: { run: (t, a) => T.notReadText(t, "Edit", s(a[1])) },
  writeTrackedFileStaleResult: {
    run: (t, a) => T.staleReadText(t, "Write", s(a[1]), a[2] as "missing" | "changed"),
  },
  editTrackedFileStaleResult: {
    run: (t, a) => T.staleReadText(t, "Edit", s(a[1]), a[2] as "missing" | "changed"),
  },
  bashAbortedMarker: { run: (t) => T.bashAbortedText(t) },
  grepTimedOutResult: { run: (t, a) => T.grepTimedOutText(t, n(a[0]), a[1] as "rg" | "js") },
  grepExitCodeResult: { run: (t, a) => T.grepExitCodeText(t, n(a[0])) },
  filesStatsNotEnabledResult: { run: (t) => T.filesStatsNotEnabledText(t) },
  filesStatsEmptyReport: { run: (t, a) => T.filesStatsEmptyText(t, a[0] === true) },
  binaryWithheldProse: { run: (t, a) => T.binaryWithheldText(t, a[0] === true, a[1] === true) },
  cliToolGateRefusal: {
    run: (t, a) => modeCliRefusalText(t, s(a[0]), a[1] as "deny-all" | "allow-list"),
  },
  outputPreviewAnnotation: {
    run: (t, a) => {
      const o = a[0] as Obj
      const rawPath = s(o.path ?? "")
      const tag = T.previewTagText(t, {
        shown: n(o.shown),
        total: n(o.total),
        tool: s(o.tool),
        ...(rawPath ? { rawPath } : {}),
      })
      return `${s(o.content)}\n\n${tag}`
    },
    // The old fn took the hint. Today the kind renders it from the tool.
    expect: (c) => {
      const o = c.args[0] as Obj
      const end = `>${s(o.hint)}</ma::agent::output-preview>`
      expect(c.text.endsWith(end)).toBe(true)
      const hint = previewHint(s(o.tool), s(o.path ?? "") || undefined)
      return `${c.text.slice(0, -end.length)}>${hint}</ma::agent::output-preview>`
    },
  },
  tuiPreviewHint: {
    run: (t, a) => {
      const rawPath = s(a[1] ?? "")
      const tag = T.previewTagText(t, {
        shown: 1,
        total: 2,
        tool: s(a[0]),
        ...(rawPath ? { rawPath } : {}),
      })
      return tag.slice(tag.indexOf(">") + 1, tag.lastIndexOf("</ma::agent::output-preview>"))
    },
  },
  truncatedOutputNotice: {
    run: (t, a) => {
      const o = a[0] as Obj
      const hint = s(o.hint)
      const tool = hint === "" ? "" : s(truncationHintCase(hint).args[0] ?? "")
      // "unknown" totals check the template bytes only. Core always has numbers.
      const total = (v: unknown): number => (/^\d+$/.test(s(v)) ? Number(v) : v) as number
      const notice = T.truncatedNoticeText(t, {
        tool,
        shownBytes: n(o.shownBytes),
        totalBytes: total(o.totalBytes),
        shownLines: n(o.shownLines),
        totalLines: total(o.totalLines),
        cutLine: n(o.cutLine),
        maxToolOutputBytes: 65536,
      })
      return `${s(o.kept)}\n\n${notice}`
    },
    expect: (c) => {
      const o = c.args[0] as Obj
      if (s(o.hint) !== "") return c.text
      // An empty hint: today the default (no tool) hint is rendered.
      const fallback = entries.find((e) => e.fn === "truncationHint")?.cases.at(-1)?.text ?? "?"
      expect(c.text.endsWith(". ]")).toBe(true)
      return `${c.text.slice(0, -1)}${fallback}]`
    },
  },
  truncationHint: {
    run: (t, a) => {
      const notice = T.truncatedNoticeText(t, {
        tool: s(a[0] ?? ""),
        shownBytes: 1,
        totalBytes: 2,
        shownLines: 1,
        totalLines: 2,
        cutLine: n(a[1]),
        maxToolOutputBytes: n(a[2]),
      })
      const head = `line ${n(a[1])}. `
      return notice.slice(notice.indexOf(head) + head.length, -1)
    },
  },
  streakNote: {
    run: (t, a) => {
      const tracker = new ToolFeedbackTracker(n(a[1]))
      let note: string | null = null
      for (let i = 0; i < n(a[1]); i++) note = tracker.observe(s(a[0]), true, t)
      return note ?? ""
    },
  },
  binaryDocumentRejectedMessage: {
    run: (t, a) => binaryRejectedText(t, a[0] as { mimeType: string; sizeBytes: number }),
  },
  unsupportedEmbeddingMessage: {
    run: (t, a) => unsupportedEmbeddingText(t, a[0] as { mimeType: string; sizeBytes: number }),
  },
  unsupportedImageModalityMessage: {
    run: (t, a) =>
      unsupportedImageModalityText(
        t,
        a[0] as { modelId: string; mimeType: string; sizeBytes: number },
      ),
  },
  fittedImageTooLargeMessage: {
    run: (t, a) =>
      imageTooLargeText(t, a[0] as { sizeBytes: number; limitBytes: number; modelId: string }),
  },
  imageSummaryMessage: {
    run: (t, a) =>
      imageSummaryText(
        t,
        a[0] as {
          subtype: string
          sizeBytes: number
          dimensions: { width: number; height: number } | null
          fittedStrategy: string | null
        },
      ),
  },
  modeToolRefusalMessage: {
    run: (t, a) => {
      const o = a[0] as Obj
      return modeRefusalText(t, {
        toolName: s(o.toolName),
        modeId: s(o.label).toLowerCase(),
        label: s(o.label),
        ...(o.refusalHint !== undefined ? { refusalHint: s(o.refusalHint) } : {}),
      })
    },
  },
  activeModeStamp: { run: (t, a) => modeActiveStampText(t, s(a[0]), s(a[1])) },
  modeChangeAttachment: {
    run: (t, a) => modeChangeText(t, a[0] as { from: string; to: string; at: string }),
  },
}

/** P4 STE param descriptions, keyed by tool, then by schema property. */
const STE_PARAMS: Record<string, Record<string, string>> = {
  Bash: {
    command: "The command to run.",
    timeout:
      "Optional. The time limit in milliseconds. The default is 120000 (2 minutes). The maximum is 600000 (10 minutes): the tool decreases a larger value. For longer work, use `BackgroundRun`.",
    description: "A short description of the command.",
  },
  Read: {
    file_path: "The full path of the file to read.",
    offset: "The zero-based index of the first line. Line 1 is index 0.",
    limit: "The number of lines to read.",
  },
  Write: {
    file_path: "The full path of the file to write.",
    content: "The text to write to the file. You can also use the alias `contents`.",
    contents: "An alias for `content`. If `content` has a value, the tool ignores this alias.",
  },
  Edit: {
    file_path: "The full path.",
    old_string: "The same text as in the file.",
    new_string: "The replacement.",
    replace_all: "`true` replaces all. The default is `false`.",
  },
  Glob: {
    pattern: "The glob pattern for the file paths. You can also use the alias `glob_pattern`.",
    glob_pattern: "An alias for `pattern`. If `pattern` has a value, the tool ignores this alias.",
    path: "The directory to examine. The default is the cwd. You can also use the alias `target_directory`.",
    target_directory: "An alias for `path`. If `path` has a value, the tool ignores this alias.",
  },
  Grep: {
    pattern: "The regex pattern to find.",
    path: "The file or directory to examine. The default is the cwd.",
    glob: 'A glob pattern that selects the files, for example `"*.js"`.',
    output_mode: "`files_with_matches` (default), `content` or `count`.",
    "-i": "If `true`, `A` and `a` are the same letter.",
    "-n": "The tool ignores this value. The `content` output always has line numbers.",
    "-A": "The number of lines to show after each line that agrees.",
    "-B": "The number of lines to show before each line that agrees.",
    "-C": "The number of lines to show before and after each line that agrees.",
    context: "An alias for `-C`.",
    head_limit: "The maximum number of output lines. The default is 250.",
    multiline: "If `true`, a pattern can agree with more than one line.",
  },
  FilesStats: {
    status:
      "Optional. Show only the files with this status: `all`, `present`, `missing` or `changed`.",
    path: "Optional. Show only the files with this full path or with this directory prefix.",
  },
}

/** P4 STE: the verbatim tokens each rewritten tool description must keep. */
const STE_TOOL_TOKENS: Record<string, string[]> = {
  Bash: [
    "Grep",
    "Glob",
    "Read",
    "~64KB / 1000 lines",
    "`tail`",
    "`BackgroundRun`",
    "`bun install`",
    "`sleep`",
    "`cd <path>`",
  ],
  Read: [
    "`cat -n`",
    "PNG, JPEG, GIF or WebP",
    "~64KB / 1000 lines",
    "`offset`",
    "`limit`",
    "`offset` and `limit` apply to text only.",
  ],
  Write: ["Write a file to the local filesystem."],
  Edit: ["Replace text in a file."],
  Glob: ["`find`, `fd` or `ls`", "`**/*.ts`", "`src/**/*.{js,ts}`", "100 paths", "sorted by name"],
  Grep: [
    "ripgrep",
    "`grep` or `rg`",
    ".gitignore",
    "~64KB / 1000 lines",
    "`output_mode` (`files_with_matches`)",
    '`"content"`',
    "`glob`",
    "`path`",
  ],
  FilesStats: ["`status`", "read-only"],
  Mode: ["`ASK`", "`null`", "tool_result", "`<ma::agent::mode-active id=... since=... />`"],
}

/**
 * P4 STE: the full text of each rewritten tool description. The test compares
 * each description byte for byte, so a changed or deleted sentence fails.
 */
const STE_TOOL_DESCRIPTIONS: Record<string, string> = {
  Bash: [
    "Run a bash command and give its output.",
    "",
    "Do not use Bash to find, read or count code: use `Grep`, `Glob` or `Read`. Use Bash for builds, tests, git, `bun install` and other shell work.",
    "",
    "The output has a limit of ~64KB / 1000 lines and keeps the start. Filter long output, or use `tail`. Put tables and reports in your text, not in the output.",
    "",
    "For long work, use `BackgroundRun` if you have it. To wait, stop your turn: do not use `sleep`. Only a bare `cd <path>` stays. Each command has a new shell.",
  ].join("\n"),
  Read: [
    "Read a file from the local filesystem.",
    "",
    "For a text file, the tool gives the contents with `cat -n` line numbers. Do not put a line-number prefix in an `Edit` `old_string`. For an image file (PNG, JPEG, GIF or WebP), the tool gives the image, not text. Use it to see a screenshot.",
    "",
    "The text output has a limit of ~64KB / 1000 lines. For a larger file, read pages with `offset` and `limit`. `offset` and `limit` apply to text only.",
  ].join("\n"),
  Write: [
    "Write a file to the local filesystem. If the file is on the disk, the tool replaces it.",
  ].join("\n"),
  Edit: ["Replace text in a file."].join("\n"),
  Glob: [
    "Find files by name or path with a glob pattern, for example `**/*.ts` or `src/**/*.{js,ts}`. Do not use `find`, `fd` or `ls` in Bash for this task.",
    "",
    "The tool gives the paths that agree with the pattern, sorted by name. It stops after 100 paths and does not give the total. Do not use it to count more than 100 files.",
  ].join("\n"),
  Grep: [
    "Find text in files with a regex. The tool uses ripgrep and obeys .gitignore. Do not run `grep` or `rg` as a Bash command.",
    "",
    'The output has a limit of ~64KB / 1000 lines. The default `output_mode` (`files_with_matches`) gives only the paths. For the lines, use `"content"`. To make the output smaller, use `glob` or `path`.',
  ].join("\n"),
  FilesStats: [
    "Show the status at this time of the files that the session recorded. To show all, do not set `status`. This tool has read-only access. It does not examine the filesystem or record new files.",
  ].join("\n"),
  Mode: [
    "Show the active mode (for example, `ASK`) and its tool permissions. Use it if you are not sure of the mode.",
    "",
    "The tool gives a JSON object. If `id` is `null`, no mode is active.",
    "",
    "When a mode is active, each tool_result has a `<ma::agent::mode-active id=... since=... />` tag at its end. Thus, use this tool only when you got no tool_result for some time.",
  ].join("\n"),
}

type Def = { name: string; description: string; input_schema: Obj }

/** A tool definition with every description string removed. */
function withoutDescriptions(d: Def): Obj {
  const props = (d.input_schema.properties ?? {}) as Record<string, Obj>
  const bare: Record<string, Obj> = {}
  for (const [k, v] of Object.entries(props)) {
    const { description: _d, ...rest } = v
    bare[k] = rest
  }
  return { name: d.name, input_schema: { ...d.input_schema, properties: bare } }
}

describe("tool definitions parity", () => {
  const fixture = JSON.parse(readFileSync(join(FIXTURES, "tools.json"), "utf8")) as {
    toolDefinitionsJson: string
  }
  const want = JSON.parse(fixture.toolDefinitionsJson) as Def[]
  const defs = JSON.parse(
    JSON.stringify(buildToolDefinitions([createCoreToolTextProvider()]), null, 2),
  ) as Def[]

  it("buildToolDefinitions([provider]) equals the captured JSON except the descriptions", () => {
    expect(defs.map(withoutDescriptions)).toEqual(want.map(withoutDescriptions))
  })

  it("param descriptions equal the STE text", () => {
    for (const d of defs) {
      const props = (d.input_schema.properties ?? {}) as Record<string, Obj>
      const got = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, v.description]))
      expect(got, d.name).toEqual(STE_PARAMS[d.name] ?? {})
    }
  })

  it("tool descriptions keep their verbatim tokens", () => {
    for (const d of defs) {
      const tokens = STE_TOOL_TOKENS[d.name]
      expect(tokens, d.name).toBeDefined()
      for (const t of tokens ?? []) expect(d.description, `${d.name}: ${t}`).toContain(t)
    }
  })

  it("tool descriptions equal the full STE text", () => {
    expect(defs.map((d) => d.name).sort()).toEqual(Object.keys(STE_TOOL_DESCRIPTIONS).sort())
    for (const d of defs) expect(d.description, d.name).toBe(STE_TOOL_DESCRIPTIONS[d.name] ?? "")
  })

  it("every built-in tool gets its text from the provider, not the core fallback", () => {
    const p = createCoreToolTextProvider()
    for (const name of p.tools) {
      const t = p.tool(name)
      expect(t?.description.length ?? 0, name).toBeGreaterThan(0)
      expect(t?.description).toBe(t?.description.trim())
    }
    expect(p.tool("Fetch")).toBeUndefined()
  })
})

describe("synthetic text parity table", () => {
  it("covers a fixture row for every fixture entry of an owned kind", () => {
    expect(rows.length).toBeGreaterThan(0)
    for (const e of rows) expect(ROWS[e.fn], e.fn).toBeDefined()
  })

  it("every owned kind is exercised by some fixture row", () => {
    const hit = new Set(rows.map(kindOf))
    expect([...KINDS].filter((k) => !hit.has(k))).toEqual([])
  })

  for (const e of rows) {
    it(`${e.fn} (${kindOf(e)}) gives the fixture text through this provider`, () => {
      const row = ROWS[e.fn] as Row
      for (const c of e.cases) {
        const calls: SyntheticKind[] = []
        const want = ste(row.expect ? row.expect(c) : c.text)
        expect(row.run(strict(calls), c.args)).toBe(want)
        expect(calls).toEqual([kindOf(e) as SyntheticKind])
      }
    })
  }
})

describe("tool_text.Bash.timed_out: a clamped limit", () => {
  it("names the clamp only when core sends `clamped: true`", () => {
    const calls: SyntheticKind[] = []
    const t = strict(calls)
    expect(T.bashTimedOutText(t, 200)).toBe("[timed out after 200ms]")
    expect(T.bashTimedOutText(t, 600_000, true)).toBe(
      "[timed out after 600000ms (clamped to the max)]",
    )
    expect(provider.text("tool_text.Bash.timed_out", { timeoutMs: 200, clamped: false })).toBe(
      "[timed out after 200ms]",
    )
    expect(calls).toEqual(["tool_text.Bash.timed_out", "tool_text.Bash.timed_out"])
  })
})

describe("STE_SYNTHETIC rules", () => {
  it("each rule hits at least one fixture text", () => {
    for (const e of rows) {
      const row = ROWS[e.fn] as Row
      for (const c of e.cases) ste(row.expect ? row.expect(c) : c.text)
    }
    const dead = STE_SYNTHETIC.filter((_r, i) => (steHits[i] ?? 0) < 1).map(([from]) =>
      String(from),
    )
    expect(dead).toEqual([])
  })
})

describe("formatBytes (N1)", () => {
  it("equals core formatBytes on every boundary", () => {
    const K = 1024
    const M = K * K
    const G = M * K
    const cases = [0, 1, 1023, K, K + 1, 1536, 10 * K, M - 1, M, M + 1, 1.5 * M, G - 1, G, 3 * G]
    for (const b of cases) expect(formatBytes(b), String(b)).toBe(coreFormatBytes(b))
  })
})

describe("provider errors", () => {
  it("throws on a kind it does not own", () => {
    expect(() => provider.text("tool_result.aborted", { site: "runtime" })).toThrow()
  })

  it("throws on a missing required fact", () => {
    expect(() => provider.text("tool_text.Bash.cd_no_dir", {})).toThrow()
  })
})
