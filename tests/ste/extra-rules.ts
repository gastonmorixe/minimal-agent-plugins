/**
 * Extra rules that `scripts/ste-check.ts` and the corpus tests load.
 *
 * The default export gets one surface text (masked and raw, the same length)
 * and gives the findings of each extra rule:
 *
 * - s20, wire tool names (`tool-names.ts`)
 * - s19, the approved-word dictionary (`dictionary.ts`, ASD-STE100 rule 1.1)
 *
 * The tool-name index and the dictionary are built once, when the module
 * loads. Wire tool names are also technical nouns for the dictionary, so a
 * description can name a tool without a dictionary finding.
 *
 * @module tests/ste/extra-rules
 */

import { defaultAutoTechNouns, dictionaryFindings, loadDictionary } from "./dictionary.ts"
import type { ExtraFindings, ExtraFindingsArgs, SteFinding } from "./ste-rules.ts"
import { toolNameFindings, wireToolNames } from "./tool-names.ts"

/** The wire-name index, built once. */
const INDEX = wireToolNames()

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
  ...dictionaryFindings(args.masked, args.raw, args.lineOffset, args.file, args.role, DICTIONARY),
]

export default extraRules

/** The dictionary that the extra rules use, for tests and scripts. */
export const dictionary = DICTIONARY

/** The wire-name index that the extra rules use, for tests and scripts. */
export const toolNameIndex = INDEX

/** The dictionary verb test, for the instruction classifier (R3 B11). */
export const isVerb = (word: string): boolean => DICTIONARY.isVerb(word)
