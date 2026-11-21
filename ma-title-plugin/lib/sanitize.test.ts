import { describe, expect, test } from "bun:test"

import { pluginSideband } from "../../tests/support/sideband.ts"

import { countWords, isUsableTitle, sanitizeTitle, validateTitleResult } from "./sanitize.ts"

/** The real codec (`tests/support/sideband.ts`): it strips the internal tags. */
const sb = await pluginSideband()

describe("sanitizeTitle", () => {
  const table: Array<[string, string, string]> = [
    ["double quotes", '"Fix login bug"', "Fix login bug"],
    ["single quotes", "'Fix login bug'", "Fix login bug"],
    ["curly quotes", "\u201CFix login bug\u201D", "Fix login bug"],
    ["backticks", "`Fix login bug`", "Fix login bug"],
    ["nested quotes", "\"'Fix login bug'\"", "Fix login bug"],
    ["trailing period", "Fix login bug.", "Fix login bug"],
    ["quotes then period", '"Fix login bug."', "Fix login bug"],
    ["period after quotes", '"Fix login bug".', "Fix login bug"],
    ["only one period removed", "Fix login bug..", "Fix login bug.."],
    ["ellipsis stays", "Fix login bug...", "Fix login bug..."],
    ["lower first letter", "fix login bug", "Fix login bug"],
    ["other case stays", "debug iOS build in CI", "Debug iOS build in CI"],
    ["non-latin first letter", "émoji parser fix", "Émoji parser fix"],
    ["control chars", "Fix\tlogin\nbug\u0007now", "Fix login bug now"],
    ["collapse spaces", "  Fix    login   bug  ", "Fix login bug"],
    ["ma tags", "<ma::agent::policy>x</ma::agent::policy>Fix login bug", "Fix login bug"],
    ["self-closing tag", "Fix <ma::emit::diff /> login bug", "Fix login bug"],
    ["CJK stays", "修复登录错误", "修复登录错误"],
    ["empty", '""', ""],
  ]
  for (const [name, raw, want] of table) {
    test(name, () => {
      expect(sanitizeTitle(raw, sb)).toBe(want)
    })
  }
})

describe("isUsableTitle", () => {
  test("accepts 1-8 words", () => {
    expect(isUsableTitle("Refactor")).toBe(true)
    expect(isUsableTitle("Add session title plugin")).toBe(true)
    expect(isUsableTitle("one two three four five six seven eight")).toBe(true)
  })

  test("rejects 0 or 9+ words", () => {
    expect(isUsableTitle("")).toBe(false)
    expect(isUsableTitle("one two three four five six seven eight nine")).toBe(false)
  })

  test("length: 80 chars ok, 81 rejected", () => {
    expect(isUsableTitle(`A ${"b".repeat(78)}`)).toBe(true)
    expect(isUsableTitle(`A ${"b".repeat(79)}`)).toBe(false)
  })

  test("length counts code points (CJK)", () => {
    expect(isUsableTitle("𠀀".repeat(80))).toBe(true)
    expect(isUsableTitle("𠀀".repeat(81))).toBe(false)
  })

  test("countWords", () => {
    expect(countWords("  a  b\tc ")).toBe(3)
    expect(countWords("   ")).toBe(0)
  })
})

describe("validateTitleResult", () => {
  test("ok on end_turn + string title", () => {
    expect(
      validateTitleResult({ stopReason: "end_turn", json: { title: '"fix login bug."' } }, sb),
    ).toEqual({
      ok: true,
      title: "Fix login bug",
    })
  })

  for (const stop of ["max_tokens", "refusal", "timeout", "aborted", "error", undefined]) {
    test(`stopReason ${String(stop)} → failure`, () => {
      const r = validateTitleResult({ stopReason: stop, json: { title: "Fix login bug" } }, sb)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe("stop-reason")
    })
  }

  test("title not a string → failure", () => {
    for (const json of [{ title: 3 }, {}, null, "Fix", ["Fix"], undefined]) {
      const r = validateTitleResult({ stopReason: "end_turn", json }, sb)
      expect(r).toEqual({ ok: false, reason: "not-string" })
    }
  })

  test("unusable after sanitize → failure", () => {
    const long = validateTitleResult(
      { stopReason: "end_turn", json: { title: "x".repeat(81) } },
      sb,
    )
    expect(long.ok).toBe(false)
    if (!long.ok) expect(long.reason).toBe("unusable")
    const empty = validateTitleResult({ stopReason: "end_turn", json: { title: "  .  " } }, sb)
    expect(empty.ok).toBe(false)
    const tagsOnly = validateTitleResult(
      {
        stopReason: "end_turn",
        json: { title: "<ma::x>y</ma::x>" },
      },
      sb,
    )
    expect(tagsOnly.ok).toBe(false)
  })
})
