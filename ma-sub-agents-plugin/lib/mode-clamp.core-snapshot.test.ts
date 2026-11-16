/**
 * R7 end to end through the REAL core snapshot (review #17): a core
 * `ModeManager` built from the shipped ask-mode manifest produces the
 * `policySnapshot()` the plugin clamp reads. Each decision is checked against
 * core's own `isToolAllowedByPermissions`, so the clamp can never keep a role
 * mode that core lets do more than the lead.
 *
 * Tests may import core (plugin runtime code may not); see the
 * ma-llm-openai-plugin tests for precedent.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import {
  isToolAllowedByPermissions,
  ModeManager,
  type ModeUserOverride,
} from "@minimal-agent/core/host-kit/modes"
import type { ManifestMode } from "@minimal-agent/core/plugin-api/types/plugin"

import { clampMode } from "./mode-clamp.ts"

/** The ask mode exactly as `ma-ask-mode-plugin` ships it. */
const SHIPPED_ASK = (
  JSON.parse(
    readFileSync(join(import.meta.dir, "..", "..", "ma-ask-mode-plugin", "manifest.json"), "utf8"),
  ) as { headless: { modes: ManifestMode[] } }
).headless.modes[0] as ManifestMode

/** JSON manifests ship the old `{ allow, deny }` shape. */
function legacy(p: { allow?: string[]; deny?: string[] }): ManifestMode["permissions"] {
  return p as unknown as ManifestMode["permissions"]
}

/** Read-only lead mode from review #1: Read and Grep only. */
const RO: ManifestMode = { id: "ro", permissions: legacy({ allow: ["Read", "Grep"], deny: ["*"] }) }
/** A role mode that allows Read and Edit only. */
const READ_EDIT: ManifestMode = {
  id: "read-edit",
  permissions: legacy({ allow: ["Read", "Edit"], deny: ["*"] }),
}

const TOOLS = ["Read", "Grep", "Edit", "Write", "Bash", "WebFetch", "SubAgentsReportResult"]

function manager(active: string | null, overrides: Record<string, ModeUserOverride> = {}) {
  return new ModeManager(
    [SHIPPED_ASK, RO, READ_EDIT],
    active,
    "dark",
    undefined,
    (id) => overrides[id] ?? null,
  )
}

/** Core's own answer: does mode `id` (null = no mode) allow `tool`? */
function coreAllows(mm: ModeManager, id: string | null, tool: string): boolean {
  const perms = mm.effectivePermissions(id)
  return perms === null ? true : isToolAllowedByPermissions(tool, perms)
}

/** When the clamp keeps the role mode, core must not let the role do more than the lead. */
function expectConsistent(mm: ModeManager, role: string, kept: string | null): void {
  const lead = mm.activeId()
  const roleId = role === "none" ? null : role
  const widens = TOOLS.filter((t) => coreAllows(mm, roleId, t) && !coreAllows(mm, lead, t))
  if (kept === role) expect(widens).toEqual([])
  else expect(widens.length).toBeGreaterThan(0)
}

describe("mode clamp on a real core policySnapshot (R7)", () => {
  it("shipped ask manifest flattens to allow * / deny Edit, Write", () => {
    const ask = manager("ask")
      .policySnapshot()
      .modes.find((m) => m.id === "ask")
    expect(ask?.permissions).toEqual({ allow: ["*"], deny: ["Edit", "Write"], match: [] })
  })

  it("lead in ask + role none: worker is clamped to ask", () => {
    const mm = manager("ask")
    const snap = mm.policySnapshot()
    expect(snap.activeModeId).toBe("ask")
    const c = clampMode("none", snap)
    expect(c).toEqual({ mode: "ask", lowered: true })
    expectConsistent(mm, "none", c.mode)
  })

  it("lead none + role ask: worker keeps ask", () => {
    const mm = manager(null)
    const snap = mm.policySnapshot()
    expect(snap.activeModeId).toBeNull()
    const c = clampMode("ask", snap)
    expect(c).toEqual({ mode: "ask", lowered: false })
    expectConsistent(mm, "ask", c.mode)
  })

  describe("review #1: ask with a user override allow:[Read, Edit]", () => {
    const overrides = { ask: { permissions: { allow: ["Read", "Edit"] } } }

    it("core lets the overridden ask mode Edit, and the snapshot says so", () => {
      const mm = manager("ask", overrides)
      expect(coreAllows(mm, "ask", "Edit")).toBe(true)
      expect(coreAllows(mm, "ask", "Write")).toBe(false)
      const ask = mm.policySnapshot().modes.find((m) => m.id === "ask")
      expect(ask?.permissions.allow).toContain("Edit")
      expect(ask?.permissions.deny).not.toContain("Edit")
    })

    it("lead = overridden ask, role allows Edit: role kept, matching core", () => {
      const mm = manager("ask", overrides)
      const c = clampMode("read-edit", mm.policySnapshot())
      expect(c).toEqual({ mode: "read-edit", lowered: false })
      expectConsistent(mm, "read-edit", c.mode)
    })

    it("lead = ro, role = overridden ask (can Edit): lowered to ro (was the blocker)", () => {
      const mm = manager("ro", overrides)
      const c = clampMode("ask", mm.policySnapshot())
      expect(c).toEqual({ mode: "ro", lowered: true })
      expectConsistent(mm, "ask", c.mode)
    })
  })

  it("unknown lead mode id fails closed to ask, and the clamp follows it", () => {
    const mm = manager("no-such-mode")
    const snap = mm.policySnapshot()
    expect(snap.activeModeId).toBe("ask")
    expect(clampMode("none", snap)).toEqual({ mode: "ask", lowered: true })
  })
})
