import { describe, expect, test } from "bun:test"

import type { SyntheticKind } from "@minimal-agent/core/plugin-api/types/synthetic-text"

import { createTurnRecoveryProvider } from "./provider.ts"

const p = createTurnRecoveryProvider()

describe("turn recovery texts (bytes pinned)", () => {
  test("handler_error", () => {
    expect(p.text("tool_result.handler_error", { detail: "boom" })).toBe("Handler error: boom")
    const detail = 'He said "x"\nline two'
    expect(p.text("tool_result.handler_error", { detail })).toBe(`Handler error: ${detail}`)
  })
  test("interrupted_by_stop", () => {
    expect(p.text("tool_result.interrupted_by_stop", {})).toBe(
      "The process stopped while this tool call ran. The tool call possibly ran to the end, stopped before the end, or did not start. Examine its effects before you run it again.",
    )
  })
  test("aborted orphan", () => {
    expect(p.text("tool_result.aborted", { site: "orphan" })).toBe(
      "The user stopped this tool call before it finished.",
    )
  })
  test("aborted runtime", () => {
    expect(p.text("tool_result.aborted", { site: "runtime" })).toBe("tool aborted by user")
  })
  test("non_tool_result (15e.1a, byte-equal to the old core text)", () => {
    expect(p.text("tool_result.non_tool_result", { tool: "FixtureNonResult" })).toBe(
      'Plugin tool "FixtureNonResult" returned a non-tool_result value',
    )
  })
  test("invalid_input (15e.1b, indexed facts, byte-equal to the old core text)", () => {
    expect(
      p.text("tool_result.invalid_input", {
        tool: "Bash",
        count: 1,
        "path.0": "/command",
        "rule.0": "type",
        "expected.0": "string",
        "got.0": "integer",
      }),
    ).toBe("Bash error: /command: expected type string, got integer")
    expect(
      p.text("tool_result.invalid_input", {
        tool: "Read",
        count: 1,
        "path.0": "",
        "rule.0": "required",
        "key.0": "file_path",
      }),
    ).toBe('Read error: (root): missing required property "file_path"')
  })
  test("invalid_input: every rule, a type union, and the `. ` join", () => {
    expect(
      p.text("tool_result.invalid_input", {
        tool: "X",
        count: 4,
        "path.0": "",
        "rule.0": "required",
        "key.0": "a",
        "path.1": "/b",
        "rule.1": "type",
        "expected.1": "string,null",
        "got.1": "integer",
        "path.2": "/c",
        "rule.2": "enum",
        "path.3": "",
        "rule.3": "additional",
        "key.3": "z",
      }),
    ).toBe(
      'X error: (root): missing required property "a". /b: expected type string | null, got integer. /c: value does not match any enum constant. (root): additional property "z" is not allowed',
    )
  })
  test("policy_denied", () => {
    expect(p.text("tool_result.policy_denied", { hook: "tool.willInvoke" })).toBe(
      "A lifecycle policy hook prevented this tool call.",
    )
  })
})

describe("turn recovery contract", () => {
  test("lists the 28 kinds", () => {
    expect(p.kinds).toHaveLength(28)
    expect(new Set(p.kinds).size).toBe(28)
  })
  test("never returns empty", () => {
    const cases: Array<[SyntheticKind, Record<string, string>]> = [
      ["tool_result.handler_error", { detail: "" }],
      ["tool_result.handler_error", { detail: "x" }],
      ["tool_result.interrupted_by_stop", {}],
      ["tool_result.aborted", { site: "orphan" }],
      ["tool_result.aborted", { site: "runtime" }],
      ["tool_result.policy_denied", { hook: "tool.willInvoke" }],
    ]
    for (const [k, f] of cases) expect(p.text(k, f).length).toBeGreaterThan(0)
  })
  test("unknown aborted site throws", () => {
    expect(() => p.text("tool_result.aborted", { site: "nope" })).toThrow()
    expect(() => p.text("tool_result.aborted", {})).toThrow()
  })
  test("unknown policy hook throws", () => {
    expect(() => p.text("tool_result.policy_denied", { hook: "turn.willStart" })).toThrow()
    expect(() => p.text("tool_result.policy_denied", {})).toThrow()
  })
  test("a kind not owned throws", () => {
    expect(() => p.text("mode.change", {})).toThrow()
    expect(() => p.text("tool_text.Bash.error", { detail: "x" })).toThrow()
  })
  test("a missing required fact throws", () => {
    expect(() => p.text("runtime.reflection_checkpoint", { round: 1 })).toThrow()
    expect(() => p.text("tool_result.unknown_tool", {})).toThrow()
    expect(() => p.text("tool_result.no_executor", {})).toThrow()
    expect(() => p.text("tool_result.no_executor", { name: "Bash" })).toThrow()
    expect(() => p.text("tool_result.subprocess_overflow", { detail: "x" })).toThrow()
    expect(() => p.text("tool_result.lock_timeout", { tool: "Edit" })).toThrow()
    expect(() => p.text("tool_result.lock_failed", { detail: "x" })).toThrow()
    expect(() => p.text("user_media.unavailable", {})).toThrow()
    expect(() => p.text("tool_result.non_tool_result", {})).toThrow()
    expect(() => p.text("tool_result.invalid_input", { tool: "Read" })).toThrow()
    expect(() => p.text("tool_result.invalid_input", { tool: "Read", detail: "x" })).toThrow()
    expect(() => p.text("tool_result.invalid_input", { tool: "Read", count: 0 })).toThrow()
    expect(() => p.text("tool_result.invalid_input", { tool: "Read", count: 1 })).toThrow()
    expect(() =>
      p.text("tool_result.invalid_input", { tool: "R", count: 1, "path.0": "", "rule.0": "x" }),
    ).toThrow()
    expect(() =>
      p.text("tool_result.invalid_input", {
        tool: "R",
        count: 1,
        "path.0": "",
        "rule.0": "required",
      }),
    ).toThrow()
    expect(() =>
      p.text("tool_result.invalid_input", { count: 1, "path.0": "", "rule.0": "enum" }),
    ).toThrow()
    expect(() => p.text("user_media.rejected", { reason: "too-many", site: "check" })).toThrow()
    expect(() => p.text("user_media.rejected", { reason: "nope", site: "check" })).toThrow()
    expect(() => p.text("user_media.rejected", { reason: "too-many", maxItems: 1 })).toThrow()
    expect(() =>
      p.text("user_media.rejected", { reason: "too-many", maxItems: 1, site: "marker" }),
    ).toThrow()
  })
  test("no modelId gives the plugin label", () => {
    expect(p.text("user_media.rejected", { reason: "too-many", maxItems: 3, site: "check" })).toBe(
      "more than 3 attachments for this model",
    )
  })
  test("handler_error without detail throws", () => {
    expect(() => p.text("tool_result.handler_error", {})).toThrow()
  })
})
