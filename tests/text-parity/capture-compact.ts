/**
 * One-off capture of the core compaction text for fixtures/compact.json (15d.0).
 *
 * HISTORY ONLY. This script imports
 * `minimal-agent-core/src/agent/context-compact.ts`. Core removes
 * `buildLocalSummarySystemPrompt` and the checkpoint prose when the text moves
 * to ma-compact-plugin (15d.3b). It was run once, before that move, to lock
 * the bytes. It is kept only to show how the fixture was made. It will not run
 * once the core functions are gone.
 *
 * Run (from minimal-agent-plugins): bun run tests/text-parity/capture-compact.ts --force &&
 *   bunx biome format --write tests/text-parity/fixtures/compact.json
 *
 * The script refuses to overwrite an existing fixture unless `--force` is
 * given (15d0b), so a re-run while the text is moving cannot silently move
 * the baseline. The core path assumes this monorepo layout
 * (`<repo>/minimal-agent-core` next to `<repo>/minimal-agent-plugins`).
 *
 * Each case stores the call args, the facts the proposed kind gets, the full
 * checkpoint text (marker line included) where one exists, and `text`: the
 * part after the marker line, which is what the plugin kind must return.
 */

import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const HERE = import.meta.dir
const REPO_ROOT = join(HERE, "..", "..", "..")
const FILE = "src/agent/context-compact.ts"

// A computed path, so the typecheck does not need the core file to exist.
const corePath = join(REPO_ROOT, "minimal-agent-core", FILE)
const OUT = join(HERE, "fixtures", "compact.json")

// Guard before the core import, so a refused run has no side effects.
if (existsSync(OUT) && !process.argv.includes("--force")) {
  console.error(`refusing to overwrite ${OUT}. Re-run with --force to replace the baseline.`)
  process.exit(1)
}

interface Msg {
  role: "user" | "assistant"
  content: Array<{ type: "text"; text: string }>
}

const core = (await import(corePath)) as {
  COMPACTION_USER_MARKER: string
  buildLocalSummarySystemPrompt: (focus?: string) => string
  buildTailCompactMessages: (previous: Msg[], keepTail?: number) => Msg[]
  buildLocalCompactMessages: (opts: {
    previous: Msg[]
    summaryText?: string
    keepTail?: number
    focus?: string
  }) => Msg[]
}

const msg = (role: Msg["role"], text: string): Msg => ({ role, content: [{ type: "text", text }] })
const previous: Msg[] = [msg("user", "q1"), msg("assistant", "a1")]

const firstText = (messages: Msg[]): string => messages[0]?.content[0]?.text ?? ""

/** Split the checkpoint into the marker line and the body after it. */
function splitMarker(full: string, kind: "tail" | "local"): string {
  const line = `${core.COMPACTION_USER_MARKER} kind="${kind}" />\n`
  if (!full.startsWith(line)) throw new Error(`checkpoint does not start with ${line}`)
  return full.slice(line.length)
}

const focusArgs: Array<string | undefined> = [undefined, "keep the API stable", "  padded  ", "   "]
const summaryCases = focusArgs.map((focus) => {
  const trimmed = focus?.trim()
  return {
    args: focus === undefined ? [] : [focus],
    facts: trimmed ? { focus: trimmed } : {},
    text: core.buildLocalSummarySystemPrompt(focus),
  }
})

const tailCases = [0, 1, 2].map((keepTail) => {
  const out = core.buildTailCompactMessages(previous, keepTail)
  const full = firstText(out)
  return {
    args: { previousLength: previous.length, keepTail },
    facts: { retained: out.length - 1 },
    fullText: full,
    text: splitMarker(full, "tail"),
  }
})

const localOpts: Array<{ name: string; summaryText?: string; focus?: string }> = [
  { name: "stub" },
  { name: "stub+focus", focus: "keep the API stable" },
  { name: "summary", summaryText: "SUMMARY-BODY" },
  { name: "summary+focus", summaryText: "SUMMARY-BODY", focus: "keep the API stable" },
  { name: "summary-whitespace", summaryText: "\n  SUMMARY-BODY  \n", focus: "  padded  " },
]
const localCases = localOpts.map(({ name, summaryText, focus }) => {
  const full = firstText(
    core.buildLocalCompactMessages({
      previous,
      keepTail: 2,
      ...(summaryText === undefined ? {} : { summaryText }),
      ...(focus === undefined ? {} : { focus }),
    }),
  )
  const f = focus?.trim()
  const s = summaryText?.trim()
  return {
    name,
    args: {
      ...(summaryText === undefined ? {} : { summaryText }),
      ...(focus === undefined ? {} : { focus }),
    },
    facts: { ...(f ? { focus: f } : {}), ...(s ? { summary: s } : {}) },
    fullText: full,
    text: splitMarker(full, "local"),
  }
})

const fixture = {
  source: `minimal-agent-core/${FILE}`,
  marker: core.COMPACTION_USER_MARKER,
  entries: [
    {
      fn: "buildLocalSummarySystemPrompt",
      file: FILE,
      proposedKind: "compact.summary_system",
      cases: summaryCases,
    },
    {
      fn: "buildTailCompactMessages",
      file: FILE,
      proposedKind: "compact.tail_checkpoint",
      cases: tailCases,
    },
    {
      fn: "buildLocalCompactMessages",
      file: FILE,
      proposedKind: "compact.local_checkpoint",
      cases: localCases,
    },
  ],
}

writeFileSync(OUT, `${JSON.stringify(fixture, null, 2)}\n`)
console.log(`wrote ${OUT}`)
