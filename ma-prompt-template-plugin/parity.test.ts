/**
 * C50: byte parity between this plugin and the core engine over every
 * prompt asset found at test time.
 */

import { readFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"

import { describe, expect, test } from "bun:test"

import { clearPromptCache, renderPrompt } from "../../minimal-agent-core/src/prompts/prompts.ts"

import createProvider, { clearProviderCache, renderFile } from "./provider.ts"
import { PLACEHOLDER_RE } from "./template.ts"

const PLUGINS_ROOT = join(import.meta.dir, "..")
const CORE_PROMPTS = join(PLUGINS_ROOT, "..", "minimal-agent-core", "src", "prompts")

/** Floor so an empty glob fails the test. */
const ASSET_FLOOR = 30

const SKIP = new Set(["README.md", "PROMPT.md"])

function scan(cwd: string, pattern: string): string[] {
  const out: string[] = []
  for (const rel of new Bun.Glob(pattern).scanSync({ cwd, onlyFiles: true })) {
    if (rel.split("/").includes("node_modules")) continue
    if (SKIP.has(basename(rel))) continue
    out.push(join(cwd, rel))
  }
  return out
}

const assets = [
  ...scan(CORE_PROMPTS, "**/*.md"),
  ...scan(PLUGINS_ROOT, "ma-*/prompts/**/*.md"),
  ...scan(join(import.meta.dir, "fixtures"), "prompts/**/*.md"),
].sort()

interface Names {
  required: string[]
  optional: string[]
}

function names(text: string): Names {
  const required = new Set<string>()
  const optionalSeen = new Set<string>()
  for (const m of text.matchAll(new RegExp(PLACEHOLDER_RE.source, "g"))) {
    const name = m[1] ?? ""
    if (m[2]) optionalSeen.add(name)
    else required.add(name)
  }
  return {
    required: [...required],
    optional: [...optionalSeen].filter((n) => !required.has(n)),
  }
}

type Vars = Record<string, string>

function fixed(list: string[]): Vars {
  return Object.fromEntries(list.map((n) => [n, `v:${n}`]))
}

function outcome(fn: () => string): { ok: true; text: string } | { ok: false; err: unknown } {
  try {
    return { ok: true, text: fn() }
  } catch (err) {
    return { ok: false, err }
  }
}

function runBoth(abs: string, vars: Vars) {
  clearPromptCache()
  clearProviderCache()
  const core = outcome(() => renderPrompt(abs, vars))
  const plug = outcome(() => renderFile(abs, vars))
  return { core, plug }
}

function expectSame(abs: string, vars: Vars): void {
  const { core, plug } = runBoth(abs, vars)
  if (core.ok && plug.ok) {
    expect(Buffer.from(plug.text).equals(Buffer.from(core.text))).toBe(true)
    return
  }
  expect(core.ok).toBe(false)
  expect(plug.ok).toBe(false)
  if (!core.ok && !plug.ok) {
    const c = core.err as { missing: string[]; message: string }
    const p = plug.err as { missing: string[]; message: string }
    expect(p.missing).toEqual(c.missing)
    expect(p.message).toBe(c.message)
  }
}

describe("C50 parity with the core engine", () => {
  test("asset count is above the floor", () => {
    expect(assets.length).toBeGreaterThanOrEqual(ASSET_FLOOR)
  })

  for (const abs of assets) {
    const label = abs.slice(join(PLUGINS_ROOT, "..").length + 1)
    const { required, optional } = names(readFileSync(abs, "utf-8"))

    test(`A all vars set: ${label}`, () => {
      expectSame(abs, fixed([...required, ...optional]))
    })

    test(`B optional absent: ${label}`, () => {
      expectSame(abs, fixed(required))
    })

    test(`C one required absent: ${label}`, () => {
      if (required.length === 0) return
      const absent = required[0] ?? ""
      const vars = fixed([...required, ...optional].filter((n) => n !== absent))
      const { core, plug } = runBoth(abs, vars)
      expect(core.ok).toBe(false)
      expect(plug.ok).toBe(false)
      expectSame(abs, vars)
    })

    test(`twice is stable (R-TPL-6): ${label}`, () => {
      const vars = fixed(required)
      const a = runBoth(abs, vars).plug
      const b = runBoth(abs, vars).plug
      expect(a.ok && b.ok).toBe(true)
      if (a.ok && b.ok) expect(Buffer.from(a.text).equals(Buffer.from(b.text))).toBe(true)
    })
  }

  test("provider.render matches core for every plugin asset", () => {
    const provider = createProvider()
    let n = 0
    for (const abs of assets) {
      const marker = "/prompts/"
      const at = abs.indexOf(marker)
      if (at < 0 || abs.startsWith(CORE_PROMPTS)) continue
      const pluginDir = abs.slice(0, at)
      const name = abs.slice(at + marker.length)
      const { required } = names(readFileSync(abs, "utf-8"))
      const vars = fixed(required)
      clearPromptCache()
      const want = renderPrompt(abs, vars)
      const got = provider.render({ pluginId: basename(pluginDir), pluginDir, name, vars })
      expect(Buffer.from(got).equals(Buffer.from(want))).toBe(true)
      expect(dirname(abs)).toContain("prompts")
      n++
    }
    expect(n).toBeGreaterThan(0)
  })
})
