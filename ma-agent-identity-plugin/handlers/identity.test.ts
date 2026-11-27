import { describe, expect, it } from "bun:test"

import identityFragment, { renderIdentity } from "./identity.ts"

const ctx = (name?: string): { env: Record<string, string> } => ({
  env: name === undefined ? {} : { MINIMAL_AGENT_AGENT_NAME: name },
})

describe("identity fragment", () => {
  it("renders the name into the prompts/identity.md line", () => {
    expect(identityFragment(ctx(" Laura "))).toBe(
      "Your name in this session is Laura. Use this name when a person speaks to you.",
    )
  })

  it("gives nothing when the name is unset or blank", () => {
    expect(identityFragment(ctx())).toBe("")
    expect(identityFragment(ctx("   "))).toBe("")
  })

  it("keeps a name with replace patterns or template marks as is", () => {
    expect(renderIdentity("$& %%name%%")).toBe(
      "Your name in this session is $& %%name%%. Use this name when a person speaks to you.",
    )
  })
})
