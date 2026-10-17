import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { makeFixtureDir, removeFixtureDir } from "../test-support.ts"

import { readTailFileIn } from "./fs.ts"

let root = ""
let outside = ""

beforeEach(() => {
  root = makeFixtureDir("tail-")
  outside = makeFixtureDir("tail-out-")
})

afterEach(() => {
  removeFixtureDir(root)
  removeFixtureDir(outside)
})

describe("readTailFileIn", () => {
  test("a small file is read whole, truncatedHead false", () => {
    writeFileSync(join(root, "a.jsonl"), "row1\nrow2\n")
    const r = readTailFileIn(root, "a.jsonl", 1024)
    expect(r).toEqual({ ok: true, value: { text: "row1\nrow2\n", truncatedHead: false, size: 10 } })
  })

  test("a big file returns only the last cap bytes, truncatedHead true", () => {
    const rows = Array.from({ length: 1000 }, (_, i) => `row-${String(i).padStart(4, "0")}`).join(
      "\n",
    )
    writeFileSync(join(root, "big.jsonl"), `${rows}\n`)
    const r = readTailFileIn(root, "big.jsonl", 32)
    if (!("ok" in r)) throw new Error("expected ok")
    expect(r.value?.truncatedHead).toBe(true)
    expect(r.value?.text.length).toBe(32)
    expect(r.value?.text.endsWith("row-0999\n")).toBe(true)
    expect(r.value?.size).toBe(rows.length + 1)
  })

  test("cap 0 gives empty text, truncatedHead true for a non-empty file", () => {
    writeFileSync(join(root, "x"), "abc")
    const r = readTailFileIn(root, "x", 0)
    expect(r).toEqual({ ok: true, value: { text: "", truncatedHead: true, size: 3 } })
  })

  test("an empty file", () => {
    writeFileSync(join(root, "e"), "")
    expect(readTailFileIn(root, "e", 10)).toEqual({
      ok: true,
      value: { text: "", truncatedHead: false, size: 0 },
    })
  })

  test("refuses a symlink as the final target", () => {
    writeFileSync(join(outside, "secret"), "outside data")
    symlinkSync(join(outside, "secret"), join(root, "link"))
    expect(readTailFileIn(root, "link", 100)).toEqual({ error: "target is a symlink" })
  })

  test("refuses a .. escape and an absolute path outside the root", () => {
    writeFileSync(join(outside, "f"), "x")
    expect(readTailFileIn(root, "../f", 100)).toEqual({ error: "path escapes root" })
    expect(readTailFileIn(root, join(outside, "f"), 100)).toEqual({ error: "path escapes root" })
  })

  test("refuses a symlinked parent dir that points out of the root", () => {
    writeFileSync(join(outside, "f"), "x")
    symlinkSync(outside, join(root, "d"))
    expect(readTailFileIn(root, "d/f", 100)).toEqual({ error: "path escapes root" })
  })

  test("refuses a directory, reports a missing file, rejects a bad cap", () => {
    mkdirSync(join(root, "dir"))
    expect(readTailFileIn(root, "dir", 100)).toEqual({ error: "not a file" })
    expect(readTailFileIn(root, "nope", 100)).toEqual({ error: "missing" })
    writeFileSync(join(root, "f"), "x")
    expect(readTailFileIn(root, "f", -1)).toEqual({ error: "too big" })
    expect(readTailFileIn(root, "f", 1.5)).toEqual({ error: "too big" })
  })

  test("never throws on garbage input", () => {
    expect(() => readTailFileIn("", "", 1)).not.toThrow()
    expect(() => readTailFileIn(root, "a\0b", 1)).not.toThrow()
    expect(readTailFileIn(root, "a\0b", 1)).toEqual({ error: "bad path" })
  })
})
