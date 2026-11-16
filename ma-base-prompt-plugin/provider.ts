/**
 * Base prompt provider. Owns the identity and the 3 system slots
 * (instructions, loopSafety, toolOutputConventions). Reads the data files
 * lazily (first use), trims them, keeps the raw text, and renders each slot
 * from the facts ctx at each call.
 *
 * The default provider gets the data files through `with { type: "text" }`
 * imports, so Bun inlines the text and the same code works from the checkout
 * and from a compiled binary (see `tests/embed-safety.test.ts`).
 */

import type {
  SystemPromptBaseProvider,
  SystemPromptPart,
  SystemPromptPartsContext,
  SystemPromptSlot,
} from "@minimal-agent/core/plugin-api/types/plugin"

import identityNeutralMd from "./prompts/identity.neutral.md" with { type: "text" }
import instructionsMd from "./prompts/instructions.md" with { type: "text" }
import loopAckMd from "./prompts/loop-safety/ack.md" with { type: "text" }
import loopCooldownMd from "./prompts/loop-safety/checkpoint-cooldown.tmpl.md" with { type: "text" }
import loopPlainMd from "./prompts/loop-safety/checkpoint-plain.tmpl.md" with { type: "text" }
import loopHeadingMd from "./prompts/loop-safety/heading.md" with { type: "text" }
import loopIntroMd from "./prompts/loop-safety/intro.md" with { type: "text" }
import toolOutputConventionsMd from "./prompts/tool-output-conventions.md" with { type: "text" }

/** Returns the raw text of one data file of `prompts/`, by path under `prompts/`. */
export type BaseTextReader = (name: string) => string

/** The data files of this plugin, by path under `prompts/`. */
const TEXTS: Readonly<Record<string, string>> = {
  "identity.neutral.md": identityNeutralMd,
  "instructions.md": instructionsMd,
  "loop-safety/ack.md": loopAckMd,
  "loop-safety/checkpoint-cooldown.tmpl.md": loopCooldownMd,
  "loop-safety/checkpoint-plain.tmpl.md": loopPlainMd,
  "loop-safety/heading.md": loopHeadingMd,
  "loop-safety/intro.md": loopIntroMd,
  "tool-output-conventions.md": toolOutputConventionsMd,
}

/** The slots this provider owns. */
const SLOTS: readonly SystemPromptSlot[] = ["instructions", "loopSafety", "toolOutputConventions"]

/** Reader over the text imports of this plugin. */
const textImportReader: BaseTextReader = (name) => {
  const text = TEXTS[name]
  if (text === undefined) throw new Error(`ma-base-prompt-plugin: no data file ${name}`)
  return text
}

/**
 * Replace each `%%name%%` with `vars[name]`. A name with no value throws, so a
 * template typo cannot reach the model.
 */
export function fill(text: string, vars: Readonly<Record<string, string | number>>): string {
  return text.replace(/%%([A-Za-z0-9_.-]+)%%/g, (_full, name: string) => {
    const value = vars[name]
    if (value === undefined) throw new Error(`ma-base-prompt-plugin: no value for %%${name}%%`)
    return String(value)
  })
}

/** Make a provider that reads the data files of `prompts/` through `readText`. */
export function createBaseProvider(readText: BaseTextReader): SystemPromptBaseProvider {
  const cache = new Map<string, string>()
  const read = (name: string): string => {
    let text = cache.get(name)
    if (text === undefined) {
      text = readText(name).trim()
      cache.set(name, text)
    }
    return text
  }

  /** Same join as core buildLoopSafetyParagraph. "" when the interval is 0. */
  const loopSafety = (interval: number, cooldownMs: number): string => {
    if (!(interval > 0)) return ""
    const checkpoint =
      cooldownMs > 0
        ? fill(read("loop-safety/checkpoint-cooldown.tmpl.md"), {
            interval,
            cooldownSec: Math.round(cooldownMs / 1000),
          })
        : fill(read("loop-safety/checkpoint-plain.tmpl.md"), { interval })
    return [
      read("loop-safety/heading.md"),
      "",
      read("loop-safety/intro.md"),
      "",
      checkpoint,
      "",
      read("loop-safety/ack.md"),
    ].join("\n")
  }

  return {
    slots: SLOTS,
    identity() {
      return read("identity.neutral.md")
    },
    instructionParts(ctx?: SystemPromptPartsContext): SystemPromptPart[] {
      // No ctx (old callers): the instructions template, as before.
      if (ctx === undefined) return [{ slot: "instructions", text: read("instructions.md") }]
      const parts: SystemPromptPart[] = [
        { slot: "instructions", text: fill(read("instructions.md"), { agentHome: ctx.agentHome }) },
      ]
      const loop = loopSafety(ctx.reflectionInterval, ctx.reflectionCooldownMs)
      if (loop.length > 0) parts.push({ slot: "loopSafety", text: loop })
      if (ctx.blobStoreEnabled) {
        parts.push({ slot: "toolOutputConventions", text: read("tool-output-conventions.md") })
      }
      return parts
    },
  }
}

/** The provider factory core calls. Reads the data files of the text imports. */
export default function createProvider(): SystemPromptBaseProvider {
  return createBaseProvider(textImportReader)
}
