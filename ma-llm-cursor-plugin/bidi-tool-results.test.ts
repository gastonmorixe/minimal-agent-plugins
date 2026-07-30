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
