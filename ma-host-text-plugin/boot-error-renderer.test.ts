import { describe, expect, test } from "bun:test"

import {
  ContractCheckFailedError,
  type CoreErrorJson,
  createErrorRendererRegistry,
} from "@minimal-agent/core/errors"

import { createBootErrorRenderer } from "./boot-error-renderer.ts"
import { createDevErrorRenderer, HOST_TEXT_PLUGIN_ID } from "./dev-error-renderer.ts"

describe("boot error renderer", () => {
  test("names every missing and duplicated contract", () => {
    const e = new ContractCheckFailedError(
      ["text.tools", "synthetic:mode.change"],
      ["prompts.template"],
    )
    const text = createBootErrorRenderer().render(e.toJSON())
    expect(text).toContain("text.tools")
    expect(text).toContain("synthetic:mode.change")
    expect(text).toContain("prompts.template")
    expect(text).toContain("missing")
    expect(text).toContain("duplicated")
  })

  test("declines another kind", () => {
    const other: CoreErrorJson = { kind: "Other", fields: {} }
    expect(createBootErrorRenderer().render(other)).toBeUndefined()
  })

  test("wins over the dev renderer in the registry for its kind", () => {
    const reg = createErrorRendererRegistry()
    reg.register(createDevErrorRenderer(), HOST_TEXT_PLUGIN_ID)
    reg.register(createBootErrorRenderer(), HOST_TEXT_PLUGIN_ID)
    const json = JSON.parse(JSON.stringify(new ContractCheckFailedError(["text.tools"], [])))
    expect(reg.render(json)).toContain("missing (no plugin provides them): text.tools")
    expect(reg.render({ kind: "K", fields: {} })).toBe("K {}")
  })
})
