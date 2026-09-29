/**
 * When AvailableModels returns one server variant but parameterDefinitions
 * advertise a full effort(+fast) ladder, expandCursorCatalog must synthesize
 * the missing exploded SKU rows (CLI GetUsableModels coverage).
 */
import { describe, expect, test } from "bun:test"

import { expandCursorCatalog } from "./catalog-expand.ts"
import type { DecodedCursorModel } from "./proto/models-decode.ts"

function parentWithSparseVariants(model: DecodedCursorModel) {
  return expandCursorCatalog(
    { modelNames: [], models: [model], useModelParameters: true },
    { includeHidden: true },
  )
}

describe("expandCursorCatalog sparse variant synthesis", () => {
  test("grok-4.7 synthesizes effort x fast SKUs and prefers medium default", () => {
    const rows = parentWithSparseVariants({
      name: "grok-4.7",
      clientDisplayName: "Grok 4.7",
      supportsThinking: true,
      supportsImages: false,
      supportsMaxMode: true,
      defaultOn: true,
      contextTokenLimit: 256_000,
      parameterDefinitions: [
        {
          id: "reasoning_effort",
          name: "Effort",
          enumValues: [
            { value: "low" },
            { value: "medium" },
            { value: "high" },
            { value: "xhigh" },
          ],
        },
        {
          id: "fast",
          name: "fast",
          booleanValues: [{ value: "true" }, { value: "false" }],
        },
        {
          id: "context",
          name: "context",
          enumValues: [{ value: "256k" }],
        },
      ],
      variants: [
        {
          legacySlug: "grok-4.7-high-fast",
          isDefaultNonMaxConfig: true,
          parameterValues: [
            { id: "context", value: "256k" },
            { id: "reasoning_effort", value: "high" },
            { id: "fast", value: "true" },
          ],
        },
      ],
    })

    const ids = new Set(rows.map((r) => r.id))
    for (const effort of ["low", "medium", "high", "xhigh"]) {
      expect(ids.has(`cursor-grok-4.7-${effort}`)).toBe(true)
      expect(ids.has(`cursor-grok-4.7-${effort}-fast`)).toBe(true)
    }

    const parent = rows.find((r) => r.id === "cursor-grok-4.7")
    expect(parent?.defaultRunModelId).toBe("grok-4.7-medium")

    const medium = rows.find((r) => r.id === "cursor-grok-4.7-medium")
    expect(medium?.parentWireId).toBe("grok-4.7")
    expect(medium?.parameterValues).toEqual(
      expect.arrayContaining([
        { id: "reasoning_effort", value: "medium" },
        { id: "context", value: "256k" },
      ]),
    )
    expect(medium?.parameterValues?.some((p) => p.id === "fast" && p.value === "true")).toBe(false)
  })

  test("gemini-3.8-flash synthesizes effort-only SKUs", () => {
    const rows = parentWithSparseVariants({
      name: "gemini-3.8-flash",
      clientDisplayName: "Gemini 3.8 Flash",
      supportsThinking: true,
      supportsImages: true,
      parameterDefinitions: [
        {
          id: "reasoning_effort",
          name: "Effort",
          enumValues: [{ value: "low" }, { value: "medium" }, { value: "high" }],
        },
      ],
      variants: [
        {
          legacySlug: "gemini-3.8-flash-high",
          isDefaultNonMaxConfig: true,
          parameterValues: [{ id: "reasoning_effort", value: "high" }],
        },
      ],
    })
    const ids = new Set(rows.map((r) => r.id))
    expect(ids.has("cursor-gemini-3.8-flash-low")).toBe(true)
    expect(ids.has("cursor-gemini-3.8-flash-medium")).toBe(true)
    expect(ids.has("cursor-gemini-3.8-flash-high")).toBe(true)
    expect(ids.has("cursor-gemini-3.8-flash-low-fast")).toBe(false)
    const parent = rows.find((r) => r.id === "cursor-gemini-3.8-flash")
    expect(parent?.defaultRunModelId).toBe("gemini-3.8-flash-medium")
  })

  test("claude-sonnet-5-5 synthesizes effort ladder including max", () => {
    const rows = parentWithSparseVariants({
      name: "claude-sonnet-5-5",
      clientDisplayName: "Claude Sonnet 5.5",
      supportsThinking: false,
      parameterDefinitions: [
        {
          id: "reasoning_effort",
          name: "Effort",
          enumValues: [
            { value: "low" },
            { value: "medium" },
            { value: "high" },
            { value: "xhigh" },
            { value: "max" },
          ],
        },
        {
          id: "context",
          name: "context",
          enumValues: [{ value: "300k" }],
        },
      ],
      variants: [
        {
          legacySlug: "claude-sonnet-5-5-high",
          isDefaultNonMaxConfig: true,
          parameterValues: [
            { id: "context", value: "300k" },
            { id: "reasoning_effort", value: "high" },
          ],
        },
      ],
    })
    const ids = new Set(rows.map((r) => r.id))
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      expect(ids.has(`cursor-claude-sonnet-5-5-${effort}`)).toBe(true)
    }
    const parent = rows.find((r) => r.id === "cursor-claude-sonnet-5-5")
    expect(parent?.defaultRunModelId).toBe("claude-sonnet-5-5-medium")
  })
})
