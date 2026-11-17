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

/** The widest golden: the built-in tools plus the plugin fixture tools. */
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
 */
export const TOOL_BLOCK_WORDS = 8163

/** How far below {@link TOOL_BLOCK_WORDS} the tree may drift before it must be lowered. */
export const LOOSE_WORDS = 50

/**
 * The words of each shipped tool (description plus every nested schema
 * `description`), measured 2026-11-17 from the golden with {@link budgetWords}.
 *
 * This is a ratchet, not a target. After a cut, lower the entry (the test
 * fails when an entry is more than {@link PER_TOOL_LOOSE} above the tool).
 * To raise an entry, add a {@link RAISES} row with the reason. A new tool gets
 * an entry equal to its measured words. `bun run scripts/tool-words.ts`
 * prints the table.
 */
export const TOOL_WORDS: Readonly<Record<string, number>> = {
  BackgroundLogs: 127,
  BackgroundRun: 184,
  BackgroundStatus: 60,
  BackgroundStop: 89,
  Bash: 386,
  ChromeCDP: 414,
  CompactContext: 168,
  Computer: 751,
  DiffViewerShowDiff: 91,
  Edit: 25,
  Fetch: 406,
  FilesStats: 85,
  Glob: 178,
  Grep: 222,
  IntercomInbox: 74,
  IntercomPeers: 141,
  IntercomSend: 180,
  LockStatus: 175,
  MemoryTool: 267,
  Mode: 156,
  ModelInfo: 127,
  PromptDelete: 53,
  PromptEdit: 73,
  PromptList: 48,
  PromptNew: 112,
  PromptShow: 54,
  Read: 287,
  ScheduleCronCreate: 214,
  ScheduleCronDelete: 55,
  ScheduleCronList: 45,
  ScheduleCronReschedule: 90,
  SessionHistory: 340,
  SessionInfo: 122,
  Skill: 158,
  Speak: 173,
  SpeakStatus: 67,
  SpeakStop: 70,
  SubAgentsAgentOutput: 64,
  SubAgentsAgentResult: 66,
  SubAgentsAgentStatus: 70,
  SubAgentsListAgents: 60,
  SubAgentsMailbox: 120,
  SubAgentsSpawnAgent: 592,
  SubAgentsStopAgent: 84,
  Task: 562,
  WebSearch: 224,
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
export const RAISES: readonly Raise[] = []

/** The long-run per-tool target. Never reach it by dropping a fact or a rule. */
export const TARGET = {
  words: 250,
  owner: "Alex",
  note: "Cut the tools above 250 words by hand, one tool per change, and lower its TOOL_WORDS entry with each cut.",
} as const

/** Tools that exist only in a test fixture, so they are not shipped text. */
const FIXTURE_ONLY = new Set(["FixtureThrow"])

/** A tool with its word count. */
export interface ToolText {
  name: string
  words: number
}

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
 * Read one golden and count the words of each tool block.
 *
 * The count covers the tool `description` and every nested `description` in
 * its `input_schema`, which is what the model receives.
 *
 * @param path - Golden path.
 * @returns One entry for each shipped tool, sorted by name.
 */
export function toolWords(path: string = GOLDEN): ToolText[] {
  const golden = JSON.parse(readFileSync(path, "utf8")) as unknown
  const found = new Map<string, number>()

  const count = (value: unknown): number => {
    if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + count(item), 0)
    if (!value || typeof value !== "object") return 0
    let words = 0
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "description" && typeof child === "string") {
        words += budgetWords(child)
      } else {
        words += count(child)
      }
    }
    return words
  }

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
      typeof node.description === "string"
    ) {
      if (!FIXTURE_ONLY.has(node.name)) {
        // `count` sums `description` words in a tree; a bare string has no
        // `description` key, so the tool description is counted directly.
        const own = budgetWords(node.description)
        const total = own + count(node.input_schema)
        found.set(node.name, Math.max(found.get(node.name) ?? 0, total))
      }
    }
    for (const child of Object.values(node)) walk(child)
  }

  walk(golden)
  return [...found.entries()]
    .map(([name, words]) => ({ name, words }))
    .sort((a, b) => a.name.localeCompare(b.name))
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
 * The entries that grew since the base and have no matching {@link RAISES}
 * row. A tool that is new since the base is not a raise.
 *
 * @param current - Today's entries.
 * @param base - The entries at the merge base.
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
      (r) => r.tool === tool && r.from === from && r.to === to && r.reason.trim().length >= 10,
    )
    if (!logged) out.push(`${tool}: ${from} -> ${to} has no RAISES row with a reason`)
  }
  return out
}
