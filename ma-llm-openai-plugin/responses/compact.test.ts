/**
 * OpenAI /responses/compact request + output mapping tests.
 */
import { describe, expect, it } from "bun:test"

import { userText } from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import type { ProviderAuth } from "@minimal-agent/core/plugin-api/llm/provider-auth"

import { pluginSideband } from "../../tests/support/sideband.ts"
import type { CanonicalRequest } from "../lib/canonical-request.ts"
import type { ModelEntry } from "../lib/host-types.ts"
import { resolveModel } from "../openai.test-helpers.ts"

import {
  buildOpenAIResponsesCompactBody,
  compactOutputToMessages,
  openAICompactUrl,
  REMOTE_CHECKPOINT_PROSE,
  REMOTE_EMPTY_CHECKPOINT_PROSE,
} from "./compact.ts"

// The real codec and kinds: the checkpoint tag is rendered with the session API.
const sb = await pluginSideband()

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
    const msgs = compactOutputToMessages([{ type: "compaction", encrypted_content: "enc_abc" }], sb)
    expect(msgs.length).toBe(1)
    expect(msgs[0].role).toBe("user")
    const [node] = sb.find(msgs[0].content, { kinds: ["compaction"] })
    expect(node?.attrs).toEqual({ kind: "remote", enc: encodeURIComponent("enc_abc") })
    expect(msgs[0].content).toBe(
      `${sb.render("compaction", { attrs: { kind: "remote", enc: "enc_abc" } })}\n${REMOTE_CHECKPOINT_PROSE}`,
    )
  })

  it("keeps message text and drops developer wrappers", () => {
    const msgs = compactOutputToMessages(
      [
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
      ],
      sb,
    )
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(msgs[0].content).toBe("keep me")
    expect(msgs[1].content).toBe("summary")
  })

  it("returns an empty-marker when output is empty", () => {
    const msgs = compactOutputToMessages([], sb)
    expect(sb.find(msgs[0].content, { kinds: ["compaction"] })[0]?.attrs).toEqual({
      kind: "remote-empty",
    })
  })

  it("with no codec (NO_SIDEBAND) the checkpoint is the prose alone (the core rule)", () => {
    const none = { ...sb, ready: false } as typeof sb
    for (const api of [none, undefined]) {
      expect(
        compactOutputToMessages([{ type: "compaction", encrypted_content: "e" }], api),
      ).toEqual([{ role: "user", content: REMOTE_CHECKPOINT_PROSE }])
      expect(compactOutputToMessages([], api)).toEqual([
        { role: "user", content: REMOTE_EMPTY_CHECKPOINT_PROSE },
      ])
    }
  })

  it("with no compaction kind (its plugin is off) the checkpoint is the prose alone", () => {
    const noKind = { ...sb, kindInfo: () => undefined } as typeof sb
    expect(compactOutputToMessages([{ type: "compaction" }], noKind)[0]?.content).toBe(
      REMOTE_CHECKPOINT_PROSE,
    )
  })
})
