/**
 * U7: format, id, count and config of the paste plugin.
 *
 * @module ma-paste-plugin/lib/lib.test
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { defaultPasteConfig, loadPasteConfig, parsePasteConfig, shouldCollapse } from "./config.ts"
import { countLines, normalizeNewlines, utf8Bytes } from "./count.ts"
import { chipLabel, formatSize } from "./format.ts"
import { isPasteId, newId, PASTE_ID_RE } from "./id.ts"

/** A chip label: the text in square brackets. */
const chip = (inner: string): string => `[${inner}]`

describe("formatSize (SI)", () => {
  test.each([
    [0, "0B"],
    [1, "1B"],
    [999, "999B"],
    [1000, "1.0kB"],
    [1049, "1.0kB"],
    [1050, "1.1kB"],
    [999_949, "999.9kB"],
    [999_950, "1.0MB"],
    [1_000_000, "1.0MB"],
    [32 * 1024 * 1024, "33.6MB"],
    [999_950_000, "1.0GB"],
  ])("%d gives %s", (bytes, want) => {
    expect(formatSize(bytes)).toBe(want)
  })

  test("a bad value gives 0B", () => {
    expect(formatSize(-1)).toBe("0B")
    expect(formatSize(Number.NaN)).toBe("0B")
  })
})

describe("chipLabel", () => {
  test("a known ref shows id, size and lines", () => {
    expect(chipLabel({ id: "u194m", bytes: "130", lines: "129" }, true)).toBe(
      chip("Paste #u194m 130B 129L"),
    )
    expect(chipLabel({ id: "u194m", bytes: 1500, lines: 3 }, true)).toBe(
      chip("Paste #u194m 1.5kB 3L"),
    )
  })

  test("an unknown ref shows missing", () => {
    expect(chipLabel({ id: "u194m", bytes: "130", lines: "129" }, false)).toBe(
      chip("Paste #u194m missing"),
    )
  })

  test("bad attrs are left out", () => {
    expect(chipLabel({ id: "u194m", bytes: "x", lines: -1 }, true)).toBe(chip("Paste #u194m"))
  })
})

describe("newId", () => {
  test("gives 5 chars of [0-9a-z]", () => {
    for (let i = 0; i < 200; i++) expect(newId()).toMatch(PASTE_ID_RE)
  })

  test("rejects bytes of 252 or more (rejection sampling)", () => {
    // 252..255 are skipped; 0 -> "0", 35 -> "z", 36 -> "0", 251 -> "z".
    const seq = [252, 253, 254, 255, 0, 35, 36, 251, 37]
    const rng = (b: Uint8Array): Uint8Array => {
      b.fill(255)
      seq.forEach((v, i) => {
        b[i] = v
      })
      return b
    }
    expect(newId(rng)).toBe("0z0z1")
  })

  test("asks for more bytes when a buffer has too few good bytes", () => {
    let calls = 0
    const rng = (b: Uint8Array): Uint8Array => {
      calls++
      b.fill(calls === 1 ? 255 : 10)
      return b
    }
    expect(newId(rng)).toBe("aaaaa")
    expect(calls).toBe(2)
  })

  test("isPasteId", () => {
    expect(isPasteId("abc12")).toBe(true)
    for (const bad of ["ABC12", "abc1", "abc123", "ab-12", "", 12345, undefined]) {
      expect(isPasteId(bad)).toBe(false)
    }
  })
})

describe("count", () => {
  test.each([
    ["", 0],
    ["a", 1],
    ["a\n", 1],
    ["a\nb", 2],
    ["a\nb\n", 2],
    ["\n", 1],
    ["\n\n", 2],
  ])("countLines(%j) = %d", (text, n) => {
    expect(countLines(text)).toBe(n)
  })

  test("utf8Bytes counts UTF-8 bytes", () => {
    expect(utf8Bytes("")).toBe(0)
    expect(utf8Bytes("abc")).toBe(3)
    expect(utf8Bytes("é")).toBe(2)
    expect(utf8Bytes("😀")).toBe(4)
  })

  test("normalizeNewlines changes CRLF and CR to LF only", () => {
    expect(normalizeNewlines("a\r\nb\rc\n\td ")).toBe("a\nb\nc\n\td ")
    expect(normalizeNewlines("\r\r\n")).toBe("\n\n")
  })
})

describe("config", () => {
  test("default is 0/0 (a ref for each non-empty paste)", () => {
    expect(defaultPasteConfig()).toEqual({ collapse: { minLines: 0, minBytes: 0 } })
    expect(shouldCollapse(defaultPasteConfig().collapse, 1, 1)).toBe(true)
  })

  test("plugins.paste.collapse is read; bad fields keep the default", () => {
    expect(
      parsePasteConfig({ plugins: { paste: { collapse: { minLines: 3, minBytes: 200 } } } }),
    ).toEqual({ collapse: { minLines: 3, minBytes: 200 } })
    expect(
      parsePasteConfig({ plugins: { paste: { collapse: { minLines: -1, minBytes: "x" } } } }),
    ).toEqual(defaultPasteConfig())
    expect(parsePasteConfig({ plugins: { "ma-paste": { collapse: { minLines: 3 } } } })).toEqual(
      defaultPasteConfig(),
    )
    expect(parsePasteConfig(null)).toEqual(defaultPasteConfig())
  })

  test("threshold: either limit that is not 0", () => {
    const c = { minLines: 3, minBytes: 200 }
    expect(shouldCollapse(c, 2, 199)).toBe(false)
    expect(shouldCollapse(c, 3, 10)).toBe(true)
    expect(shouldCollapse(c, 1, 200)).toBe(true)
    expect(shouldCollapse({ minLines: 3, minBytes: 0 }, 2, 10_000)).toBe(false)
  })

  test("loadPasteConfig reads JSONC from MINIMAL_AGENT_CONFIG and never throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "paste-config-"))
    try {
      const path = join(dir, "config.jsonc")
      writeFileSync(
        path,
        '{ // note\n "plugins": { "paste": { "collapse": { "minLines": 5, } } } }',
      )
      expect(loadPasteConfig({ MINIMAL_AGENT_CONFIG: path })).toEqual({
        collapse: { minLines: 5, minBytes: 0 },
      })
      writeFileSync(path, "{ bad")
      expect(loadPasteConfig({ MINIMAL_AGENT_CONFIG: path })).toEqual(defaultPasteConfig())
      expect(loadPasteConfig({ MINIMAL_AGENT_HOME: join(dir, "none") })).toEqual(
        defaultPasteConfig(),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
