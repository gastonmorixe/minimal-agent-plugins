/**
 * Design 40 step 10: the tags of this provider come from the sideband API
 * (third argument `sb` of `text`). With the real codec the bytes stay; with
 * no codec (`NO_SIDEBAND`) or no `sb` the tag kinds give "" and leave no
 * stray separator.
 */

import { describe, expect, test } from "bun:test"

import { NO_SIDEBAND } from "@minimal-agent/core/host/sideband"

import { pluginSideband } from "../tests/support/sideband.ts"

import { createCoreToolsSyntheticProvider } from "./synthetic-text.ts"

const p = createCoreToolsSyntheticProvider()
const sb = await pluginSideband()

describe("core-tools synthetic tags come from the sideband API", () => {
  test("real codec: each tag is one node of its kind with the fact attrs", () => {
    const one = (text: string, kind: string) => {
      const nodes = sb.find(text)
      expect(nodes.map((n) => n.kind)).toEqual([kind])
      expect(nodes[0]?.span).toEqual({ start: 0, end: text.length })
      return sb.attrs(nodes[0]!)
    }
    const stamp = p.text("mode.active_stamp", { id: "ask", since: "T" }, sb)
    expect(stamp).toBe(sb.render("mode-active", { attrs: { id: "ask", since: "T" } }))
    expect(one(stamp, "mode-active")).toEqual({ id: "ask", since: "T" })
    const change = p.text("mode.change", { from: "default", to: "ask", at: "T" }, sb)
    expect(one(change, "mode-change")).toEqual({ from: "default", to: "ask", at: "T" })
    const facts = { shown: 10, total: 51, tool: "Bash", bash: true, rawPath: "/p" }
    const preview = p.text("tool_output.preview", facts, sb)
    expect(one(preview, "output-preview")).toEqual({
      shown: 10,
      total: 51,
      tool: "Bash",
      path: "/p",
    })
    expect(sb.find(preview)[0]?.body).toContain("The harness saved the full output at /p.")
  })
  test("NO_SIDEBAND and no sb: the tag kinds give an empty text", () => {
    for (const s of [NO_SIDEBAND, undefined]) {
      expect(p.text("mode.active_stamp", { id: "ask", since: "T" }, s)).toBe("")
      expect(p.text("mode.change", { from: "a", to: "b", at: "T" }, s)).toBe("")
      expect(p.text("tool_output.preview", { shown: 1, total: 2, tool: "Read" }, s)).toBe("")
    }
  })
  test("NO_SIDEBAND: a missing fact still throws", () => {
    expect(() => p.text("mode.change", { from: "a" }, NO_SIDEBAND)).toThrow()
    expect(() => p.text("tool_output.preview", { shown: 1 }, NO_SIDEBAND)).toThrow()
  })
  test("a kind with no tag does not need sb", () => {
    expect(p.text("tool_text.Grep.no_matches", {}, NO_SIDEBAND)).toBe("No matches found.")
  })
})
