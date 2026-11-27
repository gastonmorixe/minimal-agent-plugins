/**
 * Word budget for the tool block, which ships on every request.
 *
 * The STE rules judge how a sentence is written. They do not judge how much
 * text ships. The first STE pass grew the tool block by 5.1% (+404 words,
 * about +350 tokens on every request), and no rule could see it.
 *
 * Two gates:
 * - {@link TOOL_WORDS}: one ratchet entry per shipped tool. A tool may not
 *   grow past its entry, and an entry may not sit more than
 *   {@link PER_TOOL_LOOSE} words above the tool. A raise needs a
 *   {@link RAISES} row with a reason (facts beat the budget: never drop a fact
 *   to fit a number, raise the entry and say why).
 * - {@link TOOL_BLOCK_WORDS}: the whole block, with {@link LOOSE_WORDS}.
 *
 * Word count (R3 bug B8): every budget number in this file comes from
 * {@link budgetWords}, a split of the RAW text on whitespace. That is the text
 * that ships, so a code span, a URL or a path counts as the words it holds.
 * The s1 sentence-length rule (`ste-rules.ts` `wordCount`) counts MASKED text,
 * where a code span is one word. The two numbers differ on purpose: s1 judges
 * how a sentence reads, the budget judges what a request costs. Do not mix
 * them.
 *
 * @module tests/ste/tool-budget
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { PLUGINS_ROOT } from "./surfaces.ts"
import { wireToolNames } from "./tool-names.ts"

/**
 * The widest golden: the built-in tools plus the plugin fixture tools. It is
 * the first source of {@link shippedTools}. The manifests are the second.
 */
export const GOLDEN = join(PLUGINS_ROOT, "tests/request-golden/goldens/plugin-handler-throws.json")

/**
 * Total words for the whole tool block, measured 2026-11-16.
 *
 * HEAD (before the STE pass) was 7910, and the pass grew it to 8314. It was cut
 * to 7900 by removing repetition, but that cut dropped facts the reviewer
 * caught. Amanda's decision: facts beat the budget. The facts are restored and
 * the budget is set to the measured value. The ratchet blocks growth from here.
 * Lower it by hand after a real cut. The lower tolerance stops it sitting
 * loose.
 *
 * 2026-11-17 STE pass (ASD-STE100 Issue 9) with the 500-character cap per
 * description (`MAX_DESCRIPTION_CHARS`): from 8163 to 6856 words.
 *
 * 2026-11-17 review A fixes (31e4815) restored facts in Bash, Computer and
 * SubAgentsSpawnAgent (see {@link RAISES}): 6856 to 6875 words. The total
 * counts the golden tools only (a default lead request, {@link blockWords}).
 *
 * 2026-11-17 review B round 2 (part of speech, one term per item, value labels)
 * and the trim after it: 6875 to 6747 words. Every TOOL_WORDS entry is set to
 * its measured value.
 *
 * 2026-11-23 the new SessionTitle tool (ma-title-plugin, 112 words) ships in
 * every golden: 6747 to 6842 words (see {@link BLOCK_RAISES}).
 *
 * 2026-11-27 tool attachments (ChromeCDP screenshot and PDF, Fetch image URL): 6842 to 6884 words.
 *
 * 2026-11-27 the prompt diet moved facts from 14 system prompt blocks into
 * the tool text: 6842 to 7384 words, and the system prompt went down more.
 * The probe S10 regression fix made the MemoryTool save rules explicit:
 * 7384 to 7408 words. Review m3 (clearer security wording in Computer): 7409.
 *
 * 2026-11-27 merge of the prompt diet with the tool attachments: 7409 to 7451
 * words (the 42 attachment words on top of the prompt diet).
 */
export const TOOL_BLOCK_WORDS = 7451

/** How far below {@link TOOL_BLOCK_WORDS} the tree may drift before it must be lowered. */
export const LOOSE_WORDS = 50

/**
 * The words of each shipped tool (description plus every nested schema
 * `description`), measured 2026-11-17 with {@link budgetWords} from
 * {@link shippedTools}: the golden, plus every manifest tool that the golden
 * does not have (review C B3: SecurityStatus, CloudStatus, CloudLogin,
 * CloudPush and the worker-only SubAgentsReportResult).
 *
 * This is a ratchet, not a target. After a cut, lower the entry (the test
 * fails when an entry is more than {@link PER_TOOL_LOOSE} above the tool).
 * To raise an entry, add a {@link RAISES} row with the reason. A new tool gets
 * an entry equal to its measured words. `bun run scripts/tool-words.ts`
 * prints the table.
 */
export const TOOL_WORDS: Readonly<Record<string, number>> = {
  BackgroundLogs: 108,
  BackgroundRun: 190,
  BackgroundStatus: 60,
  BackgroundStop: 84,
  Bash: 116,
  ChromeCDP: 410,
  // CloudLogin, CloudPush, CloudStatus: ma-agent-cloud (enabled: false), not in a golden.
  CloudLogin: 58,
  CloudPush: 65,
  CloudStatus: 58,
  CompactContext: 162,
  Computer: 696,
  DiffViewerShowDiff: 111,
  Edit: 24,
  Fetch: 439,
  FilesStats: 62,
  Glob: 119,
  Grep: 168,
  IntercomInbox: 88,
  IntercomPeers: 139,
  IntercomSend: 198,
  LockStatus: 215,
  MemoryTool: 345,
  Mode: 65,
  ModelInfo: 86,
  PromptDelete: 49,
  PromptEdit: 71,
  PromptList: 58,
  PromptNew: 110,
  PromptShow: 48,
  Read: 107,
  ScheduleCronCreate: 210,
  ScheduleCronDelete: 52,
  ScheduleCronList: 45,
  ScheduleCronReschedule: 90,
  // SecurityStatus: ma-security-plugin (enabled: false), not in a golden.
  SecurityStatus: 15,
  SessionHistory: 276,
  SessionInfo: 68,
  SessionTitle: 112,
  Skill: 208,
  Speak: 176,
  SpeakStatus: 58,
  SpeakStop: 65,
  SubAgentsAgentOutput: 58,
  SubAgentsAgentResult: 91,
  SubAgentsAgentStatus: 60,
  SubAgentsListAgents: 55,
  SubAgentsMailbox: 109,
  // SubAgentsReportResult: worker-only (ships to every worker), not in a golden.
  SubAgentsReportResult: 174,
  SubAgentsSpawnAgent: 540,
  SubAgentsStopAgent: 80,
  Task: 495,
  WebSearch: 221,
  Write: 54,
}

/** How far an entry may sit above its tool before the entry must be lowered. */
export const PER_TOOL_LOOSE = 10

/** One raise of a {@link TOOL_WORDS} entry. */
export interface Raise {
  /** Wire tool name. */
  tool: string
  /** The entry at the merge base. */
  from: number
  /** The new entry. */
  to: number
  /** ISO date of the raise. */
  date: string
  /** Why the words are needed (a fact, or a rule such as "STE s21"). */
  reason: string
}

/**
 * The raise log. An entry above its value at the merge base needs a row here
 * with the same `tool`, `from` and `to`. Keep old rows: they are the history.
 */
export const RAISES: readonly Raise[] = [
  {
    tool: "ModelInfo",
    from: 74,
    to: 86,
    date: "2026-11-17",
    reason:
      "restore 'do not use your memory of the model' and the thinking and prompt-cache outputs (DROPPED.md risk 9)",
  },
  {
    tool: "Read",
    from: 108,
    to: 111,
    date: "2026-11-17",
    reason: "restore 'use it to see a screenshot' (DROPPED.md risk 10)",
  },
  {
    tool: "Bash",
    from: 115,
    to: 117,
    date: "2026-11-17",
    reason: "review A: BackgroundRun is a plugin tool, so 'use `BackgroundRun` if you have it'",
  },
  {
    tool: "Computer",
    from: 646,
    to: 652,
    date: "2026-11-17",
    reason:
      "review A: combo, key and modifiers apply to key AND keypress (one handler, Router.swift:111,184-202)",
  },
  {
    tool: "SubAgentsSpawnAgent",
    from: 504,
    to: 515,
    date: "2026-11-17",
    reason:
      "review A: the tool rejects an incorrect effort level when it knows the levels; only an unknown level stops the worker",
  },
  {
    tool: "ChromeCDP",
    from: 340,
    to: 360,
    date: "2026-11-27",
    reason:
      "a screenshot or PDF result now comes as an image or a file (tool attachments), so the model must not write the base64 itself",
  },
  {
    tool: "Fetch",
    from: 396,
    to: 417,
    date: "2026-11-27",
    reason:
      "an image URL now comes as an image, or as a saved file when the model cannot read images (tool attachments)",
  },
  {
    tool: "BackgroundRun",
    from: 183,
    to: 190,
    date: "2026-11-27",
    reason:
      "the prompt diet (2026-11-27) moved the facts of the deleted system prompt block into this tool text: the background-jobs block (a job stops when the agent exits)",
  },
  {
    tool: "ChromeCDP",
    from: 340,
    to: 390,
    date: "2026-11-27",
    reason:
      "the prompt diet (2026-11-27) moved the facts of the deleted system prompt block into this tool text: the ChromeCDP or Fetch rules, the last tab rule and the enable step",
  },
  {
    tool: "CloudStatus",
    from: 51,
    to: 58,
    date: "2026-11-27",
    reason: "D13 and F15: the false stub text is gone, the tool now names the backend URL fact",
  },
  {
    tool: "Computer",
    from: 647,
    to: 695,
    date: "2026-11-27",
    reason:
      "the prompt diet (2026-11-27) moved the facts of the deleted system prompt block into this tool text: the safety rule (no login end, purchase, safety value or data delete flow without a request), F01a",
  },
  {
    tool: "Computer",
    from: 647,
    to: 696,
    date: "2026-11-27",
    reason:
      "review m3 clearer security wording: a password or permission change, not a safety value",
  },
  {
    tool: "DiffViewerShowDiff",
    from: 89,
    to: 111,
    date: "2026-11-27",
    reason:
      "the prompt diet (2026-11-27) moved the facts of the deleted system prompt block into this tool text: the diff tag rule of the DiffViewerShowDiff block",
  },
  {
    tool: "Fetch",
    from: 396,
    to: 417,
    date: "2026-11-27",
    reason:
      "the prompt diet (2026-11-27) moved the facts of the deleted system prompt block into this tool text: Fetch block, and the ChromeCDP routing (DECISIONS G2 item 6)",
  },
  {
    tool: "IntercomInbox",
    from: 67,
    to: 88,
    date: "2026-11-27",
    reason:
      "the prompt diet (2026-11-27) moved the facts of the deleted system prompt block into this tool text: the intercom policy (no poll, dedup on the id)",
  },
  {
    tool: "IntercomSend",
    from: 176,
    to: 198,
    date: "2026-11-27",
    reason:
      "the prompt diet (2026-11-27) moved the facts of the deleted system prompt block into this tool text: the intercom policy, and the SubAgentsMailbox routing (D14)",
  },
  {
    tool: "LockStatus",
    from: 174,
    to: 215,
    date: "2026-11-27",
    reason:
      "the prompt diet (2026-11-27) moved the facts of the deleted system prompt block into this tool text: the lock advice (DECISIONS G2 item 3)",
  },
  {
    tool: "MemoryTool",
    from: 266,
    to: 321,
    date: "2026-11-27",
    reason:
      "the prompt diet (2026-11-27) moved the facts of the deleted system prompt block into this tool text: the save rules of the memory block",
  },
  {
    // From the committed floor (266), because the row above is not committed yet.
    tool: "MemoryTool",
    from: 266,
    to: 345,
    date: "2026-11-27",
    reason:
      "probe S10 regression fix: 321 to 345 on top of the prompt diet row above. The save rules (tag, not add, list with a query first) are explicit in the description and the add line",
  },
  {
    tool: "PromptList",
    from: 48,
    to: 58,
    date: "2026-11-27",
    reason:
      "the prompt diet (2026-11-27) moved the facts of the deleted system prompt block into this tool text: the prompts-catalog fragment case (DECISIONS G3 item 3)",
  },
  {
    tool: "ScheduleCronDelete",
    from: 41,
    to: 52,
    date: "2026-11-27",
    reason:
      "the prompt diet (2026-11-27) moved the facts of the deleted system prompt block into this tool text: the schedule block fact about the /loop and /schedule commands",
  },
  {
    tool: "ScheduleCronList",
    from: 32,
    to: 45,
    date: "2026-11-27",
    reason:
      "the prompt diet (2026-11-27) moved the facts of the deleted system prompt block into this tool text: the schedule block fact about the /loop and /schedule commands",
  },
  {
    tool: "Skill",
    from: 153,
    to: 208,
    date: "2026-11-27",
    reason:
      "the prompt diet (2026-11-27) moved the facts of the deleted system prompt block into this tool text: the skill rules of the skills block, and the broken skills fact (O2)",
  },
  {
    tool: "Speak",
    from: 157,
    to: 176,
    date: "2026-11-27",
    reason:
      "the prompt diet (2026-11-27) moved the facts of the deleted system prompt block into this tool text: the speak block rules",
  },
  {
    tool: "SubAgentsAgentResult",
    from: 56,
    to: 91,
    date: "2026-11-27",
    reason:
      "the prompt diet (2026-11-27) moved the facts of the deleted system prompt block into this tool text: D15, verify each deliverable file before a task is done",
  },
  {
    tool: "SubAgentsSpawnAgent",
    from: 485,
    to: 540,
    date: "2026-11-27",
    reason:
      "the prompt diet (2026-11-27) moved the facts of the deleted system prompt block into this tool text: sub-agents block, D15 (no nested sub-agent) and the worker git and gate rule",
  },
  {
    tool: "Task",
    from: 458,
    to: 495,
    date: "2026-11-27",
    reason:
      "the prompt diet (2026-11-27) moved the facts of the deleted system prompt block into this tool text: the planning and result rules of the tasks fragment",
  },
  {
    tool: "WebSearch",
    from: 211,
    to: 221,
    date: "2026-11-27",
    reason:
      "the prompt diet (2026-11-27) moved the facts of the deleted system prompt block into this tool text: the URL rule of the WebSearch block",
  },
  {
    tool: "ChromeCDP",
    from: 340,
    to: 410,
    date: "2026-11-27",
    reason:
      "merge: prompt diet + media attachments (prompt diet 340 to 390, tool attachments +20 on the `method` text)",
  },
  {
    tool: "Fetch",
    from: 396,
    to: 439,
    date: "2026-11-27",
    reason:
      "merge: prompt diet + media attachments (prompt diet 396 to 417, tool attachments +22, the image URL fact now in the `url` text)",
  },
]

/** One raise of {@link TOOL_BLOCK_WORDS}. */
export interface BlockRaise {
  from: number
  to: number
  date: string
  reason: string
}

/**
 * The raise log of {@link TOOL_BLOCK_WORDS} (REVIEW-C2 W1). The total may only
 * go above its lowest committed value with a row here. Keep old rows.
 */
export const BLOCK_RAISES: readonly BlockRaise[] = [
  {
    from: 6747,
    to: 6842,
    date: "2026-11-23",
    reason: "SessionTitle tool, ma-title-plugin (new tool, 112 words, ships in every golden)",
  },
  {
    from: 6842,
    to: 6884,
    date: "2026-11-27",
    reason:
      "tool attachments: ChromeCDP `method` text, a screenshot or PDF result comes as an image or a file (+20 words). Fetch text, an image URL comes as an image or a saved file (+22 words)",
  },
  {
    from: 6842,
    to: 7384,
    date: "2026-11-27",
    reason:
      "prompt diet: text moved from the system prompt into tool text (14 removed system blocks). plain-turn system words 2238 to 695, request bytes 72052 to 65370",
  },
  {
    from: 6842,
    to: 7408,
    date: "2026-11-27",
    reason:
      "probe S10 regression fix: 7384 to 7408 on top of the prompt diet row above (MemoryTool 321 to 345 words)",
  },
  {
    from: 6842,
    to: 7409,
    date: "2026-11-27",
    reason: "review m3 clearer security wording in Computer (695 to 696 words)",
  },
  {
    from: 6842,
    to: 7451,
    date: "2026-11-27",
    reason:
      "merge: prompt diet + media attachments (7409 from the prompt diet, +42 words of the tool attachments in ChromeCDP and Fetch)",
  },
]

/** The long-run per-tool target. Never reach it by dropping a fact or a rule. */
export const TARGET = {
  words: 250,
  owner: "Example",
  note: "Cut the tools above 250 words by hand, one tool per change, and lower its TOOL_WORDS entry with each cut.",
} as const

/**
 * The maximum length of ONE description string that ships in the tool block:
 * a tool `description` or a param `description` at any depth. Set by the
 * user (2026-11-17): a description keeps only the most important part.
 *
 * Counted in UTF-16 code units (`string.length`) of the RAW string as it
 * ships in the request, after the harness builds it, so it covers text that
 * core adds (for example the `binary` param). The count is never of masked
 * text: a code span, a URL, a path, a tag and every backtick count, because
 * the model gets each character (review C: the mutation "count the text
 * without code spans" survived, and a test now kills it).
 *
 * Every description at ANY depth is measured ({@link descriptionStrings}):
 * the tool, `properties`, nested `items`, `anyOf`, `oneOf`, `allOf`, `$defs`
 * and `additionalProperties`. The tools come from {@link shippedTools}.
 */
export const MAX_DESCRIPTION_CHARS = 500

/**
 * One tool as it ships in the tool block: its wire name, its description and
 * its `input_schema`, after the harness builds it.
 */
export interface ShippedTool {
  /** Wire tool name. */
  name: string
  /** The tool `description`, raw. */
  description: string
  /** The `input_schema`, with the core `binary` param when core adds it. */
  input_schema: unknown
  /**
   * `golden`: the text comes from {@link GOLDEN} (what the harness built).
   * `manifest`: the tool is not in the golden, so the text comes from its
   * `ma-*\/manifest.json` (see {@link shippedTools}).
   */
  source: "golden" | "manifest"
}

/** A tool with its word count. */
export interface ToolText {
  name: string
  words: number
  /** Where the text came from (see {@link ShippedTool.source}). */
  source: ShippedTool["source"]
}

/** One shipped description string with its place and length. */
export interface DescriptionText {
  /** Wire tool name. */
  tool: string
  /** `description` for the tool, or the param path, for example `input_schema.properties.action`. */
  path: string
  /** Length in UTF-16 code units of the RAW string (see {@link MAX_DESCRIPTION_CHARS}). */
  chars: number
}

/** Tools that exist only in a test fixture, so they are not shipped text. */
const FIXTURE_ONLY = new Set(["FixtureThrow"])

/**
 * The one word count of the budget: split the RAW text on whitespace.
 *
 * Every number in this file and in `scripts/tool-words.ts` comes from this
 * function. It is not the s1 count (see the module doc, bug B8).
 *
 * @param text - Raw text as it ships.
 * @returns The number of whitespace-separated tokens.
 */
export function budgetWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

/**
 * Every tool in one request golden, first occurrence of each name, in walk
 * order. A fixture-only tool is left out.
 *
 * @param path - Golden path.
 * @returns The tools, with `source: "golden"`.
 */
export function goldenTools(path: string = GOLDEN): ShippedTool[] {
  const golden = JSON.parse(readFileSync(path, "utf8")) as unknown
  const found = new Map<string, ShippedTool>()
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (!value || typeof value !== "object") return
    const node = value as Record<string, unknown>
    if (
      typeof node.name === "string" &&
      node.input_schema &&
      typeof node.description === "string" &&
      !FIXTURE_ONLY.has(node.name) &&
      !found.has(node.name)
    ) {
      found.set(node.name, {
        name: node.name,
        description: node.description,
        input_schema: node.input_schema,
        source: "golden",
      })
    }
    for (const child of Object.values(node)) walk(child)
  }
  walk(golden)
  return [...found.values()]
}

/** A manifest tool, as far as the shipped text goes. */
interface ManifestToolText {
  name?: string
  description?: unknown
  input_schema?: unknown
  mayReturnBinary?: boolean
}

/**
 * Read the `trigger.tool` block of one manifest tool.
 *
 * @param root - Plugins repo root.
 * @param plugin - Plugin directory.
 * @param tool - `trigger.tool.name` in the manifest.
 * @returns The block, or null when the manifest has no such tool.
 */
function manifestTool(root: string, plugin: string, tool: string): ManifestToolText | null {
  const manifest = JSON.parse(readFileSync(join(root, plugin, "manifest.json"), "utf8")) as {
    headless?: { tools?: Array<{ trigger?: { type?: string; tool?: ManifestToolText } }> }
    tools?: Array<{ trigger?: { type?: string; tool?: ManifestToolText } }>
  }
  const all = [...(manifest.headless?.tools ?? []), ...(manifest.tools ?? [])]
  const hit = all.find((h) => h.trigger?.type === "tool" && h.trigger.tool?.name === tool)
  return hit?.trigger?.tool ?? null
}

/**
 * The `binary` param that core adds to a tool with `mayReturnBinary` (core
 * `src/tools/binary-guard.ts` `injectBinaryOptInArg`), as the golden ships
 * it. The golden is the source because core builds the text.
 *
 * @param tools - The golden tools.
 * @returns The param schema, or null when no golden tool has it.
 */
function goldenBinaryParam(tools: readonly ShippedTool[]): unknown {
  for (const tool of tools) {
    const props = (tool.input_schema as { properties?: Record<string, unknown> }).properties
    if (props?.binary) return props.binary
  }
  return null
}

/**
 * Every tool that can ship, from two sources.
 *
 * 1. The golden ({@link GOLDEN}): the core built-ins (Bash, Read, Write,
 *    Edit, Glob, Grep, FilesStats, Mode, whose text comes from
 *    `ma-core-tools-plugin`), the core `binary` param, and every plugin tool
 *    that a default lead request has. This is the text that the harness
 *    builds, so it wins.
 * 2. Every `ma-*\/manifest.json` tool that the golden does not have (review C
 *    B3): a disabled plugin (SecurityStatus, CloudStatus, CloudLogin,
 *    CloudPush) and the worker-only SubAgentsReportResult. The wire name
 *    comes from {@link wireToolNames}; the `description` and `input_schema`
 *    come from the manifest as they are. Core sends a manifest tool as it is
 *    (the test "golden and manifest agree" proves it for every tool in both),
 *    except that it adds the `binary` param when the tool sets
 *    `mayReturnBinary`. That param is added here from the golden.
 *
 * A manifest tool with no description or no `input_schema` is not added, so
 * {@link unmeasuredTools} reports it.
 *
 * @param root - Plugins repo root.
 * @param golden - Golden path.
 * @returns The tools, sorted by name.
 */
export function shippedTools(root: string = PLUGINS_ROOT, golden: string = GOLDEN): ShippedTool[] {
  const fromGolden = goldenTools(golden)
  const out = new Map(fromGolden.map((t) => [t.name, t]))
  for (const entry of wireToolNames(root).entries) {
    if (out.has(entry.wire)) continue
    const tool = manifestTool(root, entry.plugin, entry.tool)
    if (!tool || typeof tool.description !== "string" || !tool.input_schema) continue
    let schema = tool.input_schema
    if (tool.mayReturnBinary === true) {
      const binary = goldenBinaryParam(fromGolden)
      if (binary === null) {
        throw new Error(
          `${entry.wire} sets mayReturnBinary, but no golden tool has the binary param`,
        )
      }
      const props = (schema as { properties?: Record<string, unknown> }).properties ?? {}
      if (!("binary" in props)) schema = { ...schema, properties: { ...props, binary } }
    }
    out.set(entry.wire, {
      name: entry.wire,
      description: tool.description,
      input_schema: schema,
      source: "manifest",
    })
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The tool names that can ship but are not measured: a name in `expected`
 * (every manifest wire name plus the built-ins) that is not in `tools`.
 *
 * @param tools - The measured tools.
 * @param expected - The names that must be measured.
 * @returns The missing names, sorted.
 */
export function unmeasuredTools(
  tools: readonly Pick<ShippedTool, "name">[],
  expected: Iterable<string> = wireToolNames().wire,
): string[] {
  const have = new Set(tools.map((t) => t.name))
  return [...new Set(expected)].filter((name) => !have.has(name)).sort()
}

/**
 * Every `description` string of one tool, at ANY depth: the tool description,
 * then every `description` in the `input_schema` tree, in key order. The walk
 * goes into every object and every array, so it covers `properties`, nested
 * `items`, `anyOf`, `oneOf`, `allOf`, `$defs`, `definitions` and
 * `additionalProperties`. A param NAMED `description` is an object, so the
 * walk goes into it and does not count it.
 *
 * @param tool - One shipped tool.
 * @returns `[path, raw text]` pairs.
 */
export function descriptionStrings(
  tool: Pick<ShippedTool, "description" | "input_schema">,
): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [
    { path: "description", text: tool.description },
  ]
  const walk = (value: unknown, at: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${at}[${index}]`))
      return
    }
    if (!value || typeof value !== "object") return
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "description" && typeof child === "string") {
        out.push({ path: at, text: child })
      } else {
        walk(child, `${at}.${key}`)
      }
    }
  }
  walk(tool.input_schema, "input_schema")
  return out
}

/**
 * Count the words of each tool: its description plus every nested schema
 * `description` ({@link descriptionStrings}), which is what the model gets.
 *
 * @param tools - The tools to count.
 * @returns One entry for each tool, sorted by name.
 */
export function toolWords(tools: readonly ShippedTool[] = shippedTools()): ToolText[] {
  return tools
    .map((tool) => ({
      name: tool.name,
      words: descriptionStrings(tool).reduce((sum, d) => sum + budgetWords(d.text), 0),
      source: tool.source,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The words of the block that a default lead request ships: the tools from
 * the golden. A manifest-only tool (a disabled plugin, the worker-only tool)
 * has its own {@link TOOL_WORDS} entry but is not in this total.
 *
 * @param tools - The counted tools.
 * @returns The total.
 */
export function blockWords(tools: readonly ToolText[]): number {
  return tools.filter((t) => t.source === "golden").reduce((sum, t) => sum + t.words, 0)
}

/**
 * Every description string of every shipped tool, with its RAW length.
 *
 * @param tools - The tools to measure.
 * @returns One row per description string, tool first, then params in order.
 */
export function descriptionTexts(
  tools: readonly ShippedTool[] = shippedTools(),
): DescriptionText[] {
  return tools.flatMap((tool) =>
    descriptionStrings(tool).map((d) => ({ tool: tool.name, path: d.path, chars: d.text.length })),
  )
}

/**
 * Read the {@link TOOL_WORDS} record out of a `tool-budget.ts` source, for an
 * older version from git. Returns null when the source has no such record (a
 * merge base from before the per-tool map).
 *
 * @param source - The text of a `tool-budget.ts`.
 * @returns The record, or null.
 */
export function parseToolWords(source: string): Record<string, number> | null {
  const match = /export const TOOL_WORDS[^=]*=\s*\{([^}]*)\}/.exec(source)
  if (!match) return null
  const out: Record<string, number> = {}
  for (const entry of (match[1] ?? "").matchAll(/["']?([A-Za-z]\w*)["']?\s*:\s*(\d+)/g)) {
    out[entry[1] ?? ""] = Number(entry[2])
  }
  return out
}

/**
 * Read {@link TOOL_BLOCK_WORDS} out of a `tool-budget.ts` source.
 *
 * @param source - The text of a `tool-budget.ts`.
 * @returns The number, or null when the source has none.
 */
export function parseBlockWords(source: string): number | null {
  const match = /export const TOOL_BLOCK_WORDS\s*=\s*(\d+)/.exec(source)
  return match ? Number(match[1]) : null
}

/** The lowest committed budget: per tool and for the whole block. */
export interface BudgetFloor {
  perTool: Record<string, number>
  block: number | null
}

/**
 * The lowest value of each {@link TOOL_WORDS} entry and of
 * {@link TOOL_BLOCK_WORDS} over committed copies of `tool-budget.ts`
 * (REVIEW-C2 W1). The merge base before the first landing has no map, so the
 * floor comes from HEAD, the pushed branch and each branch commit that
 * changed the file. A source with no map is skipped.
 *
 * @param sources - The file text at each committed ref.
 * @returns The floor.
 */
export function budgetFloor(sources: readonly string[]): BudgetFloor {
  const perTool: Record<string, number> = {}
  let block: number | null = null
  for (const source of sources) {
    const words = parseToolWords(source)
    if (words) {
      for (const [tool, n] of Object.entries(words)) {
        perTool[tool] = Math.min(perTool[tool] ?? n, n)
      }
    }
    const total = parseBlockWords(source)
    if (total !== null) block = block === null ? total : Math.min(block, total)
  }
  return { perTool, block }
}

/**
 * The entries above their floor that no {@link RAISES} row covers. A row
 * covers a raise when it names the tool, starts at or below the floor and
 * ends at or above today's entry. A tool with no floor (new) is not a raise.
 *
 * @param current - Today's entries.
 * @param base - The floor (or the entries at the merge base).
 * @param raises - The raise log.
 * @returns One line for each raise without a row.
 */
export function unloggedRaises(
  current: Readonly<Record<string, number>>,
  base: Readonly<Record<string, number>>,
  raises: readonly Raise[],
): string[] {
  const out: string[] = []
  for (const [tool, to] of Object.entries(current)) {
    const from = base[tool]
    if (from === undefined || to <= from) continue
    const logged = raises.some(
      (r) => r.tool === tool && r.from <= from && r.to >= to && r.reason.trim().length >= 10,
    )
    if (!logged) out.push(`${tool}: ${from} -> ${to} has no RAISES row with a reason`)
  }
  return out
}
