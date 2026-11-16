import { describe, expect, it } from "bun:test"

import { anthropicProviderPlugin } from "./adapter.ts"
import { useTempAgentHome } from "./test-home.ts"

useTempAgentHome()

describe("anthropic modelShortLabel", () => {
  const label = (id: string) => anthropicProviderPlugin.modelShortLabel?.(id)

  it("shows the family name, not the provider tag", () => {
    expect(label("claude-opus-5-5")).toBe("opus-5.5")
    expect(label("claude-sonnet-5-5")).toBe("sonnet-5.5")
    expect(label("claude-haiku-5-5")).toBe("haiku-5.5")
    expect(label("claude-opus-4-8")).toBe("opus-4.8")
    expect(label("claude-fable-5")).toBe("fable-5")
  })

  it("ignores context suffixes and date stamps", () => {
    expect(label("claude-opus-5-5[1m]")).toBe("opus-5.5")
    expect(label("claude-haiku-4-5-20251001")).toBe("haiku-4.5")
    expect(label("claude-opus-4-20250514")).toBe("opus-4")
  })

  it("returns undefined for ids outside the Claude scheme", () => {
    expect(label("gpt-5.5")).toBeUndefined()
    expect(label("claude-instant")).toBeUndefined()
  })
})
