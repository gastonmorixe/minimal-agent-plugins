/** Tests for the pure tool clamp (SPEC T3). */
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { canonicalIn, clampTools, KNOWN_PLUGIN_TOOLS, RESULT_TOOLS } from "./tool-clamp.ts"

describe("clampTools (T3)", () => {
  it("lead --tools Read,Grep + role worker: Read, Grep and the report tool", () => {
    expect(clampTools({ kind: "list", names: ["Read", "Grep"] })).toEqual([
      "Read",
      "Grep",
      ...RESULT_TOOLS,
    ])
  })

  it("lead --no-tools: report tool only", () => {
    expect(clampTools({ kind: "none" })).toEqual([...RESULT_TOOLS])
  })

  it("canonical report tool name comes first", () => {
    expect(RESULT_TOOLS[0]).toBe("SubAgentsReportResult")
  })

  it("lead all + no role list: emit nothing", () => {
    expect(clampTools({ kind: "all" })).toBeUndefined()
  })

  it("lead all + role list: role list plus the report tool", () => {
    expect(clampTools({ kind: "all" }, ["Read"])).toEqual(["Read", ...RESULT_TOOLS])
  })

  it("a role list narrows the lead list and never widens it", () => {
    expect(clampTools({ kind: "list", names: ["Read", "Grep"] }, ["Read", "Edit"])).toEqual([
      "Read",
      ...RESULT_TOOLS,
    ])
  })

  it("a bare role name maps to the canonical lead name", () => {
    expect(clampTools({ kind: "list", names: ["Read", "SubAgentsMailbox"] }, ["Mailbox"])).toEqual([
      "SubAgentsMailbox",
      ...RESULT_TOOLS,
    ])
  })

  it("lead none + role list: report tool only", () => {
    expect(clampTools({ kind: "none" }, ["Read"])).toEqual([...RESULT_TOOLS])
  })

  it("does not duplicate a report tool already in the lead list", () => {
    expect(clampTools({ kind: "list", names: ["SubAgentsReportResult", "Read"] })).toEqual([
      "SubAgentsReportResult",
      "Read",
      "ReportResult",
    ])
  })

  it("a bare role name never suffix-matches another tool (Grep is not FastGrep)", () => {
    expect(canonicalIn(["FastGrep", "Read"], "Grep")).toBeUndefined()
    expect(clampTools({ kind: "list", names: ["FastGrep", "Read"] }, ["Grep", "Read"])).toEqual([
      "Read",
      ...RESULT_TOOLS,
    ])
  })

  it("maps only the known host prefix", () => {
    expect(canonicalIn(["SubAgentsMailbox"], "Mailbox")).toBe("SubAgentsMailbox")
    expect(canonicalIn(["OtherMailbox"], "Mailbox")).toBeUndefined()
  })

  it("lead all + role list: bare plugin names become canonical", () => {
    expect(clampTools({ kind: "all" }, ["SpawnAgent", "Read", "ReportResult"])).toEqual([
      "SubAgentsSpawnAgent",
      "Read",
      "SubAgentsReportResult",
      "ReportResult",
    ])
  })
})

describe("KNOWN_PLUGIN_TOOLS", () => {
  it("matches the manifest tools with the SubAgents prefix", () => {
    const raw = readFileSync(join(import.meta.dir, "..", "manifest.json"), "utf8")
    const m = JSON.parse(raw) as {
      headless: { tools: { trigger: { tool?: { name?: string } } }[] }
    }
    const names = m.headless.tools.map((t) => `SubAgents${t.trigger.tool?.name ?? ""}`)
    expect([...KNOWN_PLUGIN_TOOLS].sort()).toEqual(names.sort())
  })
})
