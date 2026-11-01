import { afterEach, describe, expect, it } from "bun:test"

import type { UiSetupContext } from "@minimal-agent/core/plugin-api/types/plugin"

import { TEST_TERMINAL_KIT } from "../../scripts/ui/test-terminal-kit.ts"
import setup from "../ui/setup.ts"

import { SGR, stripSgr, truncateVisible, visualWidth, wrap } from "./palette.ts"
import { slots } from "./style-slots.ts"

describe("slash-menu palette facade", () => {
  // Reset after each test, also when an expect fails, so styled slots never
  // leak into a later test or test file.
  afterEach(() => {
    slots.reset()
  })

  it("is plain until ui/setup.ts installs the terminal kit (S41)", () => {
    slots.reset()
    expect(SGR.pink).toBe("")
    expect(wrap("item", SGR.sky)).toBe("item")
    setup({ tui: { kit: TEST_TERMINAL_KIT } } as UiSetupContext)
    expect(SGR.pink).toBe("\x1b[38;5;199m")
    expect(SGR.boldSky).toBe("\x1b[1;38;5;45m")
    expect(wrap("item", SGR.sky)).toBe("\x1b[38;5;45mitem\x1b[0m")
  })

  it("centralizes ANSI strip, width, wrap, and clamp helpers", () => {
    const styled = wrap("abcdef", "\x1b[31m")
    expect(stripSgr(styled)).toBe("abcdef")
    expect(visualWidth(styled)).toBe(6)
    expect(stripSgr(truncateVisible(styled, 3))).toBe("abc")
  })
})
