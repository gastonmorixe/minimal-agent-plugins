import { describe, expect, it } from "bun:test"

import { getLibrary, libraryNames, resolveDefinition } from "./library.ts"
import { testRender } from "./prompt-test-render.ts"

describe("library specialists", () => {
  it("ships the expected named specialists, resolvable by name", () => {
    for (const name of ["explorer", "planner", "worker", "reviewer", "integrator", "log-miner"]) {
      expect(resolveDefinition(name, testRender)?.name ?? "MISSING").toBe(name)
    }
    expect(resolveDefinition("ghost", testRender)).toBeUndefined()
    expect(libraryNames(testRender)).toContain("log-miner")
  })

  it("is MODEL-AGNOSTIC: no specialist hardcodes a model or effort", () => {
    for (const def of getLibrary(testRender)) {
      expect(def.model).toBeUndefined()
      expect(def.effort).toBeUndefined()
      // every specialist carries an abstract role instead
      expect(["scout", "balanced", "deep"]).toContain(def.role ?? "")
    }
  })

  it("explorer is a scout; reviewer + log-miner are deep", () => {
    expect(resolveDefinition("explorer", testRender)?.role).toBe("scout")
    expect(resolveDefinition("reviewer", testRender)?.role).toBe("deep")
    expect(resolveDefinition("log-miner", testRender)?.role).toBe("deep")
  })

  it("explorer + log-miner prompts carry output-hygiene + anti-prompt-injection guidance", () => {
    for (const name of ["explorer", "log-miner"]) {
      const p = resolveDefinition(name, testRender)?.systemPrompt ?? ""
      expect(p.toLowerCase()).toContain("never")
      // treat file/log content as DATA, not instructions
      expect(p).toMatch(/data|instructions addressed to you/i)
    }
  })

  it("read-only specialists run in ask mode (Edit/Write denied at dispatch, not prompt-only)", () => {
    for (const name of ["explorer", "planner", "reviewer", "log-miner"]) {
      expect(resolveDefinition(name, testRender)?.mode).toBe("ask")
    }
  })

  it("implementer specialists are writable (no ask mode → defaults to none in the service)", () => {
    for (const name of ["worker", "integrator"]) {
      expect(resolveDefinition(name, testRender)?.mode).toBeUndefined()
    }
  })
})
