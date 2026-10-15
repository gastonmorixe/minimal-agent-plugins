/**
 * Architecture guard (SPEC-v3 "Hook wiring"):
 * - hook handlers are synchronous: no async, await, Promise, or `.then(` in
 *   src/hooks/ or index.ts
 * - no `timeoutMs` anywhere (manifest text, manifest hooks, source): a
 *   timeout reopens the drop-on-timeout fail-open path
 * - the plugin never prints: no console or process stdout/stderr use
 * - each hook handler body is exactly one try/catch
 * Test files are excluded from the source scans. Each guard is also proven
 * against an in-memory mutant string.
 */

import { readFileSync } from "node:fs"
import { join, sep } from "node:path"

import { describe, expect, test } from "bun:test"

import {
  hooksWithTimeout,
  isOneTryCatch,
  listSourceFiles,
  PLUGIN_ROOT,
  usesAsync,
  usesConsole,
} from "./test-support.ts"

const TIMEOUT_WORD = ["timeout", "Ms"].join("")

function rel(file: string): string {
  return file.slice(PLUGIN_ROOT.length + 1)
}

function isHookPath(file: string): boolean {
  const r = rel(file)
  return r === "index.ts" || r.startsWith(join("src", "hooks") + sep)
}

const sources = listSourceFiles({ includeTests: false })
const manifestText = readFileSync(join(PLUGIN_ROOT, "manifest.json"), "utf8")
const manifest = JSON.parse(manifestText) as { enabled?: unknown; hooks?: unknown[] }

const GOOD_HOOK = [
  "export default function h(p: T): ChainResult<T> {",
  "  try {",
  "    return undefined",
  "  } catch {",
  "    return undefined",
  "  }",
  "}",
  "",
].join("\n")

describe("arch", () => {
  test("no async in hook files or index.ts", () => {
    const hits = sources.filter(isHookPath).filter((f) => usesAsync(readFileSync(f, "utf8")))
    expect(hits.map(rel)).toEqual([])
  })

  test("async guard catches mutants", () => {
    const mutants = [
      ["as", "ync function f() {}"],
      ["const x = aw", "ait y"],
      ["const p: Pro", "mise<void> = q"],
      ["q.th", "en(() => 1)"],
      ["as", "ync\nfunction f() {}"],
    ].map((parts) => parts.join(""))
    for (const m of mutants) expect(usesAsync(m)).toBe(true)
    expect(usesAsync("const asynchronous = 1 // promised then")).toBe(false)
  })

  test("no timeoutMs in source or manifest", () => {
    const files = [...sources, join(PLUGIN_ROOT, "manifest.json")]
    const hits = files.filter((f) => readFileSync(f, "utf8").includes(TIMEOUT_WORD))
    expect(hits.map(rel)).toEqual([])
  })

  test("no manifest hook has a timeoutMs key", () => {
    expect(hooksWithTimeout(manifest)).toEqual([])
    const mutant = { hooks: [{ id: "a" }, { id: "b", [TIMEOUT_WORD]: 5 }] }
    expect(hooksWithTimeout(mutant)).toEqual(["b"])
  })

  test("no console or process stdout/stderr usage in source", () => {
    const hits = sources.filter((f) => usesConsole(readFileSync(f, "utf8")))
    expect(hits.map(rel)).toEqual([])
  })

  test("console guard catches mutants", () => {
    const mutants = [
      ["con", "sole.log(1)"],
      ["con", 'sole["log"](1)'],
      ["process.std", 'out.write("x")'],
      ["process.std", 'err.write("x")'],
    ].map((parts) => parts.join(""))
    for (const m of mutants) expect(usesConsole(m)).toBe(true)
    expect(usesConsole("const consoleLike = process.env")).toBe(false)
  })

  test("manifest is disabled by default", () => {
    expect(manifest.enabled).toBe(false)
  })

  test("each hook default export body is exactly one try/catch", () => {
    const hookFiles = sources.filter((f) => rel(f).startsWith(join("src", "hooks") + sep))
    expect(hookFiles.length).toBeGreaterThan(0)
    const bad = hookFiles.filter((f) => !isOneTryCatch(readFileSync(f, "utf8"))).map(rel)
    expect(bad).toEqual([])
  })

  test("try/catch guard catches mutants", () => {
    expect(isOneTryCatch(GOOD_HOOK)).toBe(true)
    const tail = GOOD_HOOK.replace(/ {2}\}\n\}\n$/, "  }\n  if (p) { void p }\n}\n")
    const head = GOOD_HOOK.replace("{\n  try {", "{\n  void p\n  try {")
    const noCatch = GOOD_HOOK.replace(/ catch \{\n {4}return undefined\n {2}\}/, "")
    for (const m of [tail, head, noCatch]) {
      expect(m).not.toBe(GOOD_HOOK)
      expect(isOneTryCatch(m)).toBe(false)
    }
  })
})
