import { afterEach, describe, expect, it } from "bun:test"

import {
  deriveCursorCapabilities,
  deriveCursorVariantCapabilities,
  effortParamIdFromTags,
  extractCursorEffortLevels,
  resolveCursorContextWindow,
  resolveCursorEffortParamId,
} from "./capabilities.ts"
import type { ModelRegistrar, ProviderModelSpec } from "./lib/provider-plugin.ts"
import {
  listCursorLiveModels,
  mapCursorLiveModels,
  registerCursorLiveCatalog,
  resetCursorLiveCatalogCacheForTests,
  setCursorLiveModelRegistrar,
} from "./live-models.ts"
import { decodeAvailableModel, decodeAvailableModelsResponse } from "./proto/models-decode.ts"
import {
  concat,
  encBool,
  encMsg,
  encRepeatedString,
  encString,
  encVarintField,
} from "./proto/wire.ts"

/** EnumParameterValue: value=high */
function enumValue(value: string, displayName?: string): Uint8Array {
  return concat(encString(1, value), ...(displayName ? [encString(2, displayName)] : []))
}

/** EnumParameterDefinition: repeated values at field 1 */
function enumParameter(values: string[]): Uint8Array {
  return concat(...values.map((v) => encMsg(1, enumValue(v))))
}

/** ModelParameterType oneof: field 2 = enum_parameter */
function parameterTypeEnum(values: string[]): Uint8Array {
  return encMsg(2, enumParameter(values))
}

/** ModelParameterDefinition: id + parameter_type */
function parameterDefinition(id: string, values: string[]): Uint8Array {
  return concat(encString(1, id), encString(2, id), encMsg(4, parameterTypeEnum(values)))
}

function syntheticModel(): Uint8Array {
  const parameterValue = concat(encString(1, "effort"), encString(2, "high"))
  const variant = concat(
    encMsg(1, parameterValue),
    encString(2, "High"),
    encBool(3, true),
    encString(9, "composer-test-high"),
  )
  return concat(
    encString(1, "composer-test"),
    encBool(2, true),
    encBool(5, true),
    encBool(9, true),
    encBool(10, true),
    encBool(14, true),
    encVarintField(15, 200_000),
    encVarintField(16, 400_000),
    encString(17, "Composer Test"),
    encMsg(29, parameterDefinition("effort", ["low", "medium", "high", "xhigh", "max"])),
    encMsg(30, variant),
    encRepeatedString(37, ["composer-test-alias"]),
    // CloudAgentEffortMode ordinals must NOT become effort ladder labels.
    encVarintField(44, 1),
    encVarintField(44, 2),
  )
}

function syntheticResponse(): Uint8Array {
  return concat(
    encRepeatedString(1, ["legacy-only"]),
    encMsg(2, syntheticModel()),
    encBool(11, true),
  )
}

function makeRegistrar(): { registrar: ModelRegistrar; entries: Map<string, ProviderModelSpec> } {
  const entries = new Map<string, ProviderModelSpec>()
  const registrar: ModelRegistrar = {
    register(spec) {
      entries.set(spec.id, spec)
    },
    setDefault() {},
  }
  return { registrar, entries }
}

describe("Cursor AvailableModels decoder", () => {
  it("decodes rich model flags, aliases, variants, parameter defs, and effort modes", () => {
    const model = decodeAvailableModel(syntheticModel())
    expect(model).toMatchObject({
      name: "composer-test",
      clientDisplayName: "Composer Test",
      supportsAgent: true,
      supportsThinking: true,
      supportsImages: true,
      supportsMaxMode: true,
      contextTokenLimit: 200_000,
      contextTokenLimitForMaxMode: 400_000,
      idAliases: ["composer-test-alias"],
      cloudAgentEffortModes: [1, 2],
    })
    expect(model.variants?.[0]?.variantStringRepresentation).toBe("composer-test-high")
    expect(model.parameterDefinitions?.[0]?.id).toBe("effort")
    expect(model.parameterDefinitions?.[0]?.enumValues?.map((v) => v.value)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
  })

  it("ignores malformed boolean fields with the wrong protobuf wire type", () => {
    const model = decodeAvailableModel(concat(encString(1, "malformed"), encString(9, "true")))
    expect(model.supportsThinking).toBeUndefined()
  })

  it("maps the response to deterministic live rows including aliases and variants", () => {
    const decoded = decodeAvailableModelsResponse(syntheticResponse())
    expect(decoded.useModelParameters).toBe(true)
    // Host ids are namespaced `cursor-…` to avoid Grok alias collisions.
    expect(mapCursorLiveModels(decoded)).toEqual([
      { id: "cursor-composer-test", displayName: "Composer Test" },
      { id: "cursor-composer-test-alias", displayName: "Composer Test" },
      { id: "cursor-composer-test-high", displayName: "Composer Test High" },
      { id: "cursor-legacy-only", displayName: "legacy-only" },
    ])
  })

  it("derives context, thinking, image, and effort from parameter defs (not cloud ordinals)", () => {
    const model = decodeAvailableModel(syntheticModel())
    expect(extractCursorEffortLevels(model)).toEqual(["low", "medium", "high", "xhigh", "max"])
    expect(resolveCursorContextWindow(model)).toBe(200_000)

    const capabilities = deriveCursorCapabilities(model)
    expect(capabilities.contextWindow).toBe(200_000)
    expect(capabilities.thinking.visible).toBe(true)
    expect(capabilities.modalities.image).toBe(true)
    expect(capabilities.effort.levels).toEqual(["low", "medium", "high", "xhigh", "max"])
    expect(capabilities.tools.userDefined).toBe(true)
    // Must not leak CloudAgentEffortMode "1"/"2"
    expect(capabilities.effort.levels).not.toContain("1")
    expect(capabilities.effort.levels).not.toContain("2")
  })

  it("ignores non-effort field-29 parameter definitions (no false ladder levels)", () => {
    // parameter id "verbosity" with enum values must not become effort levels
    const verbosityDef = concat(
      encString(1, "verbosity"),
      encString(2, "verbosity"),
      encMsg(
        4,
        encMsg(
          2,
          concat(
            encMsg(1, concat(encString(1, "terse"))),
            encMsg(1, concat(encString(1, "verbose"))),
          ),
        ),
      ),
    )
    const model = decodeAvailableModel(
      concat(encString(1, "no-false-effort"), encBool(9, true), encMsg(29, verbosityDef)),
    )
    // No effort-param id → levels empty (not terse/verbose, not default ladder)
    expect(extractCursorEffortLevels(model)).toEqual([])
    expect(deriveCursorCapabilities(model).thinking.visible).toBe(true)
    expect(deriveCursorCapabilities(model).effort.levels).toEqual([])
    expect(deriveCursorCapabilities(model).effort.levels).not.toContain("terse")
    expect(deriveCursorCapabilities(model).effort.levels).not.toContain("verbose")
  })

  it("variant caps prefer variant effort + max-mode context", () => {
    const model = decodeAvailableModel(syntheticModel())
    const variant = model.variants![0]!
    const caps = deriveCursorVariantCapabilities(model, variant)
    expect(caps.contextWindow).toBe(400_000)
    expect(caps.effort.levels).toEqual(["high"])
  })

  it("does not advertise effort levels when thinking but no effort-param id (closed)", () => {
    const model = decodeAvailableModel(
      concat(encString(1, "think-only"), encBool(9, true), encVarintField(15, 128_000)),
    )
    expect(deriveCursorCapabilities(model).thinking.visible).toBe(true)
    expect(deriveCursorCapabilities(model).effort.levels).toEqual([])
    expect(resolveCursorEffortParamId(model)).toBeUndefined()
    expect(resolveCursorContextWindow(model)).toBe(128_000)
  })

  it("uses default context when catalog omits token limits", () => {
    const model = decodeAvailableModel(concat(encString(1, "no-ctx"), encBool(9, true)))
    expect(resolveCursorContextWindow(model)).toBe(128_000)
  })
})

describe("registerCursorLiveCatalog", () => {
  it("maps Cursor Auto alias host id to wire id default (not auto)", () => {
    // AvailableModels: name=default, display Auto, idAliases=[auto]
    // GetUsableModels: modelId=default, displayModelId=auto
    const autoModel = concat(
      encString(1, "default"),
      encBool(2, true),
      encBool(5, true),
      encString(17, "Auto"),
      encString(18, "default"),
      encString(19, "Auto"),
      encRepeatedString(37, ["auto"]),
    )
    const decoded = decodeAvailableModelsResponse(encMsg(2, autoModel))
    const { registrar, entries } = makeRegistrar()
    registerCursorLiveCatalog(registrar, decoded)

    const primary = entries.get("cursor-default")
    expect(primary?.vendorIds?.cursor).toBe("default")

    const alias = entries.get("cursor-auto")
    expect(alias).toBeDefined()
    expect(alias!.vendorIds?.cursor).toBe("default")
    expect(alias!.tags).toContain("alias")
    expect(alias!.tags).toContain("canonical:default")
  })

  it("registers full ModelEntry caps for primary, alias, variant, and legacy names", () => {
    const { registrar, entries } = makeRegistrar()
    const decoded = decodeAvailableModelsResponse(syntheticResponse())
    const ids = registerCursorLiveCatalog(registrar, decoded)

    expect(ids).toContain("cursor-composer-test")
    expect(ids).toContain("cursor-composer-test-alias")
    expect(ids).toContain("cursor-composer-test-high")
    expect(ids).toContain("cursor-legacy-only")

    const primary = entries.get("cursor-composer-test")
    expect(primary).toBeDefined()
    expect(primary!.providerId).toBe("cursor")
    expect(primary!.vendorIds?.cursor).toBe("composer-test")
    expect(primary!.capabilities.contextWindow).toBe(200_000)
    expect(primary!.capabilities.thinking.visible).toBe(true)
    expect(primary!.capabilities.effort.levels).toEqual(["low", "medium", "high", "xhigh", "max"])
    expect(primary!.capabilities.tools.userDefined).toBe(true)
    expect(primary!.capabilities.modalities.image).toBe(true)
    // Jack bridge: real parameter id, not hardcoded "effort" assumption only
    expect(primary!.tags).toContain("effort-param:effort")
    expect(effortParamIdFromTags(primary!.tags)).toBe("effort")
    expect(resolveCursorEffortParamId(decodeAvailableModel(syntheticModel()))).toBe("effort")
    // Capability vs selected max: parent supports max but is NOT selected max-mode
    expect(primary!.tags).toContain("supports-max-mode")
    expect(primary!.tags).not.toContain("max-mode")

    const alias = entries.get("cursor-composer-test-alias")
    expect(alias!.tags).toContain("alias")
    expect(alias!.tags?.some((t) => t.startsWith("canonical:"))).toBe(true)
    // Alias host id keeps the display slug, but Run wire id is the parent name.
    // (Cursor Auto: host cursor-auto, wire default — not the alias "auto".)
    expect(alias!.vendorIds?.cursor).toBe("composer-test")
    expect(alias!.tags).toContain("effort-param:effort")
    expect(alias!.tags).toContain("supports-max-mode")
    expect(alias!.tags).not.toContain("max-mode")

    const variant = entries.get("cursor-composer-test-high")
    expect(variant!.capabilities.contextWindow).toBe(400_000)
    expect(variant!.capabilities.effort.levels).toEqual(["high"])
    expect(variant!.vendorIds?.cursor).toBe("composer-test-high")
    expect(variant!.tags).toContain("variant")
    expect(variant!.tags).toContain("parent:composer-test")
    expect(variant!.tags).toContain("param:effort=high")
    // Parameterized variants encode as exploded SKU, not f8 variant-string.
    expect(variant!.tags).not.toContain("variant-string")
    expect(variant!.tags).not.toContain("variant-legacy-slug")
    // Selected max only on max variants (variant.isMaxMode)
    expect(variant!.tags).toContain("max-mode")
    expect(variant!.tags).toContain("supports-max-mode")
    expect(variant!.tags).toContain("parent:composer-test")
    expect(variant!.tags).toContain("effort-param:effort")

    const legacy = entries.get("cursor-legacy-only")
    expect(legacy!.capabilities.contextWindow).toBe(128_000)
    expect(legacy!.capabilities.effort.levels).toEqual([])
    expect(effortParamIdFromTags(legacy!.tags)).toBeUndefined()
  })

  it("tags legacySlug-only variants as variant-legacy-slug not variant-string", () => {
    // variant with only legacy_slug (field 11), no variant_string_representation (field 9)
    const legacyOnlyVariant = concat(encString(2, "Legacy"), encString(11, "composer-legacy-wire"))
    const modelBytes = concat(
      encString(1, "composer-legacy-parent"),
      encBool(9, true),
      encMsg(29, parameterDefinition("effort", ["low", "high"])),
      encMsg(30, legacyOnlyVariant),
    )
    const decoded = decodeAvailableModelsResponse(encMsg(2, modelBytes))
    const { registrar, entries } = makeRegistrar()
    registerCursorLiveCatalog(registrar, decoded)
    const row = entries.get("cursor-composer-legacy-wire")
    expect(row).toBeDefined()
    expect(row!.tags).toContain("variant")
    expect(row!.tags).toContain("variant-legacy-slug")
    expect(row!.tags).not.toContain("variant-string")
  })
})

describe("listCursorLiveModels", () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
    setCursorLiveModelRegistrar(undefined)
    resetCursorLiveCatalogCacheForTests()
  })

  it("fetches the authenticated protobuf catalog and registers caps when registrar is set", async () => {
    let sawAuthorization = ""
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      sawAuthorization = headers.get("authorization") ?? ""
      return new Response(syntheticResponse() as unknown as BodyInit, {
        status: 200,
        headers: { "content-type": "application/proto" },
      })
    }) as unknown as typeof fetch

    const { registrar, entries } = makeRegistrar()
    setCursorLiveModelRegistrar(registrar)

    const rows = await listCursorLiveModels({ kind: "oauth", token: "access-redacted" })
    expect(sawAuthorization).toBe("Bearer access-redacted")
    expect(rows.some((row) => row.id === "cursor-composer-test")).toBe(true)
    expect(entries.get("cursor-composer-test")?.capabilities.effort.levels).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
  })

  it("returns [] on network or protocol failure without throwing", async () => {
    globalThis.fetch = (async () => {
      throw new Error("offline")
    }) as unknown as typeof fetch
    expect(await listCursorLiveModels({ kind: "oauth", token: "access-redacted" })).toEqual([])
  })

  it("throws on HTTP 401 so host allSettled can print the auth failure", async () => {
    globalThis.fetch = (async () =>
      new Response("authentication_error", { status: 401 })) as unknown as typeof fetch
    await expect(listCursorLiveModels({ kind: "oauth", token: "access-redacted" })).rejects.toThrow(
      /Cursor AvailableModels 401: authentication_error/,
    )
  })

  it("throws on HTTP 403 with Cursor AvailableModels prefix", async () => {
    globalThis.fetch = (async () =>
      new Response("forbidden", { status: 403 })) as unknown as typeof fetch
    await expect(listCursorLiveModels({ kind: "oauth", token: "access-redacted" })).rejects.toThrow(
      /Cursor AvailableModels 403: forbidden/,
    )
  })

  it("returns [] on non-auth HTTP errors without throwing", async () => {
    globalThis.fetch = (async () =>
      new Response("upstream_bug", { status: 500 })) as unknown as typeof fetch
    expect(await listCursorLiveModels({ kind: "oauth", token: "access-redacted" })).toEqual([])
  })
})
