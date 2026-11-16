/**
 * C50: byte parity between this plugin and the core engine.
 *
 * The core engine outputs were captured once into
 * `__fixtures__/core-engine-parity.json` (see `__fixtures__/capture-core-parity.ts`).
 * Each case holds the template text, so this test reads no prompt asset from
 * disk and imports nothing from core.
 */

import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import createProvider, { clearProviderCache } from "./provider.ts"
import { renderTemplate } from "./template.ts"

/** Floor so an empty fixture fails the test. */
const ASSET_FLOOR = 30

interface Case {
  name: string
  input: { path: string; text: string }
  vars: Record<string, string>
  output?: string
  error?: { missing: string[]; message: string }
}

const fixture = (await Bun.file(
  join(import.meta.dir, "__fixtures__", "core-engine-parity.json"),
).json()) as {
  assets: number
  cases: Case[]
}

type Outcome =
  | { ok: true; text: string }
  | { ok: false; err: { missing: string[]; message: string } }

function plugin(c: Case, vars: Record<string, string> = c.vars): Outcome {
  try {
    return { ok: true, text: renderTemplate(c.input.text, vars, { source: c.input.path }) }
  } catch (err) {
    return { ok: false, err: err as { missing: string[]; message: string } }
  }
}

function expectSame(c: Case): void {
  const got = plugin(c)
  if (c.error === undefined) {
    expect(got.ok).toBe(true)
    if (got.ok) expect(Buffer.from(got.text).equals(Buffer.from(c.output ?? ""))).toBe(true)
    return
  }
  expect(got.ok).toBe(false)
  if (!got.ok) {
    expect(got.err.missing).toEqual(c.error.missing)
    expect(got.err.message).toBe(c.error.message)
  }
}

describe("C50 parity with the core engine (captured fixture)", () => {
  test("asset count is above the floor", () => {
    expect(fixture.assets).toBeGreaterThanOrEqual(ASSET_FLOOR)
    const paths = new Set(fixture.cases.map((c) => c.input.path))
    expect(paths.size).toBe(fixture.assets)
  })

  for (const c of fixture.cases) {
    const [variant] = c.name.split(":")
    const label = c.input.path

    if (variant === "A") {
      test(`A all vars set: ${label}`, () => expectSame(c))
    } else if (variant === "B") {
      test(`B optional absent: ${label}`, () => expectSame(c))
      test(`twice is stable (R-TPL-6): ${label}`, () => {
        const a = plugin(c)
        const b = plugin(c)
        expect(a.ok && b.ok).toBe(true)
        if (a.ok && b.ok) expect(Buffer.from(a.text).equals(Buffer.from(b.text))).toBe(true)
      })
    } else if (variant === "C") {
      test(`C one required absent: ${label}`, () => {
        expect(c.error).toBeDefined()
        expectSame(c)
      })
    } else {
      test(`unknown case kind: ${c.name}`, () => {
        throw new Error(`unknown case kind in fixture: ${c.name}`)
      })
    }
  }

  test("provider.render matches core for every plugin asset", () => {
    const provider = createProvider()
    const marker = "/prompts/"
    let n = 0
    for (const c of fixture.cases) {
      if (!c.name.startsWith("B:") || c.input.path.startsWith("minimal-agent-core/")) continue
      const at = c.input.path.indexOf(marker)
      if (at < 0) continue
      const pluginDir = c.input.path.slice(0, at)
      const name = c.input.path.slice(at + marker.length)
      clearProviderCache()
      const got = provider.render({
        pluginId: pluginDir.split("/").pop() ?? pluginDir,
        pluginDir: join("/parity-fixture", pluginDir),
        name,
        vars: c.vars,
        readText: () => c.input.text,
      })
      expect(c.error).toBeUndefined()
      expect(Buffer.from(got).equals(Buffer.from(c.output ?? ""))).toBe(true)
      n++
    }
    expect(n).toBeGreaterThan(0)
  })
})
