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
      "The process stopped while this tool call ran. It may have run fully, partly, or not at all. Check its effects before you run it again.",
    )
  })
  test("aborted orphan", () => {
    expect(p.text("tool_result.aborted", { site: "orphan" })).toBe(
      "Tool execution aborted by user before completion.",
    )
  })
  test("aborted runtime", () => {
    expect(p.text("tool_result.aborted", { site: "runtime" })).toBe("tool aborted by user")
  })
  test("policy_denied", () => {
    expect(p.text("tool_result.policy_denied", { hook: "tool.willInvoke" })).toBe(
      "Tool blocked by lifecycle policy hook.",
    )
  })
})

describe("turn recovery contract", () => {
  test("lists the 23 kinds", () => {
    expect(p.kinds).toHaveLength(23)
    expect(new Set(p.kinds).size).toBe(23)
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
