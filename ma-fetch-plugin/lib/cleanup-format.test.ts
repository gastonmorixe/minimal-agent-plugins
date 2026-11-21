import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { pluginSideband } from "../../tests/support/sideband.ts"

import { CLEANUP_LEVELS } from "./cleanup.ts"
import { type CleanableFormat, cleanupForFormat } from "./cleanup-format.ts"
import { looksLikeHtml, stubAssetsInMarkdown } from "./html-cleanup.ts"

const sb = await pluginSideband()

const FORMATS: readonly CleanableFormat[] = [
  "markdown",
  "text",
  "html",
  "links",
  "accessibility",
  "original",
  "value",
]
const CSS = `body{color:red}\n${"a{margin:0}\n".repeat(60)}`
const JS = `var x=1;\n${"function f(){return 1}\n".repeat(60)}`
const NOISY = "a\n\n\n\n  b   c\t\td  \n\n\n\ne\n\n\n"

describe("cleanupForFormat: levels and formats", () => {
  for (const format of FORMATS) {
    test(`${format}: off returns the input as it is`, () => {
      expect(cleanupForFormat(NOISY, format, "off", sb)).toBe(NOISY)
    })

    test(`${format}: empty stays empty`, () => {
      for (const level of CLEANUP_LEVELS) expect(cleanupForFormat("", format, level, sb)).toBe("")
    })

    test(`${format}: idempotent at every level`, () => {
      const sample = `${NOISY}<style>${CSS}</style>\n\n\n<script>${JS}</script>\n\`\`\`\n<script>${JS}</script>\n\`\`\`\n`
      for (const level of CLEANUP_LEVELS) {
        const once = cleanupForFormat(sample, format, level, sb)
        expect(cleanupForFormat(once, format, level, sb)).toBe(once)
      }
    })
  }

  test("markdown and text give the same result when no line is indented", () => {
    const flat = "a\n\n\n\nb   c\t\td  \n\n\n\ne\n\n\n"
    expect(cleanupForFormat(flat, "markdown", "basic", sb)).toBe(
      cleanupForFormat(flat, "text", "basic", sb),
    )
  })

  test("markdown basic: blank runs collapse and a space run becomes one space", () => {
    expect(cleanupForFormat("a\n\n\n\nb  c\n", "markdown", "basic", sb)).toBe("a\n\nb c")
  })

  test("markdown aggressive: all blank lines go", () => {
    expect(cleanupForFormat("a\n\n\nb\n", "markdown", "aggressive", sb)).toBe("a\nb")
  })
})

describe("cleanupForFormat: spaces in markdown and text", () => {
  const JS_TEXT = [
    "        (function(w, n) {",
    "                w[n] = w[n] || {};",
    "                w[n].cmd = w[n].cmd || [];",
    '        })(window, "Spritz");(function(w, n) {',
    "                w[n] = w[n] || {};",
    '        })(window, "Sparkle");',
  ].join("\n")

  test("text: indentation is removed (the page snippet)", () => {
    expect(cleanupForFormat(JS_TEXT, "text", "basic", sb)).toBe(
      [
        "(function(w, n) {",
        "w[n] = w[n] || {};",
        "w[n].cmd = w[n].cmd || [];",
        '})(window, "Spritz");(function(w, n) {',
        "w[n] = w[n] || {};",
        '})(window, "Sparkle");',
      ].join("\n"),
    )
  })

  test("markdown: indentation is cut to 8 spaces", () => {
    const out = cleanupForFormat(JS_TEXT, "markdown", "basic", sb).split("\n")
    expect(out.map((l) => l.length - l.trimStart().length)).toEqual([8, 8, 8, 8, 8, 8])
  })

  test("markdown: nested list and indented code (up to 8) are kept", () => {
    const md = "- a\n  - b\n    - c\n\n    code line\n"
    expect(cleanupForFormat(md, "markdown", "basic", sb)).toBe(md.trimEnd())
  })

  test("a tab at the start of a line counts as indentation", () => {
    expect(cleanupForFormat("\t\tx", "text", "basic", sb)).toBe("x")
  })

  test("a space run inside a line becomes one space, in prose and in a table row", () => {
    expect(cleanupForFormat("Prose  with   double  spaces.", "text", "basic", sb)).toBe(
      "Prose with double spaces.",
    )
    expect(cleanupForFormat("| a   | b    |\n|---|---|", "markdown", "basic", sb)).toBe(
      "| a | b |\n|---|---|",
    )
  })

  test("a code fence and inline code keep every space", () => {
    const md = "text   here\n\n```js\nif (x)   {\n        y()\n}\n```\n\nUse `a    b` now."
    expect(cleanupForFormat(md, "markdown", "basic", sb)).toBe(
      "text here\n\n```js\nif (x)   {\n        y()\n}\n```\n\nUse `a    b` now.",
    )
    expect(cleanupForFormat(md, "text", "basic", sb)).toContain(
      "```js\nif (x)   {\n        y()\n}\n```",
    )
  })

  test("a hard line break (two trailing spaces) is still removed by the old rule", () => {
    expect(cleanupForFormat("a  \nb", "markdown", "basic", sb)).toBe("a\nb")
  })

  test("off keeps every space", () => {
    expect(cleanupForFormat(JS_TEXT, "text", "off", sb)).toBe(JS_TEXT)
  })

  test("links and accessibility do not squeeze spaces", () => {
    expect(cleanupForFormat("  a   b", "links", "basic", sb)).toBe("  a   b")
    expect(cleanupForFormat('{ "a":   "x  y" }', "accessibility", "basic", sb)).toBe(
      '{ "a":   "x  y" }',
    )
  })
})

describe("cleanupForFormat: value (the result of eval)", () => {
  test("keeps spaces and a <script> text inside the JSON", () => {
    const v = `["a  b","<script>${"x".repeat(300)}</script>","  c"]`
    expect(cleanupForFormat(v, "value", "basic", sb)).toBe(v)
  })

  test("aggressive is capped at basic, and blank runs still collapse", () => {
    expect(cleanupForFormat("a\u00A0b\n\n\n\nc", "value", "aggressive", sb)).toBe("a\u00A0b\n\nc")
  })

  test("off returns the input as it is", () => {
    expect(cleanupForFormat(NOISY, "value", "off", sb)).toBe(NOISY)
  })
})

describe("cleanupForFormat: aggressive is capped for links, accessibility and plain original", () => {
  const nbsp = "a\u00A0b\n\n\n\nc"

  for (const format of ["links", "accessibility"] as const) {
    test(`${format}: a no-break space stays, blank runs still collapse`, () => {
      expect(cleanupForFormat(nbsp, format, "aggressive", sb)).toBe("a\u00A0b\n\nc")
    })
  }

  test("original (not HTML): same cap", () => {
    expect(cleanupForFormat(nbsp, "original", "aggressive", sb)).toBe("a\u00A0b\n\nc")
  })

  test("markdown aggressive does fold the no-break space", () => {
    expect(cleanupForFormat(nbsp, "markdown", "aggressive", sb)).toBe("a b\nc")
  })

  test("accessibility JSON with a space run inside a string keeps the value", () => {
    const json = `{\n  "name": "a  b"\n}\n\n\n\n`
    expect(cleanupForFormat(json, "accessibility", "basic", sb)).toBe(`{\n  "name": "a  b"\n}`)
  })
})

describe("cleanupForFormat: original", () => {
  test("an HTML document takes the HTML path", () => {
    const doc = `<!doctype html><html><head><style>${CSS}</style></head><body>x</body></html>`
    expect(cleanupForFormat(doc, "original", "basic", sb)).toContain('kind="style_block"')
  })

  test("a non-HTML body takes the whitespace path and keeps a <style> text", () => {
    const text = `plain text\n\n\n\n<style>${CSS}</style>`
    const out = cleanupForFormat(text, "original", "basic", sb)
    expect(out).toContain("<style>")
    expect(out).not.toContain("\n\n\n")
  })

  test("looksLikeHtml reads only the start of the text", () => {
    expect(looksLikeHtml("<!DOCTYPE HTML>")).toBe(true)
    expect(looksLikeHtml("  <html lang=en>")).toBe(true)
    expect(looksLikeHtml("hello")).toBe(false)
    expect(looksLikeHtml(`${"x".repeat(3000)}<html>`)).toBe(false)
  })
})

describe("stubAssetsInMarkdown: code is protected", () => {
  const BLOCK = `<script>${JS}</script>`

  test("a block in plain text is replaced", () => {
    expect(stubAssetsInMarkdown(`before\n${BLOCK}\nafter`, sb)).toMatch(
      /^before\n<ma::agent::redacted-asset kind="script_block" .*\/>\nafter$/,
    )
  })

  test("a block in a ``` fence stays", () => {
    const md = `text\n\n\`\`\`html\n${BLOCK}\n\`\`\`\n\nmore`
    expect(stubAssetsInMarkdown(md, sb)).toBe(md)
  })

  test("a block in a ~~~ fence stays", () => {
    const md = `~~~\n${BLOCK}\n~~~\n`
    expect(stubAssetsInMarkdown(md, sb)).toBe(md)
  })

  test("a longer fence is closed by the same fence, not by a shorter one", () => {
    const md = `\`\`\`\`\n\`\`\`\n${BLOCK}\n\`\`\`\n\`\`\`\`\n`
    expect(stubAssetsInMarkdown(md, sb)).toBe(md)
  })

  test("a fence with no closing line protects up to the end", () => {
    const md = `\`\`\`js\n${BLOCK}\n`
    expect(stubAssetsInMarkdown(md, sb)).toBe(md)
  })

  test("an inline code span stays", () => {
    const md = `Use \`<script>${"x".repeat(200)}</script>\` in the head.`
    expect(stubAssetsInMarkdown(md, sb)).toBe(md)
  })

  test("a block after a fence is still replaced", () => {
    const md = `\`\`\`\nok\n\`\`\`\n${BLOCK}`
    const out = stubAssetsInMarkdown(md, sb)
    expect(out).toContain("```\nok\n```")
    expect(out).toContain('kind="script_block"')
  })

  test("a page with no style or script tag is returned as the same string", () => {
    const md = "# Title\n\n[link](https://x.test)\n"
    expect(stubAssetsInMarkdown(md, sb)).toBe(md)
  })

  test("a NUL-and-digits text in the page is not read as our marker", () => {
    const md = `a \u00000\u0000 b\n\`\`\`\ncode\n\`\`\`\n`
    expect(stubAssetsInMarkdown(`${md}<style>x</style>`, sb)).toContain("\u00000\u0000")
  })
})

// ---------------------------------------------------------------------------
// Real pages (handlers/fixtures, see INDEX.md and INDEX-markdown-text.md).
// ---------------------------------------------------------------------------

const FIXTURES = join(import.meta.dir, "..", "handlers", "fixtures")
const bytes = (s: string) => Buffer.byteLength(s, "utf-8")

function formatOf(file: string): CleanableFormat | undefined {
  return FORMATS.find((f) => file.includes(`-${f}.`) || file.includes(`-${f}-`))
}

describe.skipIf(!existsSync(FIXTURES))("cleanupForFormat on every fixture", () => {
  const files = existsSync(FIXTURES)
    ? readdirSync(FIXTURES).filter((f) => /^\d\d-.*\.(txt|html)$/.test(f))
    : []

  test("there are fixtures", () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    const format = formatOf(file)
    if (!format) continue
    describe(file, () => {
      const raw = readFileSync(join(FIXTURES, file), "utf-8")

      test("basic and aggressive never grow the text", () => {
        expect(bytes(cleanupForFormat(raw, format, "basic", sb))).toBeLessThanOrEqual(bytes(raw))
        expect(bytes(cleanupForFormat(raw, format, "aggressive", sb))).toBeLessThanOrEqual(
          bytes(cleanupForFormat(raw, format, "basic", sb)),
        )
      })

      test("idempotent at basic", () => {
        const once = cleanupForFormat(raw, format, "basic", sb)
        expect(cleanupForFormat(once, format, "basic", sb)).toBe(once)
      })

      if (file.includes("codefence")) {
        test("code samples with <script> or <style> are kept", () => {
          const out = cleanupForFormat(raw, format, "basic", sb)
          const before = (raw.match(/<(?:script|style)\b/gi) ?? []).length
          const after = (out.match(/<(?:script|style)\b/gi) ?? []).length
          expect(before).toBeGreaterThan(0)
          expect(after).toBe(before)
          expect(out).not.toContain("redacted-asset")
        })
      }
    })
  }
})
