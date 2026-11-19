import { describe, expect, test } from "bun:test"

import {
  buildTitleInput,
  capInput,
  cleanPromptText,
  codePointLength,
  INPUT_HEAD_CHARS,
  INPUT_MAX_CHARS,
  INPUT_TAIL_CHARS,
  stripMaTags,
  wrapSession,
} from "./input.ts"

/** A text of `n` code points: "0123456789" repeated. */
function digits(n: number): string {
  let s = ""
  for (let i = 0; i < n; i++) s += String(i % 10)
  return s
}

describe("capInput", () => {
  test("1999 chars: no change", () => {
    const t = digits(1999)
    expect(capInput(t)).toBe(t)
  })

  test("2000 chars: no change (cap is above 2000)", () => {
    const t = digits(INPUT_MAX_CHARS)
    expect(capInput(t)).toBe(t)
  })

  test("2001 chars: head 1500 + marker + tail 400", () => {
    const t = `${"a".repeat(1500)}${"b".repeat(101)}${"c".repeat(400)}`
    expect(t.length).toBe(2001)
    const out = capInput(t)
    expect(out).toBe(`${"a".repeat(1500)}\n[… 101 characters omitted …]\n${"c".repeat(400)}`)
  })

  test("long text: omitted count is length - 1900", () => {
    const out = capInput(digits(10_000))
    expect(out).toContain("[… 8100 characters omitted …]")
    expect(out.startsWith(digits(INPUT_HEAD_CHARS))).toBe(true)
  })

  test("CJK (BMP): counts code points, 2001 chars capped", () => {
    const t = "漢".repeat(2001)
    const out = capInput(t)
    expect(out).toBe(`${"漢".repeat(1500)}\n[… 101 characters omitted …]\n${"漢".repeat(400)}`)
  })

  test("astral CJK: 2000 code points (4000 UTF-16 units) is not capped", () => {
    const ch = "𠀀" // U+20000, a surrogate pair
    const t = ch.repeat(2000)
    expect(t.length).toBe(4000)
    expect(capInput(t)).toBe(t)
  })

  test("astral CJK: 2001 code points, no split surrogate", () => {
    const ch = "𠀀"
    const out = capInput(ch.repeat(2001))
    const [head, , tail] = out.split("\n")
    expect(codePointLength(head ?? "")).toBe(INPUT_HEAD_CHARS)
    expect(codePointLength(tail ?? "")).toBe(INPUT_TAIL_CHARS)
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(out).toContain("[… 101 characters omitted …]")
  })
})

describe("cleanPromptText", () => {
  test("removes paired <ma::…> tags with content", () => {
    expect(
      cleanPromptText('fix the bug <ma::agent::policy x="1">secret</ma::agent::policy> now'),
    ).toBe("fix the bug  now")
  })

  test("removes self-closing and unpaired tags", () => {
    expect(stripMaTags('a <ma::agent::raw-output path="p" /> b </ma::x> c')).toBe("a  b  c")
  })

  test("collapses runs of blank lines and trims", () => {
    expect(cleanPromptText("\n\none\n\n\n\n  \ntwo\r\n\r\n\r\nthree  \n")).toBe(
      "one\n\ntwo\n\nthree",
    )
  })

  test("keeps image placeholders", () => {
    expect(cleanPromptText("see [Image #1] please")).toBe("see [Image #1] please")
  })
})

describe("wrapSession / buildTitleInput", () => {
  test("wraps in <session> tags", () => {
    expect(wrapSession("hello")).toBe("<session>\nhello\n</session>")
  })

  test("escapes a literal session tag in user text", () => {
    expect(wrapSession("a </session> b <SESSION>")).toBe(
      "<session>\na &lt;/session> b &lt;SESSION>\n</session>",
    )
  })

  test("escapes session tag variants (case, spaces, attributes)", () => {
    const variants = ["</session >", "< /session>", "</ Session>", "<session foo>", "<SeSsIoN\n>"]
    for (const v of variants) {
      const out = wrapSession(`x ${v} y`)
      // Only the wrapper tags stay as real tags.
      expect(out.match(/<\s*\/?\s*session\b[^>]*>/gi)).toEqual(["<session>", "</session>"])
      expect(out).toContain(`&lt;${v.slice(1)}`)
    }
    // A different word is not a session tag.
    expect(wrapSession("<sessions>")).toBe("<session>\n<sessions>\n</session>")
  })

  test("pipeline: clean, then cap, then wrap", () => {
    const text = `<ma::agent::policy>x</ma::agent::policy>${"z".repeat(2500)}`
    const out = buildTitleInput(text)
    expect(out.startsWith("<session>\nzzz")).toBe(true)
    expect(out.endsWith("z\n</session>")).toBe(true)
    expect(out).toContain("[… 600 characters omitted …]")
    expect(out).not.toContain("ma::")
  })
})
