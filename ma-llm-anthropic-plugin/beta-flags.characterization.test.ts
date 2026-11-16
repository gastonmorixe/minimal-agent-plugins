/**
 * Characterization snapshots for the Anthropic beta-flag assembler
 * (`./beta-flags.ts`): pin what it emits over the model × auth × kind × fast
 * matrix so a silent change fails here and forces a reviewed edit.
 *
 * Invariants pinned at the bottom:
 *  - redact-thinking: omitted from conversations (thinking stays visible — a
 *    product feature), included in the quota/title probe sets.
 *  - api-key auth: drops the oauth-coupled flags, keeps the rest.
 *  - context-1m: attached for every registered 1M model (the fable-5 P0 guard).
 *  - interleaved-thinking: omitted on opus-4-8 (parallel-tool-batch pathology),
 *    kept elsewhere.
 */

import { beforeAll, describe, expect, it } from "bun:test"

import type { CanonicalRequest } from "@minimal-agent/core/plugin-api/llm/canonical-request"

import { ANTHROPIC_BETA_FLAGS, buildBetaFlags, classifyRequest } from "./beta-flags.ts"
import { resolveModel } from "./lib/registry.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"
import { registerAnthropicModels } from "./models.ts"

beforeAll(() => {
  // Register through a local setup-context registrar; registerAnthropicModels
  // also mirrors every entry into the plugin-local catalog, so the plugin's own
  // `resolveModel` (lib/registry) resolves the catalog the test builds.
  registerAnthropicModels(makeTestRegistry().ctx.models)
})

/** Minimal conversation-shaped canonical request (multi-tool + 1h ttl). */
function conversationReq(modelId: string, extra?: Partial<CanonicalRequest>): CanonicalRequest {
  return {
    modelId,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }], cache: { ttl: "1h" } }],
    system: [{ type: "text", text: "sys", cache: { ttl: "1h" } }],
    tools: [
      { name: "a", description: "", inputSchema: { type: "object" } },
      { name: "b", description: "", inputSchema: { type: "object" } },
    ],
    effort: "high",
    ...extra,
  } as CanonicalRequest
}

const F = ANTHROPIC_BETA_FLAGS

describe("characterization: canonical buildBetaFlags (conversation, oauth)", () => {
  const cases: ReadonlyArray<[string, string[]]> = [
    [
      "claude-fable-5",
      [
        F.CLAUDE_CODE,
        F.OAUTH,
        F.INTERLEAVED_THINKING,
        F.CONTEXT_1M,
        F.CONTEXT_MANAGEMENT,
        F.THINKING_TOKEN_COUNT, // thinking-capable model (CC 2.1.325 zW gate)
        F.ADVANCED_TOOL_USE,
        F.EFFORT,
        F.PROMPT_CACHING_SCOPE,
        F.EXTENDED_CACHE_TTL,
        // redact-thinking omitted for conversations since B3a (B-0 flip):
        // visible thinking is a product feature; matches the legacy builder.
        F.MID_CONVERSATION_SYSTEM,
      ],
    ],
    [
      "claude-opus-4-8",
      [
        F.CLAUDE_CODE,
        F.OAUTH,
        // interleaved-thinking omitted for opus-4-8 (same pathology gate
        // as legacy; the gate is duplicated by id in both builders).
        F.CONTEXT_1M,
        F.CONTEXT_MANAGEMENT,
        F.THINKING_TOKEN_COUNT, // thinking-capable model (CC 2.1.325 zW gate)
        F.ADVANCED_TOOL_USE,
        F.EFFORT,
        F.PROMPT_CACHING_SCOPE,
        F.EXTENDED_CACHE_TTL,
        // redact-thinking omitted (B3a).
        F.MID_CONVERSATION_SYSTEM,
      ],
    ],
    [
      "claude-sonnet-4-6",
      [
        F.CLAUDE_CODE,
        F.OAUTH,
        F.INTERLEAVED_THINKING,
        // 1M-native → context-1m via the contextWindow >= 1M arm.
        F.CONTEXT_1M,
        F.CONTEXT_MANAGEMENT,
        F.THINKING_TOKEN_COUNT, // thinking-capable model (CC 2.1.325 zW gate)
        F.ADVANCED_TOOL_USE,
        F.EFFORT,
        F.PROMPT_CACHING_SCOPE,
        F.EXTENDED_CACHE_TTL,
        // redact-thinking omitted (B3a).
        F.MID_CONVERSATION_SYSTEM,
      ],
    ],
    [
      "claude-haiku-4-5-20251001",
      [
        F.CLAUDE_CODE,
        F.OAUTH,
        F.INTERLEAVED_THINKING,
        // 200k, no mid-conversation-system, no effort levels → no EFFORT
        // flag would be wrong: haiku HAS no effort levels, so the effort
        // arm is skipped even though req.effort is set.
        F.CONTEXT_MANAGEMENT,
        // no THINKING_TOKEN_COUNT: CAPS_HAIKU_45 has no thinking support.
        F.ADVANCED_TOOL_USE,
        F.PROMPT_CACHING_SCOPE,
        F.EXTENDED_CACHE_TTL,
        // redact-thinking omitted (B3a).
      ],
    ],
  ]

  for (const [modelId, expectedSet] of cases) {
    it(`pins the conversation flag set for ${modelId}`, () => {
      const model = resolveModel(modelId)
      const req = conversationReq(modelId)
      expect(classifyRequest(req)).toBe("conversation")
      const flags = buildBetaFlags({ kind: "conversation", req, model, authKind: "oauth" })
      // Declaration-ordered comparison: sort both through the declaration
      // order to keep the pin insensitive to Set insertion details while
      // still pinning MEMBERSHIP exactly.
      const order = Object.values(ANTHROPIC_BETA_FLAGS)
      const sortByDecl = (xs: readonly string[]) =>
        [...xs].sort((a, b) => order.indexOf(a as never) - order.indexOf(b as never))
      expect(sortByDecl(flags)).toEqual(sortByDecl(expectedSet))
    })
  }

  it("pins fast-mode: capability-gated INSIDE the builder", () => {
    const fable = resolveModel("claude-fable-5")
    const opus = resolveModel("claude-opus-4-8")
    const fableFlags = buildBetaFlags({
      kind: "conversation",
      req: conversationReq("claude-fable-5", { speed: "fast" }),
      model: fable,
      authKind: "oauth",
    })
    const opusFlags = buildBetaFlags({
      kind: "conversation",
      req: conversationReq("claude-opus-4-8", { speed: "fast" }),
      model: opus,
      authKind: "oauth",
    })
    expect(fableFlags).not.toContain(F.FAST_MODE) // speedFast:false → dropped
    expect(opusFlags).toContain(F.FAST_MODE) // speedFast:true → kept
  })
})

describe("characterization: beta-flag invariants per model/auth", () => {
  // These pin the DIFFERENCES between the two builders. When a wave of
  // the decoupling refactor intentionally unifies one of these, it must
  // edit this block in the same commit, which is exactly the review
  // visibility we want.

  it("redact-thinking: BOTH transports omit it from conversations, keep it in probes (B3a)", () => {
    // Conversations keep thinking visible (a product feature), so the redact
    // flag is omitted there; the quota/title probe sets still carry it.
    const model = resolveModel("claude-opus-4-7")
    const req = conversationReq("claude-opus-4-7")
    const canonical = buildBetaFlags({ kind: "conversation", req, model, authKind: "oauth" })
    expect(canonical).not.toContain(F.REDACT_THINKING)
    // Probe kinds keep the flag.
    const canonicalQuota = buildBetaFlags({ kind: "quota", req, model, authKind: "oauth" })
    const canonicalTitle = buildBetaFlags({ kind: "title", req, model, authKind: "oauth" })
    expect(canonicalQuota).toContain(F.REDACT_THINKING)
    expect(canonicalTitle).toContain(F.REDACT_THINKING)
  })

  it("api-key: drops only the oauth-coupled flags, keeps the rest", () => {
    const model = resolveModel("claude-fable-5")
    const canonical = buildBetaFlags({
      kind: "conversation",
      req: conversationReq("claude-fable-5"),
      model,
      authKind: "api-key",
    })
    // Canonical drops only the oauth-coupled flags.
    expect(canonical).not.toContain(F.OAUTH)
    expect(canonical).not.toContain(F.PROMPT_CACHING_SCOPE)
    expect(canonical).toContain(F.CLAUDE_CODE)
    expect(canonical).toContain(F.CONTEXT_1M)
  })

  it("context-1m membership tracks each model's context window (the fable-5 P0 guard)", () => {
    // The fable-5 P0 was exactly this matrix cell drifting. context-1m is
    // attached iff the registered model is 1M-capable (live 2026-11-15):
    // opus-5/4.8/4.7/4.6, fable-5/5.1/5.2, sonnet-5/4.6 are 1M;
    // opus-4-5 and haiku-4-5 are 200K and must NOT carry the flag.
    const expected: Record<string, boolean> = {
      "claude-opus-5": true,
      "claude-fable-5-2": true,
      "claude-fable-5-1": true,
      "claude-fable-5": true,
      "claude-opus-4-8": true,
      "claude-opus-4-7": true,
      "claude-opus-4-6": true,
      "claude-opus-4-5-20251101": false,
      "claude-sonnet-4-6": true,
      "claude-haiku-4-5-20251001": false,
    }
    for (const modelId of Object.keys(expected)) {
      const model = resolveModel(modelId)
      const hasContext1m = buildBetaFlags({
        kind: "conversation",
        req: conversationReq(modelId),
        model,
        authKind: "oauth",
      }).includes(F.CONTEXT_1M)
      expect({ modelId, hasContext1m }).toEqual({ modelId, hasContext1m: expected[modelId] })
    }
  })

  it("interleaved-thinking: the opus-4-8 omission gate holds", () => {
    // opus-4-8 omits interleaved-thinking (the parallel-tool-batch pathology);
    // opus-4-7 and fable-5 keep it.
    const expected: Record<string, boolean> = {
      "claude-opus-4-8": false,
      "claude-opus-4-7": true,
      "claude-fable-5": true,
    }
    for (const modelId of Object.keys(expected)) {
      const model = resolveModel(modelId)
      const hasInterleaved = buildBetaFlags({
        kind: "conversation",
        req: conversationReq(modelId),
        model,
        authKind: "oauth",
      }).includes(F.INTERLEAVED_THINKING)
      expect({ modelId, hasInterleaved }).toEqual({ modelId, hasInterleaved: expected[modelId] })
    }
  })
})

describe("characterization: claude-code 2.1.325 MAIN-set order (diff A8)", () => {
  /**
   * Exact MAIN `anthropic-beta` list from the claude-code 2.1.325 capture
   * (research/2026-11-15-cc-2.1.325-oauth-diff/cc-wire.md §1.2,
   * D/2026-11-16T03-59-10-571-fetch-005-01-req-meta.json).
   */
  const CC_MAIN_2_1_325 = [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
    "context-management-2025-06-27",
    "prompt-caching-scope-2026-01-05",
    "per-turn-control-2026-07-01",
    "mid-conversation-tool-changes-2026-07-01",
    "tool-provenance-2026-10-26",
    "thinking-token-count-2026-05-13",
    "advanced-tool-use-2025-11-20",
    "mid-conversation-system-clear-at-2026-08-21",
    "effort-2025-11-24",
    "thinking-binding-controls-2026-08-01",
    "thinking-display-updates-2026-08-18",
    "extended-cache-ttl-2025-04-11",
    "cache-diagnosis-2026-04-07",
  ]

  /** Flags we still send that CC 2.1.325 does not, pending a user decision. */
  const PENDING_B1_B2: string[] = [F.CONTEXT_1M, F.MID_CONVERSATION_SYSTEM]

  it("emits an ordered subsequence of the CC MAIN set for an opus-5-5 conversation", () => {
    const modelId = "claude-opus-5-5"
    const model = resolveModel(modelId)
    // OAuth conversation: effort, 2 tools, 5m TTL (no 1h → no extended-cache-ttl).
    // cacheDiagnostics mirrors what the adapter turns on for OAuth conversations.
    const req = {
      ...conversationReq(modelId),
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }], cache: { ttl: "5m" } }],
      system: [{ type: "text", text: "sys", cache: { ttl: "5m" } }],
      vendor: { anthropic: { cacheDiagnostics: true } },
    } as CanonicalRequest
    expect(classifyRequest(req)).toBe("conversation")
    const flags = buildBetaFlags({ kind: "conversation", req, model, authKind: "oauth" })
    const comparable = flags.filter((f) => !PENDING_B1_B2.includes(f))
    // Every remaining flag is in the CC MAIN set, in CC order.
    const positions = comparable.map((f) => CC_MAIN_2_1_325.indexOf(f))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    // Membership pin for this request shape (catches silent drift).
    expect(comparable).toEqual([
      F.CLAUDE_CODE,
      F.OAUTH,
      F.INTERLEAVED_THINKING,
      F.CONTEXT_MANAGEMENT,
      F.PROMPT_CACHING_SCOPE,
      F.THINKING_TOKEN_COUNT,
      F.ADVANCED_TOOL_USE,
      F.EFFORT,
      F.CACHE_DIAGNOSIS,
    ])
  })

  // B1 (drop context-1m for native-1M models) and B2 (mid-conversation-system →
  // mid-conversation-system-clear-at) need a user decision; once done, remove
  // PENDING_B1_B2 so the whole emitted set is checked against CC MAIN.
  it.todo("drops the B1/B2 exemptions once those decisions land")
})

describe("characterization: thinking-token-count gate (diff A4)", () => {
  it("is never sent on quota/title probes, even for thinking models", () => {
    const model = resolveModel("claude-opus-4-8")
    const req = { modelId: model.id, messages: [] } as unknown as CanonicalRequest
    for (const kind of ["quota", "title"] as const) {
      const flags = buildBetaFlags({ kind, req, model, authKind: "oauth" })
      expect(flags).not.toContain(F.THINKING_TOKEN_COUNT)
    }
  })

  // CC first-party gate: U1t(e)=!v3()&&N7n(e)&&(nye()||ZYs(e)). nye() is true
  // for firstParty (CC/chunk-29cd2nzs.mjs), so the opus-4-7 age gate ZYs only
  // bites on bedrock/vertex; N7n drops only claude-haiku-4-5 / claude-3-*
  // (CC/chunk-e44qnbvj.mjs). Hence opus-4-6 / sonnet-4-6 keep the flag.
  const ttcCases: ReadonlyArray<[string, boolean]> = [
    ["claude-opus-4-5-20251101", true],
    ["claude-opus-4-6", true],
    ["claude-sonnet-4-6", true],
    ["claude-opus-4-7", true],
    ["claude-opus-4-8", true],
    ["claude-opus-5-5", true],
    ["claude-sonnet-5-5", true],
    ["claude-fable-5", true],
    ["claude-haiku-4-5-20251001", false],
  ]
  for (const [modelId, expected] of ttcCases) {
    it(`first-party conversation gate: ${modelId} → ${expected}`, () => {
      const model = resolveModel(modelId)
      const flags = buildBetaFlags({
        kind: "conversation",
        req: conversationReq(modelId),
        model,
        authKind: "oauth",
      })
      expect(flags.includes(F.THINKING_TOKEN_COUNT)).toBe(expected)
    })
  }

  // Off first party (authKind "custom") nye() is false, so CC's ZYs age gate
  // applies: models older than claude-opus-4-7 in NC lose the flag.
  const customCases: ReadonlyArray<[string, "oauth" | "api-key" | "custom", boolean]> = [
    ["claude-opus-4-6", "custom", false],
    ["claude-sonnet-4-6", "custom", false],
    ["claude-opus-4-5-20251101", "custom", false],
    ["claude-opus-4-7", "custom", true],
    ["claude-opus-4-8", "custom", true],
    ["claude-opus-4-6", "oauth", true],
    ["claude-opus-4-6", "api-key", true],
  ]
  for (const [modelId, authKind, expected] of customCases) {
    it(`${authKind} conversation gate: ${modelId} → ${expected}`, () => {
      const model = resolveModel(modelId)
      const flags = buildBetaFlags({
        kind: "conversation",
        req: conversationReq(modelId),
        model,
        authKind,
      })
      expect(flags.includes(F.THINKING_TOKEN_COUNT)).toBe(expected)
    })
  }

  it("honors MINIMAL_AGENT_NO_THINKING_TOKEN_COUNT=1", () => {
    const model = resolveModel("claude-opus-4-8")
    const prev = process.env.MINIMAL_AGENT_NO_THINKING_TOKEN_COUNT
    process.env.MINIMAL_AGENT_NO_THINKING_TOKEN_COUNT = "1"
    try {
      const flags = buildBetaFlags({
        kind: "conversation",
        req: conversationReq(model.id),
        model,
        authKind: "oauth",
      })
      expect(flags).not.toContain(F.THINKING_TOKEN_COUNT)
    } finally {
      if (prev === undefined) delete process.env.MINIMAL_AGENT_NO_THINKING_TOKEN_COUNT
      else process.env.MINIMAL_AGENT_NO_THINKING_TOKEN_COUNT = prev
    }
  })
})
