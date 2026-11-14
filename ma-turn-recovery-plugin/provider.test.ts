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
  test("lists the 4 kinds", () => {
    expect([...p.kinds].sort()).toEqual([
      "tool_result.aborted",
      "tool_result.handler_error",
      "tool_result.interrupted_by_stop",
      "tool_result.policy_denied",
    ])
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
    expect(() => p.text("continue.max_tokens", {})).toThrow()
  })
  test("handler_error without detail throws", () => {
    expect(() => p.text("tool_result.handler_error", {})).toThrow()
  })
})
