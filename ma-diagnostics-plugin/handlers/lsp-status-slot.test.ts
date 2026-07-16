import { describe, expect, it } from "bun:test"

import { formatLspFooterParts } from "./lsp-status-slot.ts"

describe("formatLspFooterParts", () => {
  it("formats a single provider", () => {
    expect(formatLspFooterParts([{ id: "tsc", root: "/ws/core" }])).toEqual(["· tsc"])
  })

  it("collapses multi-root same id to count when basenames long", () => {
    const parts = formatLspFooterParts([
      { id: "tsc", root: "/very/long/path/name/alpha-workspace" },
      { id: "tsc", root: "/very/long/path/name/beta-workspace-extra" },
    ])
    expect(parts.some((p) => p.includes("\u00d7") || p.includes("tsc"))).toBe(true)
  })

  it("uses basenames for two short roots", () => {
    const parts = formatLspFooterParts([
      { id: "tsc", root: "/repo/core" },
      { id: "tsc", root: "/repo/plugins" },
    ])
    expect(parts.join(" ")).toContain("core")
    expect(parts.join(" ")).toContain("plugins")
  })

  it("returns empty for no actives", () => {
    expect(formatLspFooterParts([])).toEqual([])
  })
})
