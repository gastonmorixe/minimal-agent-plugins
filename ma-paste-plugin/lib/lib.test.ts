/**
 * U7: format, id, count and config of the paste plugin.
 *
 * @module ma-paste-plugin/lib/lib.test
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import {
  DEFAULT_DISPLAY_MAX_BYTES,
  defaultPasteConfig,
  loadPasteConfig,
  parsePasteConfig,
  shouldCollapse,
} from "./config.ts"
import { countLines, normalizeNewlines, utf8Bytes, utf8Head } from "./count.ts"
import { chipLabel, formatSize } from "./format.ts"
import { isPasteId, newId, PASTE_ID_RE } from "./id.ts"
import { numberLines } from "./number.ts"

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

  test("utf8Head cuts on a UTF-8 boundary", () => {
    expect(utf8Head("abc", 3)).toBe("abc")
    expect(utf8Head("abc", 2)).toBe("ab")
    expect(utf8Head("aé", 2)).toBe("a")
    expect(utf8Head("a😀b", 4)).toBe("a")
    expect(utf8Head("a😀b", 5)).toBe("a😀")
    expect(utf8Head("é", 0)).toBe("")
  })

  test("normalizeNewlines changes CRLF and CR to LF only", () => {
    expect(normalizeNewlines("a\r\nb\rc\n\td ")).toBe("a\nb\nc\n\td ")
    expect(normalizeNewlines("\r\r\n")).toBe("\n\n")
  })
})

describe("numberLines", () => {
  test("Read tool form: N<TAB>line from 1; final LF kept with no number after it", () => {
    expect(numberLines("")).toBe("")
    expect(numberLines("a")).toBe("1\ta")
    expect(numberLines("a\n")).toBe("1\ta\n")
    expect(numberLines("a\n\nb")).toBe("1\ta\n2\t\n3\tb")
    expect(numberLines("\n")).toBe("1\t\n")
  })

  test("the numbered text has the same line count", () => {
    for (const t of ["a", "a\n", "a\n\nb", "\n\n", "x\ny\n"]) {
      expect(countLines(numberLines(t))).toBe(countLines(t))
    }
  })
})

describe("config", () => {
  test("default: 4 lines or 1200 bytes, floor 120 bytes, line numbers on", () => {
    expect(defaultPasteConfig()).toEqual({
      collapse: { minLines: 4, minBytes: 1200, floorBytes: 120 },
      lineNumbers: true,
      display: { maxBytes: 65536 },
    })
    expect(DEFAULT_DISPLAY_MAX_BYTES).toBe(65536)
    const c = defaultPasteConfig().collapse
    // Small stuff stays literal text.
    expect(shouldCollapse(c, 1, 1)).toBe(false)
    expect(shouldCollapse(c, 1, 80)).toBe(false)
    expect(shouldCollapse(c, 3, 600)).toBe(false)
    expect(shouldCollapse(c, 1, 1199)).toBe(false)
    // 4 very short lines are under the floor.
    expect(shouldCollapse(c, 4, 12)).toBe(false)
    expect(shouldCollapse(c, 10, 119)).toBe(false)
    // Large stuff collapses.
    expect(shouldCollapse(c, 4, 120)).toBe(true)
    expect(shouldCollapse(c, 1, 1200)).toBe(true)
    expect(shouldCollapse(c, 200, 9000)).toBe(true)
  })

  test("0/0 with no floor makes a ref for each paste", () => {
    expect(shouldCollapse({ minLines: 0, minBytes: 0, floorBytes: 0 }, 1, 1)).toBe(true)
  })

  test("plugins.paste.collapse is read; bad fields keep the default", () => {
    expect(
      parsePasteConfig({
        plugins: {
          paste: {
            collapse: { minLines: 3, minBytes: 200, floorBytes: 0 },
            lineNumbers: false,
          },
        },
      }),
    ).toEqual({
      collapse: { minLines: 3, minBytes: 200, floorBytes: 0 },
      lineNumbers: false,
      display: { maxBytes: 65536 },
    })
    expect(parsePasteConfig({ plugins: { paste: { lineNumbers: "no" } } })).toEqual(
      defaultPasteConfig(),
    )
    expect(
      parsePasteConfig({ plugins: { paste: { collapse: { minLines: -1, minBytes: "x" } } } }),
    ).toEqual(defaultPasteConfig())
    expect(parsePasteConfig({ plugins: { "ma-paste": { collapse: { minLines: 3 } } } })).toEqual(
      defaultPasteConfig(),
    )
    expect(parsePasteConfig(null)).toEqual(defaultPasteConfig())
  })

  test("plugins.paste.display.maxBytes is read; 0 is valid; bad values keep the default", () => {
    const max = (v: unknown) => parsePasteConfig({ plugins: { paste: { display: v } } }).display
    expect(max({ maxBytes: 8192 })).toEqual({ maxBytes: 8192 })
    expect(max({ maxBytes: 0 })).toEqual({ maxBytes: 0 })
    expect(max({ maxBytes: 100.7 })).toEqual({ maxBytes: 100 })
    for (const bad of [
      { maxBytes: -1 },
      { maxBytes: "1" },
      { maxBytes: Number.NaN },
      {},
      5,
      null,
    ]) {
      expect(max(bad)).toEqual({ maxBytes: DEFAULT_DISPLAY_MAX_BYTES })
    }
    // The display key does not need a collapse key, and the reverse.
    const both = parsePasteConfig({
      plugins: { paste: { display: { maxBytes: 9 }, collapse: { minLines: 2 } } },
    })
    expect(both.display.maxBytes).toBe(9)
    expect(both.collapse.minLines).toBe(2)
  })

  test("threshold: either limit that is not 0", () => {
    const c = { minLines: 3, minBytes: 200, floorBytes: 0 }
    expect(shouldCollapse(c, 2, 199)).toBe(false)
    expect(shouldCollapse(c, 3, 10)).toBe(true)
    expect(shouldCollapse(c, 1, 200)).toBe(true)
    expect(shouldCollapse({ minLines: 3, minBytes: 0, floorBytes: 0 }, 2, 10_000)).toBe(false)
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
        collapse: { minLines: 5, minBytes: 1200, floorBytes: 120 },
        lineNumbers: true,
        display: { maxBytes: 65536 },
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
