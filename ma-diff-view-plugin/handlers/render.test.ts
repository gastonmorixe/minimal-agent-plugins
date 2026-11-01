import { afterEach, describe, expect, test } from "bun:test"

import type { UiSetupContext } from "@minimal-agent/core/plugin-api/types/plugin"

import { TEST_TERMINAL_KIT } from "../../scripts/ui/test-terminal-kit.ts"
import { slots } from "../lib/style.ts"
import setup from "../ui/setup.ts"

import { renderUnifiedDiff } from "./render.ts"

const PATCH = "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y"

afterEach(() => slots.reset())

describe("diff-view renderer (S41)", () => {
  test("is plain text without the CLI ui.setup", () => {
    expect(renderUnifiedDiff(PATCH)).toBe(PATCH)
    expect(renderUnifiedDiff(PATCH, "t")).toBe(`t\n${PATCH}`)
  })

  test("uses the terminal kit after ui/setup.ts", () => {
    setup({ tui: { kit: TEST_TERMINAL_KIT } } as UiSetupContext)
    expect(renderUnifiedDiff(PATCH, "t")).toBe(TEST_TERMINAL_KIT.renderUnifiedDiff(PATCH, "t"))
    expect(renderUnifiedDiff(PATCH)).toContain("\x1b[38;5;118m+y")
  })
})
