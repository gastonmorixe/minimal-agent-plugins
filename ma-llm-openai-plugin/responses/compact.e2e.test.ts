/**
 * E2E: openaiAdapter.compact against a mock NetworkClient.
 */
import { describe, expect, it } from "bun:test"

import { openaiAdapter } from "../adapter.ts"
import { userText } from "../lib/canonical-messages.ts"
import type { CanonicalRequest } from "../lib/canonical-request.ts"
import type { NetworkClient, NetworkResponse } from "../lib/net-types.ts"
import type { ProviderAuth, RunContext } from "../lib/provider-auth.ts"
import { resolveModel } from "../openai.test-helpers.ts"

function jsonResponse(status: number, body: unknown): NetworkResponse {
  const text = JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => text,
    body: null,
  } as unknown as NetworkResponse
}

describe("openaiAdapter.compact e2e", () => {
  it("POSTs /responses/compact and maps encrypted output", async () => {
    const model = resolveModel("gpt-5.6-terra")
    let capturedUrl = ""
    let capturedBody = ""
    const networkClient: NetworkClient = {
      async request(input) {
        capturedUrl = input.url
        capturedBody = typeof input.body === "string" ? input.body : ""
        return jsonResponse(200, {
          output: [{ type: "compaction", encrypted_content: "ENC_PAYLOAD" }],
        })
      },
    }
    const auth: ProviderAuth = { kind: "api-key", key: "sk-test" }
    const ctx: RunContext = {
      auth,
      sessionId: "t",
      networkClient,
    }
    const req: CanonicalRequest = {
      modelId: model.id,
      messages: [userText("long history…"), userText("more")],
      stream: false,
    }
    const result = await openaiAdapter.compact!({ req }, model, ctx)
    expect(result.kind).toBe("remote")
    expect(capturedUrl).toBe("https://api.openai.com/v1/responses/compact")
    expect(capturedBody).toContain("long history")
    expect(result.replacementMessages[0]?.content).toContain("ENC_PAYLOAD")
  })

  it("uses Codex OAuth compact URL", async () => {
    const model = resolveModel("gpt-5.6-terra")
    let capturedUrl = ""
    const networkClient: NetworkClient = {
      async request(input) {
        capturedUrl = input.url
        return jsonResponse(200, {
          output: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "summary" }],
            },
          ],
        })
      },
    }
    const ctx: RunContext = {
      auth: {
        kind: "oauth",
        token: "tok",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
      sessionId: "t",
      networkClient,
    }
    await openaiAdapter.compact!(
      { req: { modelId: model.id, messages: [userText("x")], stream: false } },
      model,
      ctx,
    )
    expect(capturedUrl).toBe("https://chatgpt.com/backend-api/codex/responses/compact")
  })
})
