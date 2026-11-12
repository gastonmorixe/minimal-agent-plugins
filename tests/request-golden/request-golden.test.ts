/**
 * Request golden test (S0.1). Compares the recorded LLM requests of each
 * scenario with tests/request-golden/goldens/<name>.json.
 * Set UPDATE_REQUEST_GOLDENS=1 to rewrite them.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"

import { describe, expect, it } from "bun:test"

import { GOLDEN_DIR, goldenPath, runScenario } from "./harness.ts"
import { SCENARIOS } from "./scenarios.ts"

const UPDATE = process.env.UPDATE_REQUEST_GOLDENS === "1"

if (UPDATE && process.env.CI) {
  throw new Error("UPDATE_REQUEST_GOLDENS is on while CI is set. Refusing to rewrite goldens.")
}

describe("request goldens", () => {
  it("golden files equal scenario names", () => {
    const files = existsSync(GOLDEN_DIR)
      ? readdirSync(GOLDEN_DIR)
          .filter((f) => f.endsWith(".json"))
          .map((f) => f.slice(0, -5))
          .sort()
      : []
    if (UPDATE) return
    expect(files).toEqual(SCENARIOS.map((s) => s.name).sort())
  })
  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      const actual = await runScenario(scenario)
      const path = goldenPath(scenario.name)
      if (UPDATE) {
        mkdirSync(GOLDEN_DIR, { recursive: true })
        writeFileSync(path, actual)
        return
      }
      if (!existsSync(path)) {
        throw new Error(`missing golden ${path}. Run with UPDATE_REQUEST_GOLDENS=1.`)
      }
      const expected = readFileSync(path, "utf8")
      if (actual !== expected) {
        throw new Error(
          `request golden "${scenario.name}" differs (${expected.length} -> ${actual.length} bytes). ` +
            `If the change is intended, run: UPDATE_REQUEST_GOLDENS=1 bun test tests/request-golden`,
        )
      }
      expect(actual).toBe(expected)
    }, 120_000)
  }
})
