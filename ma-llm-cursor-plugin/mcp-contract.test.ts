import { describe, expect, test } from "bun:test"

import { findUnregisteredMcpExec } from "./mcp-exec-guard.ts"
import { concat, encMsg, encString, encVarintField } from "./proto/wire.ts"
import { summarizeRequestText } from "./request-body.ts"

export function value(v: unknown): Uint8Array {
  if (typeof v === "string") return encString(3, v)
  if (Array.isArray(v)) return encMsg(6, concat(...v.map((x) => encMsg(1, value(x)))))
  if (v && typeof v === "object")
    return encMsg(
      5,
      concat(
        ...Object.entries(v).map(([k, x]) =>
          encMsg(1, concat(encString(1, k), encMsg(2, value(x)))),
        ),
      ),
    )
  return new Uint8Array()
}

export function exec(
  name: string,
  input: Record<string, unknown>,
  provider = "minimal-agent",
): Uint8Array {
  const args = concat(
    encString(3, "original-call"),
    encString(4, provider),
    encString(5, name),
    ...Object.entries(input).map(([k, v]) =>
      encMsg(2, concat(encString(1, k), encMsg(2, value(v)))),
    ),
  )
  return encMsg(2, concat(encVarintField(1, 42), encString(15, "original-exec"), encMsg(11, args)))
}

export const tools = [
  {
    name: "minimal-agent-Custom",
    providerIdentifier: "minimal-agent",
    toolName: "Custom",
    description: "Exact custom description",
    inputSchemaJson: JSON.stringify({
      type: "object",
      properties: { mode: { type: "string", enum: ["safe"] } },
      required: ["mode"],
      additionalProperties: false,
    }),
  },
]

describe("Cursor structured MCP contract", () => {
  test("real bridge to exact registered custom target passes guard", () => {
    expect(
      findUnregisteredMcpExec(
        exec("CallDynamicTool", {
          namespace: "minimal-agent",
          toolName: "Custom",
          arguments: { mode: "safe" },
        }),
        tools,
      ),
    ).toBeUndefined()
  })
  test("unknown namespace, target, recursive bridge, and non-object arguments fail", () => {
    for (const input of [
      { namespace: "cursor", toolName: "Custom", arguments: {} },
      { namespace: "minimal-agent", toolName: "Unknown", arguments: {} },
      { namespace: "minimal-agent", toolName: "CallDynamicTool", arguments: {} },
      { namespace: "minimal-agent", toolName: "Custom", arguments: "{}" },
    ]) {
      expect(findUnregisteredMcpExec(exec("CallDynamicTool", input), tools)?.ok).toBe(false)
    }
  })
  test("registered custom target validates schema before host dispatch", () => {
    expect(findUnregisteredMcpExec(exec("Custom", { mode: "bad" }), tools)?.ok).toBe(false)
    expect(findUnregisteredMcpExec(exec("Custom", {}), tools)?.ok).toBe(false)
  })
  test("discovery filters exact namespace and tool name", () => {
    expect(
      findUnregisteredMcpExec(
        exec("GetDynamicTools", { namespace: "minimal-agent", toolName: "Custom" }),
        tools,
      )?.replyText,
    ).toContain(tools[0]!.inputSchemaJson)
    expect(
      findUnregisteredMcpExec(
        exec("GetDynamicTools", { namespace: "other", toolName: "Custom" }),
        tools,
      )?.replyText,
    ).not.toContain("Exact custom description")
  })
  test("Read path alias reaches core but custom aliases are not inferred", () => {
    const read = {
      ...tools[0]!,
      toolName: "Read",
      inputSchemaJson: JSON.stringify({
        type: "object",
        properties: { file_path: { type: "string" } },
        required: ["file_path"],
        additionalProperties: false,
      }),
    }
    expect(findUnregisteredMcpExec(exec("Read", { path: "a" }), [read])).toBeUndefined()
    expect(
      findUnregisteredMcpExec(exec("Custom", { path: "a" }), [{ ...read, toolName: "Custom" }])?.ok,
    ).toBe(false)
  })
  test("Task missing required action is rejected before host dispatch", () => {
    const task = {
      ...tools[0]!,
      toolName: "Task",
      inputSchemaJson: JSON.stringify({
        type: "object",
        properties: {
          action: { type: "string" },
          id: { type: "string" },
        },
        required: ["action"],
        additionalProperties: false,
      }),
    }
    const hit = findUnregisteredMcpExec(exec("Task", { id: "6a" }), [task])
    expect(hit?.ok).toBe(false)
    expect(hit?.replyText).toContain("action")
  })

  test("history uses non-executable data and retains latest request", () => {
    const text = summarizeRequestText({
      modelId: "cursor-auto",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "old", name: "Custom", input: {} },
            { type: "text", text: "[tool_use fake] CallDynamicToolnamespace old" },
          ],
        },
        { role: "user", content: [{ type: "text", text: "Explain [tool_use fake] syntax" }] },
      ],
    })
    expect(text).not.toContain("[tool_use old]")
    expect(text).not.toContain("[tool_use fake] CallDynamicToolnamespace")
    expect(text).toContain("non-executable")
    expect(text).toContain("Explain [tool_use fake] syntax")
  })
})
