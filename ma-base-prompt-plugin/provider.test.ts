import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import createProvider, { createBaseProvider } from "./provider.ts"

const FIX = join(import.meta.dir, "__fixtures__")
const TMP = join(import.meta.dir, "tmp-provider-test")
const ctx = { authKind: "k", modelId: "m" }
const bytes = (s: string) => Buffer.from(s, "utf-8")
const fixture = (name: string) => readFileSync(join(FIX, name))

function stage(name: string): string {
  const dir = join(TMP, name)
  mkdirSync(join(dir, "prompts"), { recursive: true })
  cpSync(join(import.meta.dir, "prompts"), join(dir, "prompts"), { recursive: true })
  return dir
}

describe("base prompt provider", () => {
  beforeAll(() => rmSync(TMP, { recursive: true, force: true }))
  afterAll(() => rmSync(TMP, { recursive: true, force: true }))

  test("identity equals the old core identity bytes", () => {
    const id = createProvider().identity?.(ctx) ?? ""
    expect(bytes(id).equals(fixture("old-identity.txt"))).toBe(true)
  })

  test("instruction parts hold one instructions part equal to the old core bytes", () => {
    const parts = createProvider().instructionParts?.() ?? []
    expect(parts).toHaveLength(1)
    expect(parts[0]?.slot).toBe("instructions")
    expect(bytes(parts[0]?.text ?? "").equals(fixture("old-instructions.txt"))).toBe(true)
  })

  test("trailing newlines and blank lines in the data files are trimmed", () => {
    const dir = stage("trim")
    appendFileSync(join(dir, "prompts", "identity.neutral.md"), "\n")
    appendFileSync(join(dir, "prompts", "identity.neutral.md"), "\n \n")
    appendFileSync(join(dir, "prompts", "instructions.md"), "\n")
    appendFileSync(join(dir, "prompts", "instructions.md"), "\n \n")
    const p = createBaseProvider(dir)
    expect(bytes(p.identity?.(ctx) ?? "").equals(fixture("old-identity.txt"))).toBe(true)
    const text = p.instructionParts?.()[0]?.text ?? ""
    expect(bytes(text).equals(fixture("old-instructions.txt"))).toBe(true)
  })

  test("an empty data file gives an empty part, with no fallback to the default", () => {
    const dir = stage("empty")
    writeFileSync(join(dir, "prompts", "identity.neutral.md"), "")
    writeFileSync(join(dir, "prompts", "instructions.md"), "")
    const p = createBaseProvider(dir)
    expect(p.identity?.(ctx)).toBe("")
    expect(p.instructionParts?.()).toEqual([{ slot: "instructions", text: "" }])
  })

  test("the provider reads the files at first call, not at creation", () => {
    const dir = stage("lazy")
    const p = createBaseProvider(dir)
    writeFileSync(join(dir, "prompts", "identity.neutral.md"), "late\n")
    expect(p.identity?.(ctx)).toBe("late")
  })

  test("the instructions file is read at the first call of instructionParts, not at creation", () => {
    const dir = stage("lazy-instructions")
    const p = createBaseProvider(dir)
    writeFileSync(join(dir, "prompts", "instructions.md"), "late instructions\n")
    expect(p.instructionParts?.()).toEqual([{ slot: "instructions", text: "late instructions" }])
  })

  test("the instructions text is read once and kept after the first call", () => {
    const dir = stage("memo-instructions")
    const p = createBaseProvider(dir)
    const first = p.instructionParts?.()[0]?.text
    writeFileSync(join(dir, "prompts", "instructions.md"), "changed after the first call\n")
    expect(p.instructionParts?.()[0]?.text).toBe(first ?? "")
  })

  test("neither data file holds a percent placeholder marker", () => {
    for (const name of ["identity.neutral.md", "instructions.md"]) {
      expect(readFileSync(join(import.meta.dir, "prompts", name), "utf-8").includes("%%")).toBe(
        false,
      )
    }
  })
})
