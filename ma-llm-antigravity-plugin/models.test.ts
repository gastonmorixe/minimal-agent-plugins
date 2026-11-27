/**
 * Tests of the grouped catalog and the effort to wire pair map.
 *
 * Source of the rules: `research/2026-11-25-antigravity-plugin/notes/`
 * `effort-model-map.md`. agy shows one row per `groupedModels` family and
 * sends `model: "<base>-<level>"` with `thinkingLevel: "<LEVEL>"`. It never
 * sends two different levels in one request.
 */
import { beforeEach, describe, expect, it } from "bun:test"

import type { CanonicalRequest } from "@minimal-agent/core/plugin-api/llm/canonical-request"

import { CAPS_GEMINI_3_FLASH, CAPS_GEMINI_FLASH_LITE } from "./capabilities.ts"
import type { ModelView } from "./lib/host-types.ts"
import type { ProviderModelSpec } from "./lib/provider-plugin.ts"
import {
  antigravityLiveRows,
  antigravityTokenKey,
  clearAntigravityLiveModelsCache,
  type FetchModelsResponse,
  fetchAntigravityCatalog,
  resolveProject,
} from "./live-models.ts"
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ANTIGRAVITY_MODEL_GROUPS,
  ANTIGRAVITY_MODELS,
  antigravityCapabilitiesFor,
  antigravitySpecsFromCatalog,
  findAntigravityModel,
  registerAntigravityAdHocModelInto,
  registerAntigravityModels,
  rememberAntigravityLiveCatalog,
} from "./models.ts"
import { buildAntigravityBody } from "./request-body.ts"
import { validateAntigravityRequest } from "./validate.ts"

/**
 * `fetchAvailableModels` of 2026-11-25, reduced to the catalog fields
 * (`research/2026-11-25-antigravity-plugin/evidence/fetchAvailableModels.json`
 * `.flows[0].response`). No account data.
 */
const SNAPSHOT_FILE = new URL("./__fixtures__/fetch-available-models.json", import.meta.url)

function spec(id: string): ProviderModelSpec {
  const found = findAntigravityModel(id)
  if (!found) throw new Error(`test fixture: no catalog row for ${id}`)
  return found
}

/** The registry rule: an id resolves directly or through an alias. */
function resolve(id: string): ModelView {
  return spec(id) as ModelView
}

function wire(modelId: string, extra: Partial<CanonicalRequest> = {}) {
  const req: CanonicalRequest = { modelId, messages: [], ...extra }
  const model = resolve(modelId)
  const { body } = buildAntigravityBody(req, model, {
    project: "p",
    modelId: model.vendorIds?.model ?? model.id,
    requestId: "agent/1/2/3/0",
  }) as {
    body: {
      model: string
      request: { generationConfig: { thinkingConfig?: { thinkingLevel?: string } } }
    }
  }
  return { model: body.model, level: body.request.generationConfig.thinkingConfig?.thinkingLevel }
}

describe("grouped catalog", () => {
  it("has one row per family, with the family levels and default", () => {
    const rows = ANTIGRAVITY_MODEL_GROUPS.map((g) => [g.base, g.levels.join(","), g.defaultEffort])
    expect(rows).toEqual([
      ["gemini-4-neon", "low,medium,high,xhigh", "high"],
      ["claude-opus-5-5", "low,medium,high", "medium"],
      ["gemini-4-carbon", "low,medium,high", "medium"],
      ["gemini-4-hydrogen", "low,medium,high,xhigh", "medium"],
      ["claude-sonnet-5-5", "low,medium,high", "medium"],
      ["gemini-4-argon", "low,medium,high", "medium"],
      ["gemini-3.8-flash", "low,medium,high", "medium"],
    ])
  })

  it("lists no suffixed id of a family as its own row", () => {
    const ids = ANTIGRAVITY_MODELS.map((s) => s.id)
    for (const g of ANTIGRAVITY_MODEL_GROUPS) {
      for (const level of g.levels) expect(ids).not.toContain(`${g.base}-${level}`)
    }
    expect(ids).toContain("gemini-4-neon")
    expect(ids).toContain("gpt-oss-120b-medium")
    expect(ids).toContain("gemini-4-hydrogen-tiered-high")
    expect(ids).toContain("gemini-pro-orchestrator")
  })

  it("gives each family row its capability effort levels and default", () => {
    const neon = spec("gemini-4-neon")
    expect(neon.displayName).toBe("Gemini 4 Neon")
    expect(neon.capabilities.effort).toEqual({
      levels: ["low", "medium", "high", "xhigh"],
      default: "high",
    })
    expect(neon.aliases).toEqual([
      "gemini-4-neon-low",
      "gemini-4-neon-medium",
      "gemini-4-neon-high",
      "gemini-4-neon-xhigh",
    ])
    expect(spec("gemini-4-carbon").capabilities.effort.levels).toEqual(["low", "medium", "high"])
  })

  it("gives a single row no picker, or its one suffix", () => {
    expect(spec("gemini-pro-orchestrator").capabilities.effort.levels).toEqual([])
    expect(spec("gemini-3.5-flash-lite").capabilities.effort.levels).toEqual([])
    expect(spec("gpt-oss-120b-medium").capabilities.effort.levels).toEqual(["medium"])
    expect(spec("gemini-4-hydrogen-tiered-xhigh").capabilities.effort).toEqual({
      levels: ["xhigh"],
      default: "xhigh",
    })
  })

  it("boots with the family of the account default", () => {
    expect(ANTIGRAVITY_DEFAULT_MODEL).toBe("gemini-4-neon")
  })

  it("registers every row with no id and alias collision", () => {
    const ids = new Set<string>()
    const defaults: Array<string | null> = []
    registerAntigravityModels({
      register(s) {
        for (const name of [s.id, ...(s.aliases ?? [])]) {
          expect(ids.has(name)).toBe(false)
          ids.add(name)
        }
      },
      setDefault(id) {
        defaults.push(id)
      },
    })
    expect(defaults).toEqual(["gemini-4-neon"])
  })
})

describe("capability table of an id (review finding 8)", () => {
  it("gives flash-lite the flash-lite table, also with 3. in the id", () => {
    for (const id of ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.5-flash-lite"]) {
      expect(antigravityCapabilitiesFor({ id, out: 65_535 }).maxOutputTokens).toBe(
        CAPS_GEMINI_FLASH_LITE.maxOutputTokens,
      )
    }
    expect(antigravityCapabilitiesFor({ id: "gemini-3-flash", out: 65_536 })).toBe(
      CAPS_GEMINI_3_FLASH,
    )
  })

  it("does not reject xhigh on a hydrogen family request", () => {
    const req: CanonicalRequest = { modelId: "gemini-4-hydrogen", messages: [], effort: "xhigh" }
    expect(validateAntigravityRequest(req, resolve("gemini-4-hydrogen")).ok).toBe(true)
  })

  it("rejects xhigh on a family with no xhigh", () => {
    const req: CanonicalRequest = { modelId: "gemini-4-carbon", messages: [], effort: "xhigh" }
    expect(validateAntigravityRequest(req, resolve("gemini-4-carbon")).ok).toBe(false)
  })
})

describe("wire pair", () => {
  it("maps each neon effort to the agy pair", () => {
    for (const effort of ["low", "medium", "high", "xhigh"]) {
      expect(wire("gemini-4-neon", { effort })).toEqual({
        model: `gemini-4-neon-${effort}`,
        level: effort.toUpperCase(),
      })
    }
  })

  it("uses the family default, not the core medium, with no effort", () => {
    expect(wire("gemini-4-neon")).toEqual({ model: "gemini-4-neon-high", level: "HIGH" })
    expect(wire("claude-sonnet-5-5")).toEqual({
      model: "claude-sonnet-5-5-medium",
      level: "MEDIUM",
    })
  })

  it("resolves an old suffixed id to its own level", () => {
    expect(wire("gemini-4-neon-low")).toEqual({ model: "gemini-4-neon-low", level: "LOW" })
    expect(wire("gemini-4-neon-high")).toEqual({ model: "gemini-4-neon-high", level: "HIGH" })
  })

  it("lets an explicit effort on an old id pick the matching id", () => {
    expect(wire("gemini-4-neon-high", { effort: "low" })).toEqual({
      model: "gemini-4-neon-low",
      level: "LOW",
    })
  })

  it("never sends an off-diagonal pair", () => {
    for (const g of ANTIGRAVITY_MODEL_GROUPS) {
      for (const level of g.levels) {
        for (const effort of [undefined, ...g.levels]) {
          const pair = wire(`${g.base}-${level}`, effort ? { effort } : {})
          expect(pair.model).toBe(`${g.base}-${pair.level?.toLowerCase()}`)
        }
      }
    }
  })

  it("sends the id with no level when thinking is off", () => {
    expect(wire("gemini-4-neon", { thinking: { mode: "off" } })).toEqual({
      model: "gemini-4-neon-high",
      level: undefined,
    })
  })

  it("sends a single suffixed id with its own suffix", () => {
    expect(wire("gemini-4-hydrogen-tiered-high")).toEqual({
      model: "gemini-4-hydrogen-tiered-high",
      level: "HIGH",
    })
  })
})

describe("live catalog", () => {
  beforeEach(() => clearAntigravityLiveModelsCache())

  async function snapshot(): Promise<FetchModelsResponse> {
    return (await Bun.file(SNAPSHOT_FILE).json()) as FetchModelsResponse
  }

  it("builds the same rows as the static catalog from the evidence response", async () => {
    const live = antigravitySpecsFromCatalog(await snapshot())
    const pick = (s: ProviderModelSpec) =>
      JSON.stringify([s.id, s.capabilities.effort, s.vendorIds?.model, s.aliases ?? []])
    expect(live.map(pick).sort()).toEqual(ANTIGRAVITY_MODELS.map(pick).sort())
    const liveIds = antigravityLiveRows(await snapshot()).map((r) => r.id)
    expect(liveIds.sort()).toEqual(ANTIGRAVITY_MODELS.map((s) => s.id).sort())
    expect(liveIds).not.toContain("tab_flash_lite_preview")
  })

  it("keeps a new family that a later catalog lists", () => {
    const response: FetchModelsResponse = {
      defaultAgentModelId: "gemini-5-krypton-low",
      models: {
        "gemini-5-krypton-low": { displayName: "K (Low)", maxOutputTokens: 262_144 },
        "gemini-5-krypton-high": { displayName: "K (High)", maxOutputTokens: 262_144 },
      },
      groupedModels: {
        "gemini-5-krypton": {
          displayName: "Gemini 5 Krypton",
          supportedThinkingLevels: [{ thinkingSuffix: "low" }, { thinkingSuffix: "high" }],
        },
      },
    }
    const rows = antigravitySpecsFromCatalog(response)
    expect(rows.map((r) => [r.id, r.capabilities.effort])).toEqual([
      ["gemini-5-krypton", { levels: ["low", "high"], default: "low" }],
    ])

    rememberAntigravityLiveCatalog(response)
    const registered: ProviderModelSpec[] = []
    registerAntigravityAdHocModelInto(
      { register: (s) => registered.push(s), setDefault: () => {} },
      "gemini-5-krypton-high",
    )
    expect(registered.map((s) => s.id)).toEqual(["gemini-5-krypton"])
  })

  it("drops a family level that has no backend row", () => {
    const rows = antigravitySpecsFromCatalog({
      models: { "gemini-x-low": { maxOutputTokens: 65_536 } },
      groupedModels: {
        "gemini-x": {
          supportedThinkingLevels: [{ thinkingSuffix: "low" }, { thinkingSuffix: "xhigh" }],
        },
      },
    })
    expect(rows[0]?.capabilities.effort.levels).toEqual(["low"])
  })
})

describe("cache key (review finding 3)", () => {
  beforeEach(() => clearAntigravityLiveModelsCache())

  it("hashes the full token, so two tokens with one prefix differ", () => {
    const a = antigravityTokenKey("ya29.a0A-account-one")
    const b = antigravityTokenKey("ya29.a0A-account-two")
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toContain("ya29")
  })

  it("keeps one project and one catalog per account", async () => {
    const calls: string[] = []
    const client = {
      async request(opts: { url: string; headers?: Record<string, string> }) {
        const who = opts.headers?.authorization ?? ""
        calls.push(`${opts.url.split(":").pop()} ${who.endsWith("one") ? "one" : "two"}`)
        const body = opts.url.includes("loadCodeAssist")
          ? { cloudaicompanionProject: who.endsWith("one") ? "proj-one" : "proj-two" }
          : { models: {} }
        return new Response(JSON.stringify(body), { status: 200 })
      },
    } as never
    const one = { token: "ya29.a0A-account-one", networkClient: client }
    const two = { token: "ya29.a0A-account-two", networkClient: client }
    expect(await resolveProject(one)).toBe("proj-one")
    expect(await resolveProject(two)).toBe("proj-two")
    await fetchAntigravityCatalog(one)
    await fetchAntigravityCatalog(two)
    expect(calls.filter((c) => c.startsWith("fetchAvailableModels")).length).toBe(2)
  })
})
