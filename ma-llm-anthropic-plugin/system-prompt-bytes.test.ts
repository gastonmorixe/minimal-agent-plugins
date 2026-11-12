/**
 * Byte fixtures for the Anthropic OAuth system-prompt path (billing block).
 *
 * Fixtures in `__fixtures__/` were captured from the code before the E3
 * change. They are `.txt` on purpose: biome reformats `.json` fixtures.
 *
 * MASK: VERSION and BUILD_HASH change at each release. Before comparing, the
 * real `VERSION.BUILD_HASH` pair is replaced by `<VERSION>.<BUILD_HASH>`. Each
 * test asserts the masked text contains those placeholders, so the mask cannot
 * hide a missing billing block.
 *
 * @module llm/providers/anthropic/system-prompt-bytes.test
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { buildBillingHeaderText, resolveAnthropicSystemPrompt } from "./system-prompt.ts"
import { BUILD_HASH, VERSION } from "./wire-constants.ts"

type Ctx = Parameters<typeof resolveAnthropicSystemPrompt>[0]

const FIXTURES = join(import.meta.dir, "__fixtures__")
const NEUTRAL_IDENTITY = "You are Minimal Agent, an interactive CLI agent."
const BILLING_PREFIX = "x-anthropic-billing-header: cc_version=<VERSION>.<BUILD_HASH>;"

const body: Ctx["body"] = [
  {
    type: "text",
    text: "INSTRUCTIONS",
    cache_control: { type: "ephemeral", ttl: "1h", scope: "global" },
  },
  { type: "text", text: "SESSION CONTEXT" },
]

function mask(text: string): string {
  return text.split(`${VERSION}.${BUILD_HASH}`).join("<VERSION>.<BUILD_HASH>")
}

function fixture(name: string): Buffer {
  return readFileSync(join(FIXTURES, name))
}

function serialize(blocks: unknown): Buffer {
  return Buffer.from(mask(JSON.stringify(blocks, null, 2)), "utf8")
}

const base: Ctx = {
  identity: NEUTRAL_IDENTITY,
  body,
  authKind: "oauth",
  modelId: "claude-opus-4-7",
}

describe("anthropic system prompt bytes", () => {
  it("billing header text alone", () => {
    const got = Buffer.from(mask(buildBillingHeaderText()), "utf8")
    expect(got.length).toBeGreaterThan(0)
    expect(got.toString("utf8")).toContain("<VERSION>.<BUILD_HASH>")
    expect(got.equals(fixture("billing-header.txt"))).toBe(true)
  })

  it("oauth: billing block, Claude-Code identity, body", () => {
    const got = serialize(resolveAnthropicSystemPrompt(base))
    expect(got.length).toBeGreaterThan(0)
    expect(got.toString("utf8")).toContain(BILLING_PREFIX)
    expect(got.equals(fixture("oauth.txt"))).toBe(true)
  })

  it("api key: neutral identity, no billing block", () => {
    const got = serialize(resolveAnthropicSystemPrompt({ ...base, authKind: "api-key" }))
    expect(got.length).toBeGreaterThan(0)
    expect(got.toString("utf8")).not.toContain("x-anthropic-billing-header")
    expect(got.equals(fixture("api-key.txt"))).toBe(true)
  })

  // This baseline records that the override is ignored today. A later step
  // that honors the field must update this fixture on purpose.
  it("oauth with providerPreambleOverride: bytes captured as they are today", () => {
    const got = serialize(
      resolveAnthropicSystemPrompt({
        ...base,
        providerPreambleOverride: { kind: "replace", text: "OVERRIDE PREAMBLE" },
      }),
    )
    expect(got.length).toBeGreaterThan(0)
    expect(got.toString("utf8")).toContain(BILLING_PREFIX)
    expect(got.equals(fixture("oauth-preamble-replace.txt"))).toBe(true)
  })

  // This baseline records that the override is ignored today. A later step
  // that honors the field must update this fixture on purpose.
  it("oauth with providerPreambleOverride omit: bytes captured as they are today", () => {
    const got = serialize(
      resolveAnthropicSystemPrompt({ ...base, providerPreambleOverride: { kind: "omit" } }),
    )
    expect(got.length).toBeGreaterThan(0)
    expect(got.toString("utf8")).toContain(BILLING_PREFIX)
    expect(got.equals(fixture("oauth-preamble-omit.txt"))).toBe(true)
  })
})
