import { beforeAll, describe, expect, test } from "bun:test"

import {
  NO_SIDEBAND,
  type SidebandApi,
  SidebandKindUnknownError,
} from "@minimal-agent/core/host/sideband"

import { pluginSideband } from "../tests/support/sideband.ts"

import createProvider from "./provider.ts"
import { PromptTemplateError, PromptTemplateSyntaxError } from "./template.ts"

// design 50 sections 1 and 3: `expand(text, ctx)` runs the call engine.
describe("provider.expand with a context", () => {
  const p = createProvider()
  let sb: SidebandApi
  beforeAll(async () => {
    sb = await pluginSideband()
  })

  test("no ctx: identity (old callers)", () => {
    expect(p.expand("a %%sideband:tag raw-output%% %%x%%")).toBe(
      "a %%sideband:tag raw-output%% %%x%%",
    )
  })
  test("plain %%var%% keeps the old fill behavior, no trim", () => {
    expect(p.expand(" home %%agentHome%%/x \n", { vars: { agentHome: "/h" }, sideband: sb })).toBe(
      " home /h/x \n",
    )
    expect(() => p.expand("%%nope%%", { vars: {}, sideband: sb })).toThrow(PromptTemplateError)
  })
  // The exact bytes of each part are pinned in the codec parity suite
  // (`ma-sideband-plugin/lib/parity.test.ts`, "open output-preview equals the
  // prompt text bytes today"). These tests prove that the engine gives the
  // kind, the attrs and the var values of the token to the codec unchanged.
  test("real codec: open output-preview gives the prompt bytes of today", () => {
    const t = '%%sideband:open output-preview shown="N" total="M" tool="X"%%'
    const out = p.expand(t, { vars: {}, sideband: sb })
    expect(out).toBe(sb.open("output-preview", { attrs: { shown: "N", total: "M", tool: "X" } }))
    // The codec is live (not the no-codec fallback) and the attrs are in the text.
    expect(out).not.toBe("")
    expect(out).toContain(`${sb.name("output-preview")} shown="N" total="M" tool="X"`)
  })
  test("real codec: tag, close, name, example", () => {
    const ctx = { vars: { n: 3 }, sideband: sb }
    const tag = p.expand('%%sideband:tag raw-output path="<abs-path>" size=@n%%', ctx)
    expect(tag).toBe(sb.render("raw-output", { attrs: { path: "<abs-path>", size: 3 } }))
    expect(tag).toContain(`${sb.name("raw-output")} path="<abs-path>" size="3"`)
    const close = p.expand("%%sideband:close output-preview%%", ctx)
    expect(close).toBe(sb.close("output-preview"))
    expect(close).toContain(sb.name("output-preview"))
    expect(p.expand("%%sideband:name output-preview%%", ctx)).toBe("ma::agent::output-preview")
    expect(p.expand("%%sideband:example raw-output%%", ctx)).toBe(sb.example("raw-output"))
  })
  test("real codec: unknown kind throws SidebandKindUnknownError", () => {
    expect(() => p.expand("%%sideband:tag no-such-kind%%", { vars: {}, sideband: sb })).toThrow(
      SidebandKindUnknownError,
    )
  })
  test("malformed token throws PromptTemplateSyntaxError", () => {
    expect(() => p.expand("%%sideband:tag%%", { vars: {}, sideband: sb })).toThrow(
      PromptTemplateSyntaxError,
    )
  })
  test("no codec (NO_SIDEBAND): each op gives the kind name", () => {
    const t = "line: `%%sideband:tag raw-output%%`, `%%sideband:open memory%%`."
    expect(p.expand(t, { vars: {}, sideband: NO_SIDEBAND })).toBe("line: `raw-output`, `memory`.")
  })
  test("a var value is not scanned again", () => {
    expect(p.expand("%%a%%", { vars: { a: "%%sideband:tag raw-output%%" }, sideband: sb })).toBe(
      "%%sideband:tag raw-output%%",
    )
  })
})
