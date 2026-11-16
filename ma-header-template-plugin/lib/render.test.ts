import { describe, expect, test } from "bun:test"

import { renderHeader } from "./render.ts"
import type { VarsInput } from "./vars.ts"

const SID = "3370172c-0000-4000-8000-9d632bad8345"

function input(over: Partial<VarsInput> = {}): VarsInput {
  return {
    facts: { sid: SID, cwd: "/home/u/proj", model: "gpt-6-luna", source: "startup" },
    env: { MINIMAL_AGENT_PROVIDER: "openai", MINIMAL_AGENT_EFFORT: "low" },
    color: false,
    now: new Date(2026, 0, 2, 3, 4),
    home: "/home/u",
    gitBranch: () => "main",
    ...over,
  }
}

describe("renderHeader", () => {
  test("off when unset or blank", () => {
    expect(renderHeader(undefined, input())).toEqual({ kind: "off" })
    expect(renderHeader("  ", input())).toEqual({ kind: "off" })
  })

  test("fills session facts and env values", () => {
    const r = renderHeader(
      "%%sid.short%% · %%provider%%/%%model%% · %%effort%% · %%cwd.tilde%% · %%time%%",
      input(),
    )
    expect(r).toEqual({ kind: "ok", text: "3370172c · openai/gpt-6-luna · low · ~/proj · 03:04" })
  })

  test("\\n makes a new line", () => {
    const r = renderHeader("%%sid.short%%\\n%%sid%%", input())
    expect(r).toEqual({ kind: "ok", text: `3370172c\n${SID}` })
  })

  test("missing required value is an error line, optional is empty", () => {
    const env = {}
    expect(renderHeader("%%agent%%", input({ env }))).toEqual({
      kind: "error",
      message: "header-format: no value for %%agent%% (use %%name?%% for optional values)",
    })
    expect(renderHeader("[%%agent?%%]", input({ env }))).toEqual({ kind: "ok", text: "[]" })
  })

  test("styles are empty without color, codes with color plus a reset", () => {
    expect(renderHeader("%%c.dim%%x%%c.reset%%", input())).toEqual({ kind: "ok", text: "x" })
    expect(renderHeader("%%c.dim%%x", input({ color: true }))).toEqual({
      kind: "ok",
      text: "\x1b[2mx\x1b[0m",
    })
  })

  test("branch getter runs only when used", () => {
    let calls = 0
    const gitBranch = () => {
      calls++
      return "main"
    }
    renderHeader("%%sid%%", input({ gitBranch }))
    expect(calls).toBe(0)
    expect(renderHeader("%%branch%%", input({ gitBranch }))).toEqual({ kind: "ok", text: "main" })
    expect(calls).toBe(1)
  })
})
