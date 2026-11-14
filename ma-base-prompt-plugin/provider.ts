/**
 * Base prompt provider. Reads the data files lazily (first call) and trims them.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { SystemPromptBaseProvider } from "@minimal-agent/core/plugin-api/types/plugin"

/** Make a provider that reads `identity.neutral.md` and `instructions.md` from `<dir>/prompts`. */
export function createBaseProvider(dir: string): SystemPromptBaseProvider {
  let identity: string | undefined
  let instructions: string | undefined
  const read = (name: string) => readFileSync(join(dir, "prompts", name), "utf-8").trim()
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

/** The provider factory core calls. Reads the data files next to this module. */
export default function createProvider(): SystemPromptBaseProvider {
  return createBaseProvider(import.meta.dir)
}
