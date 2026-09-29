/**
 * Offline: Cursor asks for MCP state (ExecServerMessage.mcp_state_exec_args #36)
 * before it exposes client MCP tools. Unanswered, the server waits forever and
 * the model never sees MA tools (live 2026-09-28, CLI 2026.09.28-64d2043).
 */

import { afterEach, describe, expect, test } from "bun:test"

import { runCursorBidi } from "./bidi-run.ts"
import { connectFrameProto, parseConnectFrames } from "./connect/stream.ts"
import { resetCursorBidiSessionsForTests } from "./cursor-bidi-session.ts"
import type { CanonicalRequest } from "./lib/canonical-request.ts"
import type { NetworkClient, NetworkResponse } from "./lib/net-types.ts"
import {
  decodeExecServerMcpState,
  encodeAgentClientMcpStateResult,
} from "./proto/exec-mcp-state.ts"
import {
  concat,
  decodeFields,
  encBool,
  encMsg,
  encString,
  encVarintField,
  fieldBytes,
  fieldString,
  getFirstMsg,
  getRepeatedMsg,
  getRepeatedString,
} from "./proto/wire.ts"

/** Live frame shape (probe 2026-09-28): 19 span_context, 36 mcp_state_exec_args, 55 bool. */
function mcpStateExecBody(opts: { id?: number; ids: string[]; kickOnly?: boolean }): Uint8Array {
  const args = concat(
    ...opts.ids.map((s) => encString(1, s)),
    ...(opts.kickOnly ? [encBool(2, true)] : []),
  )
  return concat(
    ...(opts.id ? [encVarintField(1, opts.id)] : []),
    encMsg(19, concat(encString(1, "trace"), encString(2, "span"))),
    encMsg(36, args),
    encVarintField(55, 0),
  )
}

function mcpStateServerFrame(opts: { id?: number; ids: string[] }): Uint8Array {
  return connectFrameProto(encMsg(2, mcpStateExecBody(opts)))
}

function textFrame(text: string): Uint8Array {
  return connectFrameProto(encMsg(1, encMsg(1, encString(1, text))))
}

function turnEndedFrame(): Uint8Array {
  return connectFrameProto(encMsg(1, encMsg(14, new Uint8Array(0))))
}

const tools = [
  {
    name: "minimal-agent-ModelInfo",
    providerIdentifier: "minimal-agent",
    toolName: "ModelInfo",
    description: "meta",
    inputSchemaJson: '{"type":"object","properties":{}}',
  },
]

describe("mcp_state codec", () => {
  test("decodes mcp_state_exec_args from ExecServerMessage body", () => {
    const got = decodeExecServerMcpState(mcpStateExecBody({ id: 7, ids: ["minimal-agent"] }))
    expect(got).toEqual({
      id: 7,
      execId: "",
      serverIdentifiers: ["minimal-agent"],
      kickOnly: false,
    })
  })

  test("returns undefined when #36 is absent", () => {
    const body = concat(encVarintField(1, 3), encMsg(11, encString(5, "x")))
    expect(decodeExecServerMcpState(body)).toBeUndefined()
  })

  test("encodes AgentClientMessage.exec_client_message.mcp_state_exec_result success", () => {
    const out = encodeAgentClientMcpStateResult({ id: 7, execId: "" }, tools)
    const exec = getFirstMsg(out, 2)
    expect(exec).toBeDefined()
    const execFields = decodeFields(exec!)
    expect(execFields.find((f) => f.no === 1)?.value).toBe(7)
    // exec_id #15 omitted when empty (official client sets only id + result).
    expect(execFields.some((f) => f.no === 15)).toBe(false)
    const result = getFirstMsg(exec!, 36)
    expect(result).toBeDefined()
    const success = getFirstMsg(result!, 1)
    expect(success).toBeDefined()
    const servers = getRepeatedMsg(success!, 1)
    expect(servers).toHaveLength(1)
    const server = servers[0]!
    const serverFields = decodeFields(server)
    expect(fieldString(serverFields.find((f) => f.no === 1)!)).toBe("minimal-agent")
    expect(fieldString(serverFields.find((f) => f.no === 2)!)).toBe("minimal-agent")
    const toolRows = getRepeatedMsg(server, 5)
    expect(toolRows).toHaveLength(1)
    expect(getRepeatedString(toolRows[0]!, 5)).toEqual(["ModelInfo"])
    expect(getRepeatedString(toolRows[0]!, 4)).toEqual(["minimal-agent"])
  })

  test("filters servers to the requested identifiers", () => {
    const out = encodeAgentClientMcpStateResult({ id: 1, execId: "" }, tools, ["other-server"])
    const success = getFirstMsg(getFirstMsg(getFirstMsg(out, 2)!, 36)!, 1)!
    expect(getRepeatedMsg(success, 1)).toHaveLength(0)
  })
})

function execClientWrites(chunk: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = []
  for (const frame of parseConnectFrames(chunk)) {
    for (const f of decodeFields(frame.payload)) {
      if (f.no === 2 && f.wire === 2) {
        const b = fieldBytes(f)
        if (b) out.push(b)
      }
    }
  }
  return out
}

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
    { name: "ModelInfo", description: "meta", inputSchema: { type: "object", properties: {} } },
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

describe("cursor bidi mcp_state reply", () => {
  afterEach(() => {
    delete process.env.MA_CURSOR_BIDI_HEARTBEAT_MS
    resetCursorBidiSessionsForTests()
  })

  test("answers mcp_state with MA tools, then the turn continues and ends", async () => {
    process.env.MA_CURSOR_BIDI_HEARTBEAT_MS = "0"
    let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined
    let stateReply: Uint8Array | undefined
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        ctrl = controller
        controller.enqueue(mcpStateServerFrame({ ids: ["minimal-agent"] }))
      },
    })
    const client = fakeClient(stream, (chunk) => {
      for (const exec of execClientWrites(chunk)) {
        if (!getFirstMsg(exec, 36) || stateReply || !ctrl) continue
        stateReply = exec
        // Server only continues once the MCP state arrives.
        ctrl.enqueue(textFrame("GOT"))
        ctrl.enqueue(turnEndedFrame())
        ctrl.close()
      }
    })

    let text = ""
    const run = (async () => {
      for await (const ev of runCursorBidi(req, model as never, {
        url: "https://example.test/agent.v1.AgentService/Run",
        headers: {},
        initialRunBody: new Uint8Array([0]),
        sessionId: "mcp-state",
        modelId: "cursor-auto",
        networkClient: client,
      })) {
        if (ev.type === "text_delta") text += ev.text
      }
    })()
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("hung: mcp_state never answered")), 2000),
    )
    await Promise.race([run, timeout])

    expect(stateReply).toBeDefined()
    const server = getRepeatedMsg(getFirstMsg(getFirstMsg(stateReply!, 36)!, 1)!, 1)[0]!
    expect(getRepeatedString(getRepeatedMsg(server, 5)[0]!, 5)).toEqual(["ModelInfo"])
    expect(text).toBe("GOT")
  })
})
