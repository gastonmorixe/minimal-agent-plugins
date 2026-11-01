import { describe, expect, test } from "bun:test"

import type { UiSetupContext } from "@minimal-agent/core/plugin-api/types/plugin"

import { TEST_TERMINAL_KIT } from "../../scripts/ui/test-terminal-kit.ts"
import { FetchError } from "../lib/errors.ts"
import { slots } from "../lib/style.ts"
import setup from "../ui/setup.ts"

import { buildDisplayBody, fetchErrorResult } from "./fetch.ts"

describe("fetch style slots (S41)", () => {
  test("display is plain without the CLI ui.setup", () => {
    expect(buildDisplayBody("")).toBe("(empty response)")
    const result = fetchErrorResult(
      new FetchError("timeout", "Fetch: timed out"),
      "https://example.com",
      "markdown",
    )
    if (result.kind !== "tool_result") throw new Error("unreachable")
    expect(result.displayHeader).toBe("https://example.com  timeout")
    expect(result.display).toBe("timed out")
    expect(result.displayFooter).toBe("markdown")
  })

  test("ui/setup.ts installs the terminal kit for error rendering", () => {
    setup({ tui: { kit: TEST_TERMINAL_KIT } } as UiSetupContext)
    try {
      expect(buildDisplayBody("")).toBe("\x1b[2m(empty response)\x1b[22m")
      const result = fetchErrorResult(
        new FetchError("timeout", "Fetch: timed out"),
        "https://example.com",
        "markdown",
      )
      if (result.kind !== "tool_result") throw new Error("unreachable")
      expect(result.displayHeader).toBe("\x1b[31mhttps://example.com  timeout\x1b[39m")
      expect(result.display).toBe("\x1b[2mtimed out\x1b[22m")
      expect(result.displayFooter).toBe("\x1b[2mmarkdown\x1b[22m")
    } finally {
      slots.reset()
    }
  })
})
