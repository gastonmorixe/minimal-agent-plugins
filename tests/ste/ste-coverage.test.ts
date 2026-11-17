/**
 * Coverage gate: every string the model can read must be a surface.
 *
 * The STE rules only judge a surface. If a new prompt shape appears and the
 * surface finder does not know it, the rules pass it in silence. That happened
 * once: the tool `PARAMS` map keys each description by a property name, not by
 * `description:`, and 30 model-facing strings were never audited.
 *
 * This test reads one wide request golden and proves that every `description`
 * in its `tools[]` matches some surface, unless the string is on the
 * allowlist below with a reason.
 *
 * @module tests/ste/ste-coverage.test
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { allSurfaces, CORE_ROOT, coreSurfaces, PLUGINS_ROOT } from "./surfaces.ts"

/** A golden with the full built-in tool block plus the plugin fixture tools. */
const GOLDEN = join(PLUGINS_ROOT, "tests/request-golden/goldens/plugin-handler-throws.json")

/**
 * Strings that reach the model but are not prompt text, so STE does not apply.
 * Each entry needs a reason. Keep this list short.
 */
const ALLOWED: ReadonlyArray<readonly [string, string]> = [
  ["Test fixture tool. Always fails.", "test fixture manifest, not shipped text"],
]

/** Every `description` string in a JSON value. */
function descriptions(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) descriptions(item, out)
    return
  }
  if (!value || typeof value !== "object") return
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "description" && typeof child === "string") out.add(child)
    else descriptions(child, out)
  }
}

describe("STE coverage", () => {
  test("every tool description in a golden is a known surface", () => {
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as unknown
    const texts = new Set<string>()
    descriptions(golden, texts)

    const covered = new Set(
      [...allSurfaces(PLUGINS_ROOT), ...coreSurfaces(CORE_ROOT)].map((s) => s.text.trim()),
    )
    const allowed = new Map(ALLOWED)
    const missing = [...texts].filter((t) => !covered.has(t.trim()) && !allowed.has(t))

    expect(texts.size).toBeGreaterThan(200)
    expect(missing).toEqual([])
  })

  test("the allowlist is not stale", () => {
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as unknown
    const texts = new Set<string>()
    descriptions(golden, texts)
    const covered = new Set(
      [...allSurfaces(PLUGINS_ROOT), ...coreSurfaces(CORE_ROOT)].map((s) => s.text.trim()),
    )
    for (const [text] of ALLOWED) {
      // A stale allowlist hides a real gap, so an entry must still be needed.
      expect(covered.has(text.trim()), `allowlist entry is now covered: ${text}`).toBe(false)
      expect(texts.has(text), `allowlist entry is gone from the golden: ${text}`).toBe(true)
    }
  })

  test("the tool param map is a surface", () => {
    // The concrete regression: a `PARAMS` value must be audited.
    const toolText = allSurfaces(PLUGINS_ROOT).filter((s) =>
      s.file.endsWith("ma-core-tools-plugin/tool-text.ts"),
    )
    expect(toolText.length).toBeGreaterThanOrEqual(30)
    // Pin one PARAMS value by its text, so a scanner that drops the map fails.
    expect(toolText.some((s) => s.text.includes("The time limit in milliseconds"))).toBe(true)
  })

  test("the core binary guard param is a surface", () => {
    const core = coreSurfaces(CORE_ROOT)
    if (core.length === 0) return
    expect(core.some((s) => s.file.endsWith("binary-guard.ts"))).toBe(true)
  })
})
