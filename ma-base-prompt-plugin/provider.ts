/**
 * Base prompt provider. Reads the data files lazily (first call) and trims them.
 *
 * The default provider gets the data files through `with { type: "text" }`
 * imports, so Bun inlines the text and the same code works from the checkout
 * and from a compiled binary (see `tests/embed-safety.test.ts`).
 */

import type { SystemPromptBaseProvider } from "@minimal-agent/core/plugin-api/types/plugin"

import identityNeutralMd from "./prompts/identity.neutral.md" with { type: "text" }
import instructionsMd from "./prompts/instructions.md" with { type: "text" }

/** Returns the raw text of one data file of `prompts/`, by file name. */
export type BaseTextReader = (name: string) => string

/** The data files of this plugin, by file name. */
const TEXTS: Readonly<Record<string, string>> = {
  "identity.neutral.md": identityNeutralMd,
  "instructions.md": instructionsMd,
}

/** Reader over the text imports of this plugin. */
const textImportReader: BaseTextReader = (name) => {
  const text = TEXTS[name]
  if (text === undefined) throw new Error(`ma-base-prompt-plugin: no data file ${name}`)
  return text
}

/** Make a provider that reads `identity.neutral.md` and `instructions.md` through `readText`. */
export function createBaseProvider(readText: BaseTextReader): SystemPromptBaseProvider {
  let identity: string | undefined
  let instructions: string | undefined
  const read = (name: string) => readText(name).trim()
  return {
    identity() {
      identity ??= read("identity.neutral.md")
      return identity
    },
    instructionParts() {
      instructions ??= read("instructions.md")
      return [{ slot: "instructions", text: instructions }]
    },
  }
}

/** The provider factory core calls. Reads the data files of the text imports. */
export default function createProvider(): SystemPromptBaseProvider {
  return createBaseProvider(textImportReader)
}
