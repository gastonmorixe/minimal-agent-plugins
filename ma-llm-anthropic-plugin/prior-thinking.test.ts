/**
 * Per-model thinking-history policy (F2): which Claude models keep the
 * thinking of all prior turns. Source: Anthropic "Thinking block preservation
 * by model" (Opus 4.5+, Sonnet 4.6+, Haiku 5.5, Fable 5.2, Mythos keep all;
 * older Opus/Sonnet and Haiku through 4.5 keep only the turn in progress).
 */

import { describe, expect, test } from "bun:test"

import type { ModelEntry } from "./lib/host-types.ts"
import { registerAnthropicAdHocModelInto, registerAnthropicModels } from "./models.ts"

function catalog(): Map<string, ModelEntry> {
  const out = new Map<string, ModelEntry>()
  registerAnthropicModels({
    register: (spec) => out.set(spec.id, spec as unknown as ModelEntry),
    setDefault: () => {},
  })
  return out
}

describe("capabilities.priorThinking", () => {
  const models = catalog()
  const policy = (id: string) => models.get(id)?.capabilities.priorThinking

  test("keep-all models", () => {
    for (const id of [
      "claude-opus-5-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-opus-4-5-20251101",
      "claude-sonnet-5-5",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-haiku-5-5",
      "claude-fable-5-2",
    ]) {
      expect([id, policy(id)]).toEqual([id, "keep-all"])
    }
  })

  test("last-turn-only models keep today's strip", () => {
    for (const id of ["claude-haiku-4-5-20251001", "claude-fable-5", "claude-fable-5-1"]) {
      expect([id, policy(id)]).toEqual([id, "last-turn-only"])
    }
  })

  test("every catalog model declares a policy", () => {
    const missing = [...models.values()].filter((m) => m.capabilities.priorThinking === undefined)
    expect(missing.map((m) => m.id)).toEqual([])
  })

  test("an ad-hoc Mythos id is keep-all, an ad-hoc Fable id is not", () => {
    const seen = new Map<string, ModelEntry>()
    const registrar = {
      register: (spec: unknown) => {
        const e = spec as ModelEntry
        seen.set(e.id, e)
      },
      setDefault: () => {},
    }
    registerAnthropicAdHocModelInto(registrar as never, "claude-mythos-9-9")
    registerAnthropicAdHocModelInto(registrar as never, "claude-fable-9-9")
    expect(seen.get("claude-mythos-9-9")?.capabilities.priorThinking).toBe("keep-all")
    expect(seen.get("claude-fable-9-9")?.capabilities.priorThinking).toBe("last-turn-only")
  })
})
