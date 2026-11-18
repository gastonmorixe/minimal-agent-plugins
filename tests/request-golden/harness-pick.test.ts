/**
 * Harness pick(): the capture drops `outcome` and `sideband` from tool_result
 * blocks only (leader decision L1). Other block types keep all keys.
 */

import { describe, expect, test } from "bun:test"

import { pick } from "./harness"

const toolResult = (extra: Record<string, unknown> = {}) => ({
  type: "tool_result",
  tool_use_id: "call-1-0",
  content: "hello",
  ...extra,
})

const opts = (blocks: Array<Record<string, unknown>>) => ({
  model: "test-model",
  maxTokens: 100,
  messages: [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "tool_use", id: "call-1-0", name: "Read", input: {} }] },
    { role: "user", content: blocks },
  ],
})

describe("harness pick()", () => {
  test("a tool_result with outcome and sideband equals the same block without them", () => {
    const withFields = pick(
      opts([
        toolResult({
          outcome: { v: 1, bodyEnd: 5, annotations: [] },
          sideband: { kind: "probe-mark" },
        }),
      ]),
    )
    const without = pick(opts([toolResult()]))
    expect(withFields).toEqual(without)
    expect(JSON.stringify(withFields)).toBe(JSON.stringify(without))
    expect(JSON.stringify(withFields)).not.toContain("outcome")
    expect(JSON.stringify(withFields)).not.toContain("sideband")
  })

  test("a tool_result directly in the messages array is also stripped", () => {
    const got = pick({
      messages: [toolResult({ outcome: { v: 1 }, sideband: { kind: "probe-mark" } })],
    })
    expect(got).toEqual({ messages: [toolResult()] })
  })

  test("other tool_result keys stay", () => {
    const got = pick(opts([toolResult({ is_error: true, outcome: { v: 1 } })]))
    const block = ((got.messages as Array<{ content: unknown }>)[2]?.content as unknown[])[0]
    expect(block).toEqual(toolResult({ is_error: true }))
  })

  test("a block of another type keeps all its keys, also outcome and sideband", () => {
    const text = {
      type: "text",
      text: "x",
      extraKey: 1,
      outcome: { v: 1 },
      sideband: { kind: "probe-mark" },
    }
    const got = pick(opts([text]))
    const block = ((got.messages as Array<{ content: unknown }>)[2]?.content as unknown[])[0]
    expect(block).toEqual(text)
  })

  test("pick does not change the input object", () => {
    const input = opts([toolResult({ outcome: { v: 1 }, sideband: { kind: "probe-mark" } })])
    const before = JSON.stringify(input)
    pick(input)
    expect(JSON.stringify(input)).toBe(before)
  })
})
