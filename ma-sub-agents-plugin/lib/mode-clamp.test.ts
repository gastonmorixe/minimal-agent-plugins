/** Tests for the pure mode clamp (SPEC T2, T8). */
import { describe, expect, it } from "bun:test"

import type { HostPolicySnapshot, ModePolicyEntry } from "./host-types.ts"
import { allows, clampMode, clampWithoutSnapshot } from "./mode-clamp.ts"

const ASK: ModePolicyEntry = {
  id: "ask",
  permissions: { allow: ["*"], deny: ["Edit", "Write"] },
}
const PLAN: ModePolicyEntry = {
  id: "plan",
  permissions: { allow: ["*"], deny: ["Bash", "Write"] },
}
const READONLY: ModePolicyEntry = {
  id: "readonly",
  permissions: { allow: ["Read", "Grep"], deny: [] },
}

function snap(
  active: string | null,
  modes: ModePolicyEntry[] = [ASK, PLAN, READONLY],
): HostPolicySnapshot {
  return { activeModeId: active, modes, tools: { kind: "all" } }
}

describe("allows", () => {
  it("no mode allows every tool", () => {
    expect(allows(null, "Edit")).toBe(true)
  })
  it("exact deny wins over wildcard allow", () => {
    expect(allows(ASK.permissions, "Edit")).toBe(false)
    expect(allows(ASK.permissions, "Read")).toBe(true)
  })
  it("no match is denied", () => {
    expect(allows(READONLY.permissions, "Bash")).toBe(false)
  })
})

describe("clampMode (T2)", () => {
  it("lead ask, role none: worker gets ask (lowered)", () => {
    expect(clampMode("none", snap("ask"))).toEqual({ mode: "ask", lowered: true })
  })

  it("lead none, role ask: worker keeps ask", () => {
    expect(clampMode("ask", snap(null))).toEqual({ mode: "ask", lowered: false })
  })

  it("incomparable modes: worker gets the lead mode", () => {
    // ask denies Edit but allows Bash. plan denies Bash but allows Edit.
    expect(clampMode("plan", snap("ask"))).toEqual({ mode: "ask", lowered: true })
  })

  it("narrower role mode is kept", () => {
    expect(clampMode("readonly", snap("ask"))).toEqual({ mode: "readonly", lowered: false })
  })

  it("same mode is kept, not lowered", () => {
    expect(clampMode("ask", snap("ask"))).toEqual({ mode: "ask", lowered: false })
  })

  it("role mode unknown to the host: worker gets the lead mode", () => {
    expect(clampMode("mystery", snap("ask"))).toEqual({ mode: "ask", lowered: true })
  })

  it("lead in no mode, role unknown: lead mode is none", () => {
    expect(clampMode("mystery", snap(null))).toEqual({ mode: "none", lowered: true })
  })

  it("role with a wider allow list than the lead is lowered", () => {
    expect(clampMode("ask", snap("readonly"))).toEqual({ mode: "readonly", lowered: true })
  })
})

describe("match (predicate) rules (REVIEW #2)", () => {
  const GUARDED: ModePolicyEntry = {
    id: "guarded",
    permissions: { allow: ["Read"], deny: [], match: ["Edit"] },
  }
  const NO_EDIT: ModePolicyEntry = {
    id: "no-edit",
    permissions: { allow: ["*"], deny: ["Edit"] },
  }

  it("allows answers matchAs for a match rule, exact before wildcard", () => {
    expect(allows(GUARDED.permissions, "Edit", true)).toBe(true)
    expect(allows(GUARDED.permissions, "Edit", false)).toBe(false)
    expect(allows(GUARDED.permissions, "Edit")).toBe(false)
    const wild = { allow: ["Read"], deny: ["Bash"], match: ["*"] }
    expect(allows(wild, "Bash", true)).toBe(false)
    expect(allows(wild, "Read", false)).toBe(true)
    expect(allows(wild, "Write", true)).toBe(true)
  })

  it("tolerates an older core without the match list", () => {
    expect(allows({ allow: ["Read"], deny: [] }, "Edit", true)).toBe(false)
  })

  it("role with a match rule on Edit vs a lead that denies Edit: lowered", () => {
    expect(clampMode("guarded", snap("no-edit", [GUARDED, NO_EDIT]))).toEqual({
      mode: "no-edit",
      lowered: true,
    })
  })

  it("role equal to the lead with match rules: lowered unless the lead allows them", () => {
    const leadSame: ModePolicyEntry = { ...GUARDED, id: "lead-same" }
    expect(clampMode("guarded", snap("lead-same", [GUARDED, leadSame]))).toEqual({
      mode: "lead-same",
      lowered: true,
    })
    const leadAllowsEdit: ModePolicyEntry = {
      id: "lead-edit",
      permissions: { allow: ["Read", "Edit"], deny: [], match: [] },
    }
    expect(clampMode("guarded", snap("lead-edit", [GUARDED, leadAllowsEdit]))).toEqual({
      mode: "guarded",
      lowered: false,
    })
  })

  it("same mode id as the lead is never lowered", () => {
    expect(clampMode("guarded", snap("guarded", [GUARDED]))).toEqual({
      mode: "guarded",
      lowered: false,
    })
  })
})

describe("clampMode (T8: no snapshot, older core)", () => {
  it("lead env mode unset or none: keeps the role mode (best effort)", () => {
    expect(clampMode("none", undefined)).toEqual({ mode: "none", lowered: false })
    expect(clampMode("ask", undefined)).toEqual({ mode: "ask", lowered: false })
    expect(clampMode("none", undefined, "")).toEqual({ mode: "none", lowered: false })
    expect(clampMode("ask", undefined, "none")).toEqual({ mode: "ask", lowered: false })
  })

  it("lead env mode set: a different role mode gets the lead mode", () => {
    expect(clampMode("none", undefined, "ask")).toEqual({ mode: "ask", lowered: true })
    expect(clampMode("mystery", undefined, "plan")).toEqual({ mode: "plan", lowered: true })
    expect(clampWithoutSnapshot(null, "ask")).toEqual({ mode: "ask", lowered: true })
  })

  it("lead env mode equal to the role mode: kept", () => {
    expect(clampMode("ask", undefined, " ask ")).toEqual({ mode: "ask", lowered: false })
  })
})
