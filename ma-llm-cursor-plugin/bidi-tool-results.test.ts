/**
 * Unit tests for bidi tool-result extraction.
 */

import { describe, expect, test } from "bun:test"

import {
  extractTrailingToolResults,
  requestHasToolResultContinuation,
  stripMaAgentWireAnnotations,
  toolResultToWireText,
} from "./bidi-tool-results.ts"

describe("bidi tool results", () => {
  test("extracts trailing tool_result blocks", () => {
    const results = extractTrailingToolResults([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "ModelInfo", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "call_1",
            content: [{ type: "text", text: "model=cursor-auto" }],
          },
        ],
      },
    ])
    expect(results).toHaveLength(1)
    expect(results[0]!.toolUseId).toBe("call_1")
    expect(toolResultToWireText(results[0]!)).toBe("model=cursor-auto")
  })

  test("stripMaAgentWireAnnotations removes harness tags from wire text", () => {
    expect(
      stripMaAgentWireAnnotations(
        '546 README.md\n\n<ma::agent::mode-active id="ask" since="2026-07-29T10:14:16.090Z" />',
      ),
    ).toBe("546 README.md")
    expect(
      stripMaAgentWireAnnotations(
        'line 1\n\n<ma::agent::raw-output path="/tmp/x.raw" size="5.8kB" sha256="abc" />\n\n<ma::agent::output-preview shown="15" total="156" tool="Read" path="/tmp/x.raw">hint</ma::agent::output-preview>',
      ),
    ).toBe("line 1")
  })

  test("toolResultToWireText strips MA annotations before Cursor encoding", () => {
    const text = toolResultToWireText({
      type: "tool_result",
      toolUseId: "call_1",
      content: [
        {
          type: "text",
          text: '546 README.md\n\n<ma::agent::mode-active id="ask" since="2026-07-29T10:14:16.090Z" />',
        },
      ],
    })
    expect(text).toBe("546 README.md")
    expect(text).not.toContain("<ma::agent::")
  })

  test("requestHasToolResultContinuation is false for fresh user text only", () => {
    expect(
      requestHasToolResultContinuation({
        modelId: "cursor-auto",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      }),
    ).toBe(false)
  })
})

describe("MA-39298 tasks payloads survive Cursor strip", () => {
  // Build tags without embedding literal "<ma::agent::..." in source - that
  // pattern is stripped by Cursor wire tooling mid-edit (MA-39298 itself).
  const LT = String.fromCharCode(60)
  const GT = String.fromCharCode(62)
  const tasksTag = "ma::agent::tasks"
  const openTasks = (attrs: string, body: string): string =>
    LT + tasksTag + attrs + GT + body + LT + "/" + tasksTag + GT
  const selfTasks = (attrs: string): string => LT + tasksTag + attrs + " />"
  const agentPrefix = LT + "ma::agent::"

  test("unwraps paired tasks board into OK header + rows", () => {
    const raw = openTasks(
      ' action="add_many" result="added_many" total="2" done="0" doing="0" todo="2" canceled="0"',
      "\n#ce6b5b  todo      Phase 1\n  #ce6b5ba  todo      Native logging\n",
    )
    const out = stripMaAgentWireAnnotations(raw)
    expect(out).toContain("OK added_many")
    expect(out).toContain("action=add_many")
    expect(out).toContain("#ce6b5b  todo      Phase 1")
    expect(out).toContain("#ce6b5ba  todo      Native logging")
    expect(out).not.toContain(tasksTag)
    expect(out).not.toBe("(empty tool result)")
  })

  test("converts self-closing tasks ack to plain OK line", () => {
    const raw = selfTasks(
      ' action="start" result="started" id="ce6b5ba" total="7" done="1" doing="2" todo="4" canceled="0"',
    )
    const out = toolResultToWireText({
      type: "tool_result",
      toolUseId: "call_1",
      content: [{ type: "text", text: raw }],
    })
    expect(out).toContain("OK started")
    expect(out).toContain("id=#ce6b5ba")
    expect(out).toContain("doing=2")
    expect(out.includes(agentPrefix)).toBe(false)
    expect(out).not.toBe("(empty tool result)")
  })

  test("plain OK Task content passes through unchanged", () => {
    const plain = "OK started action=start id=#ce6b5ba total=7 done=1 doing=2 todo=4 canceled=0"
    expect(stripMaAgentWireAnnotations(plain)).toBe(plain)
    expect(
      toolResultToWireText({
        type: "tool_result",
        toolUseId: "call_1",
        content: [{ type: "text", text: plain }],
      }),
    ).toBe(plain)
  })

  test("still strips mode-active and other harness chrome", () => {
    const mode = agentPrefix + 'mode-active id="ask" />'
    const rawOut = agentPrefix + 'raw-output path="/tmp/x" />'
    const raw = "hello\n" + mode + "\n" + rawOut
    const out = stripMaAgentWireAnnotations(raw)
    expect(out).toBe("hello")
    expect(out).not.toContain("mode-active")
    expect(out).not.toContain("raw-output")
  })
})
