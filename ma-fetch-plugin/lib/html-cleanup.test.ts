import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { NO_SIDEBAND } from "@minimal-agent/core/host/sideband"

import { pluginSideband } from "../../tests/support/sideband.ts"

import { assetStub, cleanupHtml } from "./html-cleanup.ts"

const sb = await pluginSideband()

const BIG_CSS = `body { color: red; }\n${"a { margin: 0 }\n".repeat(40)}`
const BIG_JS = `var x = 1;\n${"function f() { return 1 }\n".repeat(40)}`

describe("cleanupHtml: levels", () => {
  test("off returns the input as it is", () => {
    const html = "<p>a</p>\n\n\n\n<p>b</p>   "
    expect(cleanupHtml(html, "off", sb)).toBe(html)
  })

  test("empty input stays empty", () => {
    expect(cleanupHtml("", "basic", sb)).toBe("")
  })

  test("basic collapses blank runs and space runs, and trims lines and edges", () => {
    const html = "\n\n   <div>\n\n\n\n      <p>a   b\t\t c</p>   \n   \n\n</div>\n\n"
    expect(cleanupHtml(html, "basic", sb)).toBe("<div>\n\n<p>a b c</p>\n\n</div>")
  })

  test("aggressive also drops every blank line", () => {
    const html = "<div>\n\n\n<p>a</p>\n\n<p>b</p>\n</div>"
    expect(cleanupHtml(html, "aggressive", sb)).toBe("<div>\n<p>a</p>\n<p>b</p>\n</div>")
  })

  test("a whitespace-only line counts as blank", () => {
    expect(cleanupHtml("<a>\n \t \n  \n<b>", "basic", sb)).toBe("<a>\n\n<b>")
  })

  test("CRLF line ends are normalized to LF", () => {
    expect(cleanupHtml("<a>\r\n\r\n\r\n<b>\r\n", "basic", sb)).toBe("<a>\n\n<b>")
  })
})

describe("cleanupHtml: style and script blocks", () => {
  test("a big <style> block becomes a stub with its size", () => {
    const out = cleanupHtml(`<head><style>${BIG_CSS}</style></head>`, "basic", sb)
    expect(out).toMatch(
      /^<head><ma::agent::redacted-asset kind="style_block" size="\d+(\.\d)?(B|KB)" tool="Fetch" \/><\/head>$/,
    )
    expect(out).not.toContain("margin")
  })

  test("a big <script> block with attributes becomes a stub", () => {
    const out = cleanupHtml(
      `<script async src="x.js" type="text/javascript">${BIG_JS}</script>`,
      "basic",
      sb,
    )
    expect(out).toMatch(
      /^<ma::agent::redacted-asset kind="script_block" size=".+" tool="Fetch" \/>$/,
    )
  })

  test("tag names are matched without case and the end tag may hold a space", () => {
    const out = cleanupHtml(`<STYLE>${BIG_CSS}</STYLE ><Script>${BIG_JS}</SCRIPT>`, "basic", sb)
    expect(out).toContain('kind="style_block"')
    expect(out).toContain('kind="script_block"')
  })

  test("the stub size is the byte size of the whole block", () => {
    const block = `<style>${"é".repeat(2000)}</style>`
    const out = cleanupHtml(block, "basic", sb)
    expect(out).toBe(assetStub("style_block", Buffer.byteLength(block, "utf-8"), sb))
  })

  test("a block that is shorter than its stub is kept", () => {
    const html = "<style>a{}</style><script>x()</script>"
    expect(cleanupHtml(html, "basic", sb)).toBe(html)
  })

  test("a JSON-LD script is page data and is kept", () => {
    const ld = `<script type="application/ld+json">{"@type":"Article","headline":"${"h".repeat(300)}"}</script>`
    expect(cleanupHtml(ld, "basic", sb)).toBe(ld)
    const q = ld.replace('type="application', "type='application").replace('json"', "json'")
    expect(cleanupHtml(q, "basic", sb)).toBe(q)
  })

  test("a block with no end tag is not replaced", () => {
    const html = `<script>${BIG_JS}`
    expect(cleanupHtml(html, "basic", sb)).toContain("function f()")
  })

  test("two blocks are replaced one by one, not as one span", () => {
    const html = `<style>${BIG_CSS}</style><p>keep me</p><style>${BIG_CSS}</style>`
    const out = cleanupHtml(html, "basic", sb)
    expect(out.match(/style_block/g)?.length).toBe(2)
    expect(out).toContain("<p>keep me</p>")
  })

  test("a string in a script that looks like '<pre>' does not break the stub", () => {
    const js = `var s = "<pre>"; ${BIG_JS}`
    const out = cleanupHtml(`<script>${js}</script><p>x</p>`, "basic", sb)
    expect(out).toMatch(/^<ma::agent::redacted-asset kind="script_block".*\/><p>x<\/p>$/)
  })
})

describe("cleanupHtml: <pre> and <textarea> are protected", () => {
  const PRE = "<pre>line 1\n\n\n\n    indented   twice\t\tend   \n</pre>"
  const TA = "<textarea rows=3>a\n\n\n   b   \n</textarea>"

  test("a <pre> block is byte-identical, the text around it is cleaned", () => {
    const out = cleanupHtml(`<p>  a    b  </p>\n\n\n\n${PRE}\n\n\n\n<p>c</p>`, "basic", sb)
    // A run of spaces becomes ONE space (it does not vanish).
    expect(out).toBe(`<p> a b </p>\n\n${PRE}\n\n<p>c</p>`)
  })

  test("a <textarea> block is byte-identical", () => {
    expect(cleanupHtml(`<div>\n\n\n${TA}\n\n\n</div>`, "aggressive", sb)).toBe(
      `<div>\n${TA}\n</div>`,
    )
  })

  test("two blocks come back in the right places", () => {
    const out = cleanupHtml(`${PRE}\n\n\n\n${TA}`, "basic", sb)
    expect(out).toBe(`${PRE}\n\n${TA}`)
  })

  test("the tag match is case-insensitive and reads attributes", () => {
    const pre = '<PRE class="x">  keep\n\n\n  this  </PRE>'
    expect(cleanupHtml(`<p>a</p>\n\n\n${pre}`, "basic", sb)).toBe(`<p>a</p>\n\n${pre}`)
  })

  test("a NUL-and-digits text in the page is not read as a marker of ours", () => {
    // Only a protected block can make a marker. A page with its own NUL text must not crash.
    const html = `<p>a</p>\n\n\n\n<pre>x</pre>\n\u00000\u0000`
    expect(() => cleanupHtml(html, "basic", sb)).not.toThrow()
  })
})

describe("cleanupHtml: idempotent", () => {
  const samples = [
    `<head><style>${BIG_CSS}</style><script>${BIG_JS}</script></head>\n\n\n\n<body>\n   <p>a   b</p>\n<pre>  x\n\n\n y</pre>\n</body>`,
    "<p>a</p>\n\n\n\n\n<p>b</p>",
    "   \n\n   ",
  ]
  for (const level of ["basic", "aggressive"] as const) {
    test(`${level}: f(f(x)) === f(x)`, () => {
      for (const s of samples) {
        const once = cleanupHtml(s, level, sb)
        expect(cleanupHtml(once, level, sb)).toBe(once)
      }
    })
  }
})

// ---------------------------------------------------------------------------
// Real pages: handlers/fixtures/ (see INDEX.md). Measures the gain, and pins
// a floor so a regression in the cleaner fails here.
// ---------------------------------------------------------------------------

const FIXTURES = join(import.meta.dir, "..", "handlers", "fixtures")
const PRE_RE = /<(pre|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
const bytes = (s: string) => Buffer.byteLength(s, "utf-8")

/** [file, minimum share of bytes removed at `basic`]. Measured: 34.0, 41.2, 10.1, 14.5 %. */
const HTML_FIXTURES: ReadonlyArray<readonly [string, number]> = [
  ["01-www.mdpi.com-html.html", 0.3],
  ["02-www.sofi.com-html.html", 0.35],
  ["03-github.com-html.html", 0.08],
  ["04-www2.multifiesta.com.uy-html.html", 0.12],
]

describe.skipIf(!existsSync(FIXTURES))("cleanupHtml on real pages (fixtures)", () => {
  for (const [file, floor] of HTML_FIXTURES) {
    describe(file, () => {
      const raw = readFileSync(join(FIXTURES, file), "utf-8")

      test(`basic removes at least ${Math.round(floor * 100)}% of the bytes`, () => {
        const out = cleanupHtml(raw, "basic", sb)
        expect(1 - bytes(out) / bytes(raw)).toBeGreaterThanOrEqual(floor)
      })

      test("aggressive is not larger than basic", () => {
        expect(bytes(cleanupHtml(raw, "aggressive", sb))).toBeLessThanOrEqual(
          bytes(cleanupHtml(raw, "basic", sb)),
        )
      })

      test("idempotent", () => {
        const once = cleanupHtml(raw, "basic", sb)
        expect(cleanupHtml(once, "basic", sb)).toBe(once)
      })

      test("no <style> or <script> block over 1 KB stays (except JSON-LD)", () => {
        const out = cleanupHtml(raw, "basic", sb)
        for (const m of out.matchAll(/<(style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/gi)) {
          if (/application\/ld\+json/i.test(m[0].slice(0, 200))) continue
          expect(bytes(m[0])).toBeLessThan(1024)
        }
      })

      test("each <pre>/<textarea> block that was in the page is unchanged", () => {
        const out = cleanupHtml(raw, "basic", sb)
        const before = new Set(raw.match(PRE_RE) ?? [])
        for (const b of out.match(PRE_RE) ?? []) expect(before.has(b)).toBe(true)
      })
    })
  }

  test("all fixture files listed in this test exist", () => {
    const files = new Set(readdirSync(FIXTURES))
    for (const [file] of HTML_FIXTURES) expect(files.has(file)).toBe(true)
  })
})

describe("stubs with no sideband codec (NO_SIDEBAND)", () => {
  test("no stub: each block stays", () => {
    expect(assetStub("style_block", 10, NO_SIDEBAND)).toBe("")
    const page = `<html><head><style>${"a{}".repeat(200)}</style></head><body>x</body></html>`
    expect(cleanupHtml(page, "basic", NO_SIDEBAND)).toContain("<style>")
    expect(cleanupHtml(page, "basic", sb)).not.toContain("<style>")
  })
})
