import { describe, expect, it } from "bun:test"

import type { StartupProfile } from "./host-types.ts"
import {
  hasProviderSpecificParts,
  inheritEnabled,
  inheritSummary,
  needsProviderDerive,
  stripProviderSpecific,
} from "./inherit-summary.ts"

const BASE: StartupProfile = {
  version: 1,
  systemPrompt: {},
  noAgentsMd: false,
  pluginPrompts: { all: false, suppress: [], keep: [] },
  plugins: { disable: [], enable: [] },
  bare: false,
  tools: { kind: "all" },
}

describe("inheritEnabled (SPEC R11)", () => {
  it("is on by default and off only for exactly 0", () => {
    expect(inheritEnabled({})).toBe(true)
    expect(inheritEnabled({ MINIMAL_AGENT_SUBAGENT_INHERIT: "1" })).toBe(true)
    expect(inheritEnabled({ MINIMAL_AGENT_SUBAGENT_INHERIT: "0" })).toBe(false)
  })
})

describe("inheritSummary (SPEC R12)", () => {
  it("renders the SPEC example", () => {
    const profile: StartupProfile = {
      ...BASE,
      systemPrompt: {
        instructions: { kind: "omit" },
        sessionContext: { kind: "omit" },
      },
      noAgentsMd: true,
      pluginPrompts: { all: true, suppress: [], keep: [] },
      tools: { kind: "list", names: ["Read"] },
    }
    expect(inheritSummary({ state: "on", profile, leadTools: profile.tools, mode: "ask" })).toBe(
      "inherit: sys(-instr,-ctx) agents-md:off plugin-prompts:off tools:lead mode:ask",
    )
  })

  it("shows replaced parts, plugin lists, bare, and role tools", () => {
    const profile: StartupProfile = {
      ...BASE,
      systemPrompt: { identity: { kind: "replace", text: "x" }, unsafeProviderOverrides: true },
      pluginPrompts: { all: false, suppress: ["tasks"], keep: [] },
      plugins: { disable: ["foo"], enable: ["bar"] },
      bare: true,
    }
    expect(
      inheritSummary({
        state: "on",
        profile,
        leadTools: { kind: "all" },
        mode: "none",
      }),
    ).toBe(
      "inherit: sys(~id,!unsafe) plugin-prompts:-tasks plugins(-foo,+bar) bare tools:all mode:none",
    )
  })

  it("marks profile off, absent, and lead --no-tools", () => {
    expect(inheritSummary({ state: "off", leadTools: { kind: "none" }, mode: "ask" })).toBe(
      "inherit: profile:off tools:none mode:ask",
    )
    expect(inheritSummary({ state: "absent", mode: "none" })).toBe(
      "inherit: profile:none tools:all mode:none",
    )
  })
})

describe("provider-specific parts (SPEC 6.4)", () => {
  const withPre: StartupProfile = {
    ...BASE,
    systemPrompt: {
      providerPreamble: { kind: "replace", text: "P" },
      instructions: { kind: "omit" },
      unsafeProviderOverrides: true,
    },
  }

  it("detects provider parts", () => {
    expect(hasProviderSpecificParts(BASE)).toBe(false)
    expect(hasProviderSpecificParts(withPre)).toBe(true)
    expect(
      hasProviderSpecificParts({
        ...BASE,
        systemPrompt: { providerPreamble: { kind: "default" } },
      }),
    ).toBe(false)
  })

  it("strips providerPreamble and the unsafe override, keeps the rest", () => {
    const out = stripProviderSpecific(withPre)
    expect(out.systemPrompt).toEqual({ instructions: { kind: "omit" } })
    expect(withPre.systemPrompt.providerPreamble).toBeDefined()
  })

  it("keeps the lead prompt-cache flags in the derived profile (M3)", () => {
    const out = stripProviderSpecific({ ...withPre, cacheAnchor: true, thinkingHistory: "keep" })
    expect(out.cacheAnchor).toBe(true)
    expect(out.thinkingHistory).toBe("keep")
    // An older profile without the fields: the derived copy has none either.
    const old = stripProviderSpecific(withPre)
    expect("cacheAnchor" in old).toBe(false)
    expect("thinkingHistory" in old).toBe(false)
  })

  it("derives only when both providers are known and differ", () => {
    expect(needsProviderDerive(withPre, "anthropic", "openai")).toBe(true)
    expect(needsProviderDerive(withPre, "anthropic", "anthropic")).toBe(false)
    expect(needsProviderDerive(withPre, undefined, "openai")).toBe(false)
    expect(needsProviderDerive(BASE, "anthropic", "openai")).toBe(false)
  })
})
