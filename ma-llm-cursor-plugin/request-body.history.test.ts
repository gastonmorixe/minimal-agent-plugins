/**
 * A fresh Run (the fallback after a wire closes or a continuation stalls) rebuilds
 * the whole history as one user text. Tool calls and their results must survive
 * that flatten. Before, only text and thinking blocks did, so the model lost the
 * tool result and looked like it looped or forgot what it had just fetched.
 */

import { describe, expect, test } from "bun:test"

import type { CanonicalRequest } from "./lib/canonical-request.ts"
import { summarizeRequestText } from "./request-body.ts"

const history: CanonicalRequest = {
  modelId: "cursor-auto",
  messages: [
    { role: "user", content: [{ type: "text", text: "what model are you?" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Let me check." },
        { type: "tool_use", id: "call_1", name: "ModelInfo", input: { verbose: true } },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "call_1",
          content: [{ type: "text", text: "provider=cursor model=composer-2.5" }],
        },
      ],
    },
  ],
}

describe("fresh Run history flatten keeps tool calls and results", () => {
  test("tool_use name and input appear in the flattened text", () => {
    const text = summarizeRequestText(history)
    expect(text).toContain("ModelInfo")
    expect(text).toContain('"verbose":true')
  })

  test("tool_result body appears, tied to its call id", () => {
    const text = summarizeRequestText(history)
    expect(text).toContain("provider=cursor model=composer-2.5")
    expect(text).toContain("call_1")
  })

  test("a tool_result-only user message is not dropped (it was empty text before)", () => {
    const onlyResult: CanonicalRequest = {
      modelId: "cursor-auto",
      messages: [history.messages[2]!],
    }
    expect(summarizeRequestText(onlyResult)).toContain("composer-2.5")
  })

  test("error results are marked", () => {
    const req: CanonicalRequest = {
      modelId: "cursor-auto",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "call_9",
              isError: true,
              content: [{ type: "text", text: "Unknown tool: Nope" }],
            },
          ],
        },
      ],
    }
    const text = summarizeRequestText(req)
    expect(text).toContain("Unknown tool: Nope")
    expect(text.toLowerCase()).toContain("error")
  })

  test("order is preserved: question, then call, then result", () => {
    const text = summarizeRequestText(history)
    const q = text.indexOf("what model are you?")
    const call = text.indexOf("ModelInfo")
    const res = text.indexOf("composer-2.5")
    expect(q).toBeGreaterThanOrEqual(0)
    expect(call).toBeGreaterThan(q)
    expect(res).toBeGreaterThan(call)
  })

  test("plain text-only history is unchanged", () => {
    const req: CanonicalRequest = {
      modelId: "cursor-auto",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
      ],
    }
    expect(summarizeRequestText(req)).toBe("user: hi\n\nassistant: hello")
  })

  test("a huge tool result is capped so the request stays bounded", () => {
    const big = "x".repeat(200_000)
    const req: CanonicalRequest = {
      modelId: "cursor-auto",
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", toolUseId: "c", content: [{ type: "text", text: big }] },
          ],
        },
      ],
    }
    const text = summarizeRequestText(req)
    expect(text.length).toBeLessThan(80_000)
    expect(text).toContain("truncated")
  })
})
