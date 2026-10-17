/**
 * No-spawn guard. The security plugin judges shell commands. It must never
 * run one, not in source and not in tests. Dangerous commands are tested
 * only as strings passed to pure functions (parser, guards). This test fails
 * when any plugin file imports a process or thread module or calls a Bun
 * process API.
 */

import { readFileSync } from "node:fs"
import { sep } from "node:path"

import { describe, expect, test } from "bun:test"

import { importSpecifiers, listSourceFiles } from "./test-support.ts"

/** Module specifiers that can start a process or a thread. */
const BANNED_MODULES = new Set([
  ["node", "child_process"].join(":"),
  "child_process",
  ["node", "worker_threads"].join(":"),
  "worker_threads",
  ["node", "cluster"].join(":"),
  "cluster",
])

/** Bun process APIs. Built from parts so this file's own scan stays clean. */
const BANNED_CALLS = [
  new RegExp(`\\bBun\\s*\\.\\s*${["spa", "wn"].join("")}(?:Sync)?\\b`),
  new RegExp(`\\bBun\\s*\\.\\s*\\$`),
]

/** Return the violations in one source text. */
function violations(text: string): string[] {
  const found: string[] = []
  for (const spec of importSpecifiers(text)) {
    if (BANNED_MODULES.has(spec)) found.push(`import ${spec}`)
  }
  for (const re of BANNED_CALLS) {
    if (re.test(text)) found.push(`call ${re.source}`)
  }
  return found
}

/**
 * Folders that must stay pure: no file system, process, network or Bun IO.
 * Only src/state (behind its root-confined fs helper) and the hook entry may
 * touch the file system. Guards get any IO (realpath, home dir) injected.
 */
const PURE_DIRS = ["engine", "parser", "rules", "config", "redact", "guards"]

/** The only node built-ins a pure module may import. */
const PURE_ALLOWED_NODE = new Set(["node:crypto", "node:path"])

/** IO calls banned in pure modules. Built from parts to keep this file clean. */
const PURE_BANNED_CALLS = [
  /\bprocess\s*\./,
  /\bBun\s*\./,
  new RegExp(`\\b${["fet", "ch"].join("")}\\s*\\(`),
  /\bglobalThis\s*\.\s*(?:process|Bun|fetch)\b/,
]

/** Return the purity violations in one source text. */
function purityViolations(text: string): string[] {
  const found: string[] = []
  for (const spec of importSpecifiers(text)) {
    const isNode = spec.startsWith("node:") || !spec.startsWith(".")
    if (isNode && !PURE_ALLOWED_NODE.has(spec)) found.push(`import ${spec}`)
  }
  for (const re of PURE_BANNED_CALLS) {
    if (re.test(text)) found.push(`call ${re.source}`)
  }
  return found
}

/** True when a plugin-relative file lives in one of the pure folders. */
function inPureDir(file: string): boolean {
  const rel = file.split(`${sep}src${sep}`)[1] ?? ""
  return PURE_DIRS.includes(rel.split(sep)[0] ?? "")
}

describe("pure modules have no IO", () => {
  test("engine, parser, rules, config, redact and guards import no fs, process or net", () => {
    const bad: string[] = []
    for (const file of listSourceFiles({ includeTests: false })) {
      if (!inPureDir(file)) continue
      for (const v of purityViolations(readFileSync(file, "utf8"))) bad.push(`${file}: ${v}`)
    }
    expect(bad).toEqual([])
  })

  test("the purity check catches every banned form", () => {
    const imp = ["imp", "ort"].join("")
    const cases = [
      `${imp} { readFileSync } from "node:fs"`,
      `${imp} fs from "fs"`,
      `${imp} { request } from "node:https"`,
      `${imp} os from "node:os"`,
      `const e = process.env.HOME`,
      `const f = Bun.file("x")`,
      `await ${["fet", "ch"].join("")}("https://example.com")`,
    ]
    for (const c of cases) expect(purityViolations(c).length).toBeGreaterThan(0)
    expect(purityViolations(`${imp} { createHash } from "node:crypto"`)).toEqual([])
    expect(purityViolations(`${imp} { join } from "node:path"`)).toEqual([])
    expect(purityViolations(`${imp} { x } from "./y.ts"`)).toEqual([])
  })
})

describe("no process spawn", () => {
  test("no plugin file (source or test) can start a process", () => {
    const bad: string[] = []
    for (const file of listSourceFiles({ includeTests: true })) {
      for (const v of violations(readFileSync(file, "utf8"))) bad.push(`${file}: ${v}`)
    }
    expect(bad).toEqual([])
  })

  test("the guard catches every banned form", () => {
    // Mutants are built from parts so the scan of this file stays clean.
    const imp = ["imp", "ort"].join("")
    const req = ["requ", "ire"].join("")
    const cp = ["child", "process"].join("_")
    const bun = "Bun"
    const cases = [
      `${imp} { x } from "node:${cp}"`,
      `${imp} x from "${cp}"`,
      `const x = ${req}("node:${cp}")`,
      `const w = await ${imp}("node:worker_threads")`,
      `${imp} c from "node:cluster"`,
      `${bun}.${["spa", "wn"].join("")}(["ls"])`,
      `${bun}.${["spa", "wn"].join("")}Sync(["ls"])`,
      `await ${bun}.$\`ls\``,
    ]
    for (const c of cases) expect(violations(c).length).toBeGreaterThan(0)
  })

  test("a dangerous command as plain test data is allowed", () => {
    // The parser corpus holds such strings on purpose. Data is not a call.
    expect(violations(`const cmd = "rm -rf /"`)).toEqual([])
  })
})
