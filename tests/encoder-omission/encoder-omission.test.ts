/**
 * T6 (SPEC v6.1 D9, leader decision L4): every LLM encoder omits the internal
 * tool_result keys `outcome` and `sideband` from the wire body.
 *
 * For each encoder: encode one small conversation (user turn, assistant
 * tool_use, user tool_result) two times. One time the tool_result has
 * `sideband` and `outcome`, one time it does not. The wire body must not
 * contain the two keys, and the two bodies must be byte-equal.
 *
 * All builders are pure and offline. Cursor puts random UUIDs in the protobuf
 * body (proto/agent-run.ts:105 messageId, :166 conversationId), so the test
 * pins crypto.randomUUID while it builds the Cursor body.
 */

import { describe, expect, spyOn, test } from "bun:test"

import type { CanonicalMessage } from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import { defaultCapabilities } from "@minimal-agent/core/plugin-api/llm/capabilities"
import { buildOpenAIChatBody as buildCoreOpenAIChatBody } from "@minimal-agent/core/plugin-api/llm/openai-chat"

import { buildAnthropicRequestBody as buildAnthropic } from "../../ma-llm-anthropic-plugin/request-body.ts"
import { cursorCaps } from "../../ma-llm-cursor-plugin/capabilities.ts"
import { buildCursorAgentRunBody } from "../../ma-llm-cursor-plugin/request-body.ts"
import { CURSOR_SURFACE_AGENT_RUN } from "../../ma-llm-cursor-plugin/wire-constants.ts"
import { buildOpenAIResponsesBody as buildGrokResponses } from "../../ma-llm-grok-plugin/responses/request-body.ts"
import { buildOpenAIResponsesBody as buildMetaResponses } from "../../ma-llm-meta-plugin/responses/request-body.ts"
import { ollamaCaps } from "../../ma-llm-ollama-plugin/capabilities.ts"
import { buildOllamaChatBody } from "../../ma-llm-ollama-plugin/request-body.ts"
import { buildOpenAIChatBody as buildOpenAIChat } from "../../ma-llm-openai-plugin/chat/request-body.ts"
import { buildOpenAIResponsesBody as buildOpenAIResponses } from "../../ma-llm-openai-plugin/responses/request-body.ts"
import { buildAnthropicRequestBody as buildGoAnthropic } from "../../ma-llm-opencode-go-plugin/lib/anthropic-request.ts"
import { buildOpenAIResponsesBody as buildGoResponses } from "../../ma-llm-opencode-go-plugin/responses/request-body.ts"
import { buildAnthropicRequestBody as buildZenAnthropic } from "../../ma-llm-opencode-zen-plugin/lib/anthropic-request.ts"
import { buildOpenAIResponsesBody as buildZenResponses } from "../../ma-llm-opencode-zen-plugin/responses/request-body.ts"

const RESULT_TEXT = "file contents: hello"

const SIDEBAND = { kind: "probe-mark" }
const OUTCOME = { v: 1, bodyEnd: RESULT_TEXT.length, annotations: [] }

/** The canonical conversation. `marked` adds `sideband` and `outcome` to the tool_result. */
function conversation(marked: boolean): CanonicalMessage[] {
  const toolResult: Record<string, unknown> = {
    type: "tool_result",
    toolUseId: "call_1",
    content: [{ type: "text", text: RESULT_TEXT }],
  }
  if (marked) {
    toolResult.sideband = SIDEBAND
    toolResult.outcome = OUTCOME
  }
  return [
    { role: "user", content: [{ type: "text", text: "read the file" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Reading." },
        { type: "tool_use", id: "call_1", name: "Read", input: { path: "a.txt" } },
      ],
    },
    { role: "user", content: [toolResult as never] },
  ]
}

const PRICING = { inputUSD: 0, outputUSD: 0, cacheWriteUSD: 0, cacheReadUSD: 0 }

function modelView(providerId: string, surfaceId: string, capabilities = defaultCapabilities()) {
  return {
    id: "m",
    providerId,
    surfaceId,
    displayName: "m",
    capabilities: {
      ...capabilities,
      maxOutputTokens: Math.max(capabilities.maxOutputTokens, 1024),
    },
    pricing: { ...PRICING, webSearchPerCallUSD: 0 },
  }
}

const SYSTEM = [{ type: "text" as const, text: "You are a test agent." }]

/** A request with system, one tool and the conversation. */
function request(marked: boolean) {
  return {
    modelId: "m",
    system: SYSTEM,
    messages: conversation(marked),
    tools: [
      {
        name: "Read",
        description: "Read a file.",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      },
    ],
    generation: { maxOutputTokens: 512 },
    metadata: { sessionId: "t6-session" },
  }
}

/** One encoder: a name, the build path, and a function that gives the wire bytes as a string. */
interface EncoderCase {
  name: string
  path: string
  encode: (marked: boolean) => string
}

const json = (v: unknown) => JSON.stringify(v)

const CASES: EncoderCase[] = [
  {
    name: "OpenAI Chat (ma-llm-openai-plugin)",
    path: "ma-llm-openai-plugin/chat/request-body.ts buildOpenAIChatBody",
    encode: (m) =>
      json(
        buildOpenAIChat(
          request(m) as never,
          modelView("openai", "openai-chat-completions") as never,
        ),
      ),
  },
  {
    name: "OpenAI Chat shared core builder (clinepass, huggingface, wafer, generic-endpoint)",
    path: "@minimal-agent/core/plugin-api/llm/openai-chat buildOpenAIChatBody",
    encode: (m) =>
      json(
        buildCoreOpenAIChatBody(
          request(m) as never,
          modelView("openai", "openai-chat-completions") as never,
        ),
      ),
  },
  {
    name: "OpenAI Chat shared core builder, openrouter options",
    path: "@minimal-agent/core/plugin-api/llm/openai-chat buildOpenAIChatBody + {video,fileUrl} (ma-llm-openrouter-plugin/adapter.ts:68)",
    encode: (m) =>
      json(
        buildCoreOpenAIChatBody(
          request(m) as never,
          modelView("openrouter", "openai-chat-completions") as never,
          undefined,
          { video: true, fileUrl: true },
        ),
      ),
  },
  {
    name: "OpenAI Responses (ma-llm-openai-plugin)",
    path: "ma-llm-openai-plugin/responses/request-body.ts buildOpenAIResponsesBody",
    encode: (m) =>
      json(
        buildOpenAIResponses(request(m) as never, modelView("openai", "openai-responses") as never),
      ),
  },
  {
    name: "Responses (ma-llm-grok-plugin)",
    path: "ma-llm-grok-plugin/responses/request-body.ts buildOpenAIResponsesBody",
    encode: (m) =>
      json(buildGrokResponses(request(m) as never, modelView("grok", "openai-responses") as never)),
  },
  {
    name: "Responses (ma-llm-meta-plugin)",
    path: "ma-llm-meta-plugin/responses/request-body.ts buildOpenAIResponsesBody",
    encode: (m) =>
      json(buildMetaResponses(request(m) as never, modelView("meta", "openai-responses") as never)),
  },
  {
    name: "Responses (ma-llm-opencode-go-plugin)",
    path: "ma-llm-opencode-go-plugin/responses/request-body.ts buildOpenAIResponsesBody",
    encode: (m) =>
      json(
        buildGoResponses(
          request(m) as never,
          modelView("opencode-go", "openai-responses") as never,
        ),
      ),
  },
  {
    name: "Responses (ma-llm-opencode-zen-plugin)",
    path: "ma-llm-opencode-zen-plugin/responses/request-body.ts buildOpenAIResponsesBody",
    encode: (m) =>
      json(
        buildZenResponses(
          request(m) as never,
          modelView("opencode-zen", "openai-responses") as never,
        ),
      ),
  },
  {
    name: "Ollama",
    path: "ma-llm-ollama-plugin/request-body.ts buildOllamaChatBody",
    encode: (m) =>
      json(
        buildOllamaChatBody(
          request(m) as never,
          modelView(
            "ollama",
            "custom",
            ollamaCaps({ contextWindow: 128_000, vision: false }),
          ) as never,
        ),
      ),
  },
  {
    name: "Anthropic (re-export of the core builder)",
    path: "ma-llm-anthropic-plugin/request-body.ts -> plugin-api/llm/anthropic-request buildAnthropicRequestBody",
    encode: (m) =>
      json(
        buildAnthropic(request(m) as never, modelView("anthropic", "anthropic-messages") as never),
      ),
  },
  {
    name: "Anthropic (ma-llm-opencode-go-plugin vendored)",
    path: "ma-llm-opencode-go-plugin/lib/anthropic-request.ts buildAnthropicRequestBody",
    encode: (m) =>
      json(
        buildGoAnthropic(
          request(m) as never,
          modelView("opencode-go", "anthropic-messages") as never,
        ),
      ),
  },
  {
    name: "Anthropic (ma-llm-opencode-zen-plugin vendored)",
    path: "ma-llm-opencode-zen-plugin/lib/anthropic-request.ts buildAnthropicRequestBody",
    encode: (m) =>
      json(
        buildZenAnthropic(
          request(m) as never,
          modelView("opencode-zen", "anthropic-messages") as never,
        ),
      ),
  },
  {
    name: "Cursor (protobuf AgentRun body)",
    path: "ma-llm-cursor-plugin/request-body.ts buildCursorAgentRunBody",
    encode: (m) => {
      const model = {
        ...modelView("cursor", CURSOR_SURFACE_AGENT_RUN, cursorCaps()),
        id: "cursor-auto",
        vendorIds: { cursor: "default" },
      }
      const body = buildCursorAgentRunBody(
        { ...request(m), modelId: "cursor-auto" } as never,
        model as never,
      )
      // Byte view as a latin1 string: one char per byte, so equal strings mean equal bytes.
      return Buffer.from(body).toString("latin1")
    },
  },
]

/** The wire must have the result text, no internal key, and the same bytes as the plain build. */
function assertOmitted(encode: (marked: boolean) => string): void {
  const spy = spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000000")
  try {
    const marked = encode(true)
    const plain = encode(false)
    // The tool result text reaches the wire (the case is not empty).
    expect(marked).toContain(RESULT_TEXT)
    expect(marked).not.toContain("outcome")
    expect(marked).not.toContain("sideband")
    expect(marked).not.toContain("probe-mark")
    expect(marked).not.toContain("bodyEnd")
    expect(marked).toBe(plain)
  } finally {
    spy.mockRestore()
  }
}

describe("T6: encoders omit tool_result outcome and sideband", () => {
  for (const c of CASES) test(c.name, () => assertOmitted(c.encode))
})

/** A tool_result block, with or without the internal keys. */
function resultBlock(marked: boolean): never {
  return {
    type: "tool_result",
    toolUseId: "call_1",
    content: [{ type: "text", text: RESULT_TEXT }],
    ...(marked ? { sideband: SIDEBAND, outcome: OUTCOME } : {}),
  } as never
}

/** A request whose last message is `last` (after the user and assistant turns). */
function requestWith(last: CanonicalMessage) {
  const base = request(false)
  return { ...base, messages: [...base.messages.slice(0, 2), last] }
}

/**
 * The 3 paths that serialize a whole non-text block to JSON text. Worker W2
 * fixes them in parallel (stringifyWireBlock). If one of these cases fails,
 * re-run it after the W2 change lands. The cases above do not depend on W2.
 */
describe("T6 (depends on the W2 plugin fix): JSON-serialized non-text blocks", () => {
  test("OpenAI Chat role:tool message with a tool_result block (chat/request-body.ts canonicalMessageToChat)", () =>
    assertOmitted((m) =>
      json(
        buildOpenAIChat(
          requestWith({
            role: "tool",
            toolCallId: "call_1",
            content: [resultBlock(m)],
          } as never) as never,
          modelView("openai", "openai-chat-completions") as never,
        ),
      ),
    ))

  test("opencode-go mid-conversation system message with a tool_result block (lib/anthropic-request.ts)", () =>
    assertOmitted((m) =>
      json(
        buildGoAnthropic(
          requestWith({
            role: "system",
            content: [{ type: "text", text: "note" }, resultBlock(m)],
          }) as never,
          modelView("opencode-go", "anthropic-messages") as never,
        ),
      ),
    ))

  test("opencode-zen mid-conversation system message with a tool_result block (lib/anthropic-request.ts)", () =>
    assertOmitted((m) =>
      json(
        buildZenAnthropic(
          requestWith({
            role: "system",
            content: [{ type: "text", text: "note" }, resultBlock(m)],
          }) as never,
          modelView("opencode-zen", "anthropic-messages") as never,
        ),
      ),
    ))
})
