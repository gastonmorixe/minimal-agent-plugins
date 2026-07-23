/**
 * Tests for the model-resolution gating in `serviceDepsFromCtx`.
 *
 * The contract under test: a delegated worker inherits the LEAD's model by
 * default, and only consults the active provider's per-role recommendation
 * (cheap scout / flagship deep) when the user explicitly opts in with
 * `MINIMAL_AGENT_SUBAGENT_AUTO_TIER=1`. This is the regression guard for the
 * silent Opus→Sonnet/Haiku downgrade that surprised users.
 *
 * Also guards provider inheritance for dual-registered bare model ids
 * (e.g. `grok-4.5` on both `grok` and `opencode`): an unscoped registry
 * last-write-wins must NOT route inherited workers to the wrong gateway.
 *
 * @module sub-agents/lib/handler-deps.test
 */

import { describe, expect, it } from "bun:test"

import type { TUIContext } from "../lib/host-types.ts"

import { serviceDepsFromCtx } from "./handler-deps.ts"

const LEAD = "11111111-1111-4111-8111-111111111111"

interface MakeCtxOpts {
  env?: Record<string, string>
  model?: string
  /** Live provider id from the lead (what `queryModelInfo` should report). */
  providerId?: string
  /** Live effort levels from queryModelInfo (lead model). */
  effortLevels?: string[]
  /**
   * What the unscoped host registry `models.find` returns for a model id.
   * Simulates last-write-wins when two providers register the same bare id.
   */
  registryProviderByModel?: Record<string, string>
}
/** True when `opts` looks like a bare env map (legacy makeCtx(env) calls). */
function isBareEnvMap(opts: object): opts is Record<string, string> {
  return (
    !("env" in opts) &&
    !("model" in opts) &&
    !("providerId" in opts) &&
    !("effortLevels" in opts) &&
    !("registryProviderByModel" in opts)
  )
}

/** A minimal TUIContext good enough for `serviceDepsFromCtx`. */
function makeCtx(opts: MakeCtxOpts | Record<string, string> = {}, modelArg?: string): TUIContext {
  // Back-compat: older call shape was makeCtx(env, model?).
  const normalized: MakeCtxOpts = isBareEnvMap(opts)
    ? { env: opts, model: modelArg }
    : (opts as MakeCtxOpts)

  const model = normalized.model ?? modelArg ?? "claude-opus-4-8"
  const env = normalized.env ?? {}
  const providerId = normalized.providerId
  const effortLevels = normalized.effortLevels
  const registry = normalized.registryProviderByModel ?? {}

  return {
    cwd: "/repo",
    env,
    agent: { sessionId: LEAD, model },
    // The host wires this from the active provider; here it always offers a
    // cheaper per-role pick, so any leak shows up as a non-lead model.
    recommendSubagentModels: () => [
      { role: "scout", modelId: "claude-haiku-4-5-20251001" },
      { role: "balanced", modelId: "claude-sonnet-4-6" },
      { role: "deep", modelId: "claude-opus-4-8" },
    ],
    queryModelInfo: () => ({
      modelId: model,
      ...(providerId ? { providerId } : {}),
      ...(effortLevels ? { effort: { levels: effortLevels, default: effortLevels[0] } } : {}),
    }),
    host: {
      models: {
        find: (modelId: string) => {
          const pid = registry[modelId]
          return pid ? { providerId: pid } : undefined
        },
      },
    },
  } as unknown as TUIContext
}

describe("serviceDepsFromCtx model gating", () => {
  it("does NOT wire recommendForRole by default (worker inherits the lead's model)", () => {
    const deps = serviceDepsFromCtx(makeCtx({}))
    expect(deps).not.toBeNull()
    // No role mapper means a role-bearing specialist falls through to defaultModel.
    expect(deps?.recommendForRole).toBeUndefined()
    expect(deps?.defaultModel).toBe("claude-opus-4-8")
  })

  it("wires recommendForRole only when MINIMAL_AGENT_SUBAGENT_AUTO_TIER=1", () => {
    const deps = serviceDepsFromCtx(makeCtx({ MINIMAL_AGENT_SUBAGENT_AUTO_TIER: "1" }))
    expect(deps?.recommendForRole).toBeDefined()
    expect(deps?.recommendForRole?.("scout")?.modelId).toBe("claude-haiku-4-5-20251001")
  })

  it("an explicit env model override still wins over auto-tiering", () => {
    const deps = serviceDepsFromCtx(
      makeCtx({
        MINIMAL_AGENT_SUBAGENT_AUTO_TIER: "1",
        MINIMAL_AGENT_SUBAGENT_MODEL: "claude-opus-4-8",
      }),
    )
    // Override short-circuits the role mapper so nothing can downgrade the pick.
    expect(deps?.recommendForRole).toBeUndefined()
    expect(deps?.defaultModel).toBe("claude-opus-4-8")
  })
})

describe("serviceDepsFromCtx provider inheritance (dual-registered model ids)", () => {
  it("inherits the lead provider when the worker reuses the lead model id", () => {
    // Lisa bug: lead is grok/grok-4.5; unscoped registry last-write is opencode.
    const deps = serviceDepsFromCtx(
      makeCtx({
        model: "grok-4.5",
        providerId: "grok",
        registryProviderByModel: { "grok-4.5": "opencode" },
      }),
    )
    expect(deps).not.toBeNull()
    expect(deps?.defaultModel).toBe("grok-4.5")
    expect(deps?.resolveProvider?.("grok-4.5")).toBe("grok")
  })

  it("does NOT follow unscoped registry last-write-wins for the lead model", () => {
    const deps = serviceDepsFromCtx(
      makeCtx({
        model: "grok-4.5",
        providerId: "grok",
        registryProviderByModel: { "grok-4.5": "opencode" },
      }),
    )
    // Explicitly prove we didn't take the registry's opencode entry.
    expect(deps?.resolveProvider?.("grok-4.5")).not.toBe("opencode")
  })

  it("falls back to the registry for a model id that is NOT the lead's", () => {
    const deps = serviceDepsFromCtx(
      makeCtx({
        model: "grok-4.5",
        providerId: "grok",
        registryProviderByModel: {
          "grok-4.5": "opencode",
          "deepseek-v4-pro": "opencode",
        },
      }),
    )
    expect(deps?.resolveProvider?.("deepseek-v4-pro")).toBe("opencode")
  })

  it("falls back to the registry when the lead has no live providerId", () => {
    const deps = serviceDepsFromCtx(
      makeCtx({
        model: "grok-4.5",
        // no providerId on queryModelInfo
        registryProviderByModel: { "grok-4.5": "opencode" },
      }),
    )
    expect(deps?.resolveProvider?.("grok-4.5")).toBe("opencode")
  })

  it("does not stamp the lead provider onto a different env-override model", () => {
    const deps = serviceDepsFromCtx(
      makeCtx({
        env: { MINIMAL_AGENT_SUBAGENT_MODEL: "deepseek-v4-pro" },
        model: "grok-4.5",
        providerId: "grok",
        registryProviderByModel: {
          "grok-4.5": "opencode",
          "deepseek-v4-pro": "opencode",
        },
      }),
    )
    expect(deps?.defaultModel).toBe("deepseek-v4-pro")
    // Override SKU resolves via registry, not the lead's grok provider.
    expect(deps?.resolveProvider?.("deepseek-v4-pro")).toBe("opencode")
    // Live lead model still pins to grok if someone resolves that id.
    expect(deps?.resolveProvider?.("grok-4.5")).toBe("grok")
  })
})

describe("serviceDepsFromCtx effortLevelsForModel", () => {
  it("exposes the lead live effort levels for the lead model id", () => {
    const deps = serviceDepsFromCtx(
      makeCtx({
        model: "grok-4.5",
        providerId: "grok",
        effortLevels: ["medium", "high", "max"],
      }),
    )
    expect(deps?.effortLevelsForModel?.("grok-4.5")).toEqual(["medium", "high", "max"])
  })

  it("returns undefined for an unknown model when no registry caps exist", () => {
    const deps = serviceDepsFromCtx(
      makeCtx({
        model: "grok-4.5",
        providerId: "grok",
        effortLevels: ["medium", "high", "max"],
      }),
    )
    expect(deps?.effortLevelsForModel?.("totally-unknown-model")).toBeUndefined()
  })
})
