/**
 * OpenAI /responses/compact request + output mapping tests.
 */
import { describe, expect, it } from "bun:test"

import { userText } from "../lib/canonical-messages.ts"
import type { CanonicalRequest } from "../lib/canonical-request.ts"
import type { ModelEntry } from "../lib/host-types.ts"
import type { ProviderAuth } from "../lib/provider-auth.ts"
import { resolveModel } from "../openai.test-helpers.ts"

import {
  buildOpenAIResponsesCompactBody,
  COMPACTION_MARKER_PREFIX,
  compactOutputToMessages,
  openAICompactUrl,
} from "./compact.ts"

describe("buildOpenAIResponsesCompactBody", () => {
  it("builds a non-stream compact body from a canonical request", () => {
    const model = resolveModel("gpt-5.6-terra")
    const req: CanonicalRequest = {
      modelId: model.id,
      messages: [userText("hello compact")],
      system: [{ type: "text", text: "You are compacting." }],
      stream: false,
    }
    const body = buildOpenAIResponsesCompactBody(req, model as ModelEntry)
    expect(body.model).toBeTruthy()
    expect(body.instructions).toContain("compacting")
    expect(Array.isArray(body.input)).toBe(true)
    expect(JSON.stringify(body.input)).toContain("hello compact")
    expect((body as { stream?: boolean }).stream).toBeUndefined()
    expect((body as { store?: boolean }).store).toBeUndefined()
  })
})

describe("openAICompactUrl", () => {
  it("uses public API path for api-key auth", () => {
    const auth: ProviderAuth = { kind: "api-key", key: "sk-test" }
    expect(openAICompactUrl(auth)).toBe("https://api.openai.com/v1/responses/compact")
  })

  it("uses Codex backend path for OAuth", () => {
    const auth: ProviderAuth = {
      kind: "oauth",
      token: "tok",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    }
    expect(openAICompactUrl(auth)).toBe("https://chatgpt.com/backend-api/codex/responses/compact")
  })
})

describe("compactOutputToMessages", () => {
  it("folds encrypted compaction items into a checkpoint marker", () => {
    const msgs = compactOutputToMessages([{ type: "compaction", encrypted_content: "enc_abc" }])
    expect(msgs.length).toBe(1)
    expect(msgs[0].role).toBe("user")
    expect(msgs[0].content).toContain(COMPACTION_MARKER_PREFIX)
    expect(msgs[0].content).toContain(encodeURIComponent("enc_abc"))
  })

  it("keeps message text and drops developer wrappers", () => {
    const msgs = compactOutputToMessages([
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "stale instructions" }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "keep me" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "summary" }],
      },
    ])
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(msgs[0].content).toBe("keep me")
    expect(msgs[1].content).toBe("summary")
  })

  it("returns an empty-marker when output is empty", () => {
    const msgs = compactOutputToMessages([])
    expect(msgs[0].content).toContain("remote-empty")
  })
})
