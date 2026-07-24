import { afterEach, describe, expect, it } from "bun:test"

import { deriveCursorCapabilities } from "./capabilities.ts"
import { listCursorLiveModels, mapCursorLiveModels } from "./live-models.ts"
import { decodeAvailableModel, decodeAvailableModelsResponse } from "./proto/models-decode.ts"
import {
  concat,
  encBool,
  encMsg,
  encRepeatedString,
  encString,
  encVarintField,
} from "./proto/wire.ts"

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
    encMsg(30, variant),
    encRepeatedString(37, ["composer-test-alias"]),
    encVarintField(44, 2),
    encVarintField(44, 3),
  )
}

function syntheticResponse(): Uint8Array {
  return concat(
    encRepeatedString(1, ["legacy-only"]),
    encMsg(2, syntheticModel()),
    encBool(11, true),
  )
}

describe("Cursor AvailableModels decoder", () => {
  it("decodes rich model flags, aliases, variants, and effort modes", () => {
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
      cloudAgentEffortModes: [2, 3],
    })
    expect(model.variants?.[0]?.variantStringRepresentation).toBe("composer-test-high")
  })

  it("maps the response to deterministic live rows including aliases and variants", () => {
    const decoded = decodeAvailableModelsResponse(syntheticResponse())
    expect(decoded.useModelParameters).toBe(true)
    // Host ids are namespaced `cursor-…` to avoid Grok alias collisions.
    expect(mapCursorLiveModels(decoded)).toEqual([
      { id: "cursor-composer-test", displayName: "Composer Test" },
      { id: "cursor-composer-test-alias", displayName: "Composer Test" },
      { id: "cursor-composer-test-high", displayName: "High" },
      { id: "cursor-legacy-only", displayName: "legacy-only" },
    ])
  })

  it("derives context, thinking, image, and effort capability data", () => {
    const capabilities = deriveCursorCapabilities(decodeAvailableModel(syntheticModel()))
    expect(capabilities.contextWindow).toBe(400_000)
    expect(capabilities.thinking.visible).toBe(true)
    expect(capabilities.modalities.image).toBe(true)
    expect(capabilities.effort.levels).toEqual(["2", "3"])
    expect(capabilities.tools.userDefined).toBe(true)
  })
})

describe("listCursorLiveModels", () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it("fetches the authenticated protobuf catalog", async () => {
    let sawAuthorization = ""
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      sawAuthorization = headers.get("authorization") ?? ""
      return new Response(syntheticResponse(), {
        status: 200,
        headers: { "content-type": "application/proto" },
      })
    }) as unknown as typeof fetch
    const rows = await listCursorLiveModels({ kind: "oauth", token: "access-redacted" })
    expect(sawAuthorization).toBe("Bearer access-redacted")
    expect(rows.some((row) => row.id === "cursor-composer-test")).toBe(true)
  })

  it("returns [] on network or protocol failure", async () => {
    globalThis.fetch = (async () => {
      throw new Error("offline")
    }) as unknown as typeof fetch
    expect(await listCursorLiveModels({ kind: "oauth", token: "access-redacted" })).toEqual([])
  })
})
