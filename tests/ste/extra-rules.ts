/**
 * Extra rules that `scripts/ste-check.ts` and the corpus tests load.
 *
 * The default export gets one surface text (masked and raw, the same length)
 * and gives the findings of each extra rule:
 *
 * - s20, wire tool names (`tool-names.ts`)
 * - s19, the approved-word dictionary (`dictionary.ts`, ASD-STE100 rule 1.1),
 *   for the prose words and for the one-word code spans that read as a word
 *
 * The tool-name index and the dictionary are built once, when the module
 * loads. Wire tool names are also technical nouns for the dictionary, so a
 * description can name a tool without a dictionary finding.
 *
 * @module tests/ste/extra-rules
 */

import {
  defaultAutoTechNouns,
  dictionaryFindings,
  loadDictionary,
  spanWordFindings,
} from "./dictionary.ts"
import { loadPosIndex, posFindings } from "./pos-rules.ts"
import type { ExtraFindings, ExtraFindingsArgs, SteFinding } from "./ste-rules.ts"
import {
  handlerMessageFindings,
  S20_RULE,
  type ToolNames,
  toolNameFindings,
  toolNameMessage,
  wireToolNames,
} from "./tool-names.ts"

/** The wire-name index, built once. */
const INDEX = wireToolNames()

/** The part-of-speech index for s23, built once. */
const POS_INDEX = loadPosIndex()

/** The dictionary, built once. Wire names and aliases pass as technical nouns. */
const DICTIONARY = loadDictionary({
  autoTechNouns: [...defaultAutoTechNouns(), ...INDEX.wire, ...INDEX.aliasToWire.keys()],
})

/**
 * Every extra finding for one surface text.
 *
 * @param args - The text, its mask, its line offset, file and role.
 * @returns The findings: s20 first, then s19.
 */
const extraRules: ExtraFindings = (args: ExtraFindingsArgs): SteFinding[] => [
  ...toolNameFindings(args, INDEX),
  ...[
    ...dictionaryFindings(args.masked, args.raw, args.lineOffset, args.file, args.role, DICTIONARY),
    ...spanWordFindings(args.masked, args.raw, args.lineOffset, args.file, args.role, DICTIONARY),
    ...posFindings(args, POS_INDEX),
  ].sort((a, b) => (a.offset ?? 0) - (b.offset ?? 0)),
]

export default extraRules

/** The dictionary that the extra rules use, for tests and scripts. */
export const dictionary = DICTIONARY

/** The wire-name index that the extra rules use, for tests and scripts. */
export const toolNameIndex = INDEX

/** The dictionary verb test, for the instruction classifier (R3 B11). */
export const isVerb = (word: string): boolean => DICTIONARY.isVerb(word)

/** One file with its s20 handler-message findings. Same shape as `ratchet.ts` `FileReport`. */
export interface HandlerReport {
  file: string
  findings: SteFinding[]
}

/**
 * s20 over the string literals of plugin handler and lib code
 * (`handlerMessageFindings`), as file reports that the gate can merge with the
 * surface reports. These strings reach the model in a `tool_result`, so every
 * finding has role `tool` and severity `error`: `isZeroTolerance` is true for
 * each one, and `zeroToleranceRegressions` turns each file into a regression.
 *
 * `scripts/ste-check.ts` calls this once and appends the result to the
 * reports of the gate (and of `--strict` and `--dir`).
 *
 * @param root - Plugins repo root. Default: this repo. A `--dir` tree passes its own root.
 * @param index - Wire-name index. Default: the index of this repo, the same
 *   one that the surface rules use.
 * @returns One report per file with a finding, sorted by file.
 */
export function handlerMessageReports(root?: string, index: ToolNames = INDEX): HandlerReport[] {
  const rows = handlerMessageFindings(root, index)
  const byFile = new Map<string, SteFinding[]>()
  for (const row of rows) {
    const list = byFile.get(row.file) ?? []
    list.push({
      rule: S20_RULE,
      message: `${toolNameMessage(row.name, row.wire)} (handler message: ${row.context})`,
      snippet: row.name,
      line: row.line,
      severity: "error",
      role: "tool",
    })
    byFile.set(row.file, list)
  }
  return [...byFile.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([file, findings]) => ({ file, findings }))
}
