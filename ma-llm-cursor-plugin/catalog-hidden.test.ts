/**
 * Hidden AvailableModels parents stay resolvable offline but never become
 * picker choices or the registry default.
 */
import { describe, expect, test } from "bun:test"

import { mapCursorLiveModels } from "./live-models.ts"
import { registerCursorModels } from "./models.ts"
import { CURSOR_STATIC_CATALOG } from "./static-catalog.ts"

describe("cursor hidden models", () => {
  test("setDefault stays on cursor-auto, never a hidden id", () => {
    const hiddenIds = new Set(
      CURSOR_STATIC_CATALOG.filter((row) => row.isHidden).map((row) => row.id),
    )
    expect(hiddenIds.size).toBeGreaterThan(0)

    let defaultId: string | undefined
    const entries = new Map<string, { tags: string[] }>()
    registerCursorModels({
      register(spec: { id: string; tags?: string[] }) {
        entries.set(spec.id, { tags: spec.tags ?? [] })
      },
      setDefault(id: string) {
        defaultId = id
      },
    } as never)

    expect(defaultId).toBe("cursor-auto")
    expect(hiddenIds.has(defaultId!)).toBe(false)

    // Hidden ids stay registered so AgentService/Run can resolve them.
    const sampleHidden = [...hiddenIds][0]!
    expect(entries.has(sampleHidden)).toBe(true)

    for (const id of hiddenIds) {
      const entry = entries.get(id)
      expect(entry?.tags.includes("hidden")).toBe(true)
      expect(id).not.toBe(defaultId)
    }
  })

  test("mapCursorLiveModels omits isHidden parents", () => {
    const rows = mapCursorLiveModels({
      modelNames: [],
      useModelParameters: true,
      models: [
        {
          name: "visible-model",
          clientDisplayName: "Visible",
          isHidden: false,
        },
        {
          name: "secret-lab-model",
          clientDisplayName: "Secret Lab",
          isHidden: true,
          variants: [
            {
              legacySlug: "secret-lab-model-high",
              parameterValues: [{ id: "effort", value: "high" }],
            },
          ],
        },
      ],
    })
    const ids = rows.map((r) => r.id)
    expect(ids).toContain("cursor-visible-model")
    expect(ids).not.toContain("cursor-secret-lab-model")
    expect(ids).not.toContain("cursor-secret-lab-model-high")
  })
})
