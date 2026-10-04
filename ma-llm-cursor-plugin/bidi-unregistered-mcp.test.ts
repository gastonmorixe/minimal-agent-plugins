/**
 * Offline: the allowlist exposes the server's GetDynamicTools / CallDynamicTool
 * bridge to the model. The model calls it, the call arrives as
 * `exec_server_message.mcp_args`, and MA has no such tool. The host used to
 * answer "Unknown tool: GetDynamicTools". The plugin must answer on the wire and
 * never emit a tool_use for a tool MA did not register.
 */

import { afterEach, describe, expect, test } from "bun:test"

import { runCursorBidi } from "./bidi-run.ts"
import { connectFrameProto, parseConnectFrames } from "./connect/stream.ts"
import { resetCursorBidiSessionsForTests } from "./cursor-bidi-session.ts"
import type { CanonicalEvent } from "./lib/canonical-events.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import type { NetworkClient, NetworkResponse } from "./lib/net-types.ts"
import { exec as mcpExecWithInput } from "./mcp-contract.test.ts"
import { findUnregisteredMcpExec } from "./mcp-exec-guard.ts"
import {
  concat,
  encMsg,
  encString,
  encVarintField,
  getFirstMsg,
  getRepeatedString,
} from "./proto/wire.ts"

const TOOLS = [
  {
    name: "minimal-agent-ModelInfo",
    providerIdentifier: "minimal-agent",
    toolName: "ModelInfo",
    description: "Report the model.\nSecond line.",
    inputSchemaJson: "{}",
  },
]

function mcpExec(toolName: string, callId = "call-1"): Uint8Array {
  const args = concat(encString(3, callId), encString(4, "minimal-agent"), encString(5, toolName))
  return encMsg(2, concat(encVarintField(1, 7), encMsg(11, args)))
}

describe("findUnregisteredMcpExec", () => {
  test("GetDynamicTools gets an ok reply that lists the real tools", () => {
    const hit = findUnregisteredMcpExec(mcpExec("GetDynamicTools"), TOOLS)
    expect(hit?.ok).toBe(true)
    expect(hit?.replyText).toContain("ModelInfo")
    expect(hit?.replyText).toContain("Second line")
  })

  test("GetDynamicTools exposes the exact input schema and complete description", () => {
    const description = `Read a file.\n${"Detailed instructions. ".repeat(12)}Use file_path, not path.`
    const inputSchema = {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
      additionalProperties: false,
    }
    const hit = findUnregisteredMcpExec(mcpExec("GetDynamicTools"), [
      {
        ...TOOLS[0]!,
        toolName: "Read",
        description,
        inputSchemaJson: JSON.stringify(inputSchema),
      },
    ])
    expect(hit?.replyText).toContain(JSON.stringify(inputSchema))
    expect(hit?.replyText).toContain(description)
  })

  test("bare CallDynamicTool without args is rejected as a bridge shape error", () => {
    const hit = findUnregisteredMcpExec(mcpExec("CallDynamicTool"), TOOLS)
    expect(hit?.ok).toBe(false)
    expect(hit?.replyText).toContain(
      "CallDynamicTool requires namespace, toolName, and object arguments",
    )
  })

  test("CallDynamicTool unwraps a registered target and does not wire-reply", () => {
    const hit = findUnregisteredMcpExec(
      mcpExecWithInput("CallDynamicTool", {
        namespace: "minimal-agent",
        toolName: "ModelInfo",
        arguments: {},
      }),
      TOOLS,
    )
    expect(hit).toBeUndefined()
  })

  test("a registered tool passes through", () => {
    expect(findUnregisteredMcpExec(mcpExec("ModelInfo"), TOOLS)).toBeUndefined()
  })

  test("a native exec (shell) is not touched", () => {
    const shell = encMsg(2, concat(encVarintField(1, 3), encMsg(2, encString(1, "ls"))))
    expect(findUnregisteredMcpExec(shell, TOOLS)).toBeUndefined()
  })
})

function fakeClient(
  body: ReadableStream<Uint8Array>,
  writeRequestBody: (chunk: Uint8Array) => void,
): NetworkClient {
  const response: NetworkResponse = {
    status: 200,
    headers: new Headers({ "content-type": "application/connect+proto" }),
    body,
    transport: { id: "test", protocol: "h2" },
    ok: true,
    text: async () => "",
    json: async <T>() => ({}) as T,
    writeRequestBody,
    endRequestBody() {},
  }
  return { request: async () => response }
}

const req: CanonicalRequest = {
  modelId: "cursor-auto",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [
    {
      name: "Read",
      description: "Read a file.\nUse file_path for the file to read.",
      inputSchema: {
        type: "object",
        properties: { file_path: { type: "string" } },
        required: ["file_path"],
        additionalProperties: false,
      },
    },
    {
      name: "Task",
      description: "Manage the plan.\nChildren are strings; updates use id.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["add_many", "update"] },
          id: { type: "string" },
          tasks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                children: { type: "array", items: { type: "string" } },
              },
              required: ["title"],
            },
          },
        },
        required: ["action"],
      },
    },
    {
      name: "SubAgentsSpawnAgent",
      description: "Spawn an agent.\nA clear task is required.",
      inputSchema: {
        type: "object",
        properties: { task: { type: "string" }, name: { type: "string" } },
        required: ["task"],
        additionalProperties: false,
      },
    },
  ],
}

const model = {
  id: "cursor-auto",
  providerId: "cursor",
  surfaceId: "agent-run",
  displayName: "Auto",
  capabilities: {
    tools: { userDefined: true },
    streaming: true,
    thinking: false,
    vision: false,
    maxOutputTokens: 64,
  },
  pricing: { inputUSD: 0, outputUSD: 0, cacheWriteUSD: 0, cacheReadUSD: 0, webSearchPerCallUSD: 0 },
  vendorIds: { cursor: "default" },
}

describe("cursor bidi unregistered MCP exec", () => {
  afterEach(() => {
    delete process.env.MA_CURSOR_BIDI_HEARTBEAT_MS
    resetCursorBidiSessionsForTests()
  })

  test("GetDynamicTools is answered on the wire and never reaches the host", async () => {
    process.env.MA_CURSOR_BIDI_HEARTBEAT_MS = "0"
    let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined
    let mcpReply = ""
    let closed = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        ctrl = controller
        controller.enqueue(connectFrameProto(mcpExec("GetDynamicTools")))
      },
    })
    const client = fakeClient(stream, (chunk) => {
      for (const frame of parseConnectFrames(chunk)) {
        const exec = getFirstMsg(frame.payload, 2)
        // Decode the actual text delivered to the model, not a UTF-8 dump of protobuf.
        const result = exec ? getFirstMsg(exec, 11) : undefined
        const success = result ? getFirstMsg(result, 1) : undefined
        const content = success ? getFirstMsg(success, 1) : undefined
        const text = content ? getFirstMsg(content, 1) : undefined
        if (text) mcpReply = getRepeatedString(text, 1)[0] ?? ""
        if (getFirstMsg(frame.payload, 5)) closed = true
      }
      if (mcpReply && closed && ctrl) {
        ctrl.enqueue(connectFrameProto(encMsg(1, encMsg(1, encString(1, "AFTER")))))
        ctrl.enqueue(connectFrameProto(encMsg(1, encMsg(14, new Uint8Array(0)))))
        ctrl.close()
        ctrl = undefined
      }
    })
    const events: CanonicalEvent[] = []
    let text = ""
    const run = (async () => {
      for await (const ev of runCursorBidi(req, model as never, {
        url: "https://example.test/agent.v1.AgentService/Run",
        headers: {},
        initialRunBody: new Uint8Array([0]),
        sessionId: "unregistered-mcp",
        modelId: "cursor-auto",
        networkClient: client,
      })) {
        events.push(ev)
        if (ev.type === "text_delta") text += ev.text
      }
    })()
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("hung: GetDynamicTools never answered")), 2000),
    )
    await Promise.race([run, timeout])

    for (const tool of req.tools ?? []) {
      expect(mcpReply).toContain(tool.name)
      expect(mcpReply).toContain(tool.description)
      expect(mcpReply).toContain(JSON.stringify(tool.inputSchema))
    }
    expect(closed).toBe(true)
    expect(events.some((e) => e.type === "tool_use_start")).toBe(false)
    expect(text).toBe("AFTER")
  })
})
