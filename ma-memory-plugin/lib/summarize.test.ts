/**
 * Tests for {@link summarize}.
 *
 * All tests inject `completeFn` (the `llm:complete` capability the handler
 * wires from `ctx.host.llm.complete`) to avoid hitting the real host / API.
 * The plugin no longer touches auth or the transport wire shape — it hands
 * the host a `{system, userText, ...}` request and gets text back — so the
 * captured args are inspected in that neutral shape.
 */

import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { renderFor } from "../../tests/support/prompt-render.ts"

import {
  buildSystemPrompt,
  type CompleteFn,
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_RATIO,
  MIN_OUTPUT_RATIO,
  type RenderFn,
  SummarizeError,
  summarize,
} from "./summarize.ts"

/** Renderer from the real prompts.template provider, bound to this plugin dir. */
const render: RenderFn = renderFor("ma-memory-plugin", join(import.meta.dirname, ".."))

/** The request shape `ctx.host.llm.complete` receives. */
type CompleteReq = Parameters<CompleteFn>[0]

/**
 * Capture the args passed to the injected `completeFn`. The plugin hands the
 * host a `{system, userText, ...}` request and gets text back.
 */
function captureCompleteArgs(response: string): {
  completeFn: CompleteFn
  calls: CompleteReq[]
} {
  const calls: CompleteReq[] = []
  const completeFn: CompleteFn = async (req) => {
    calls.push(req)
    return response
  }
  return { completeFn, calls }
}

// A reasonably-sized input — 600 chars of plausible bullet content
const INPUT_600 = "- ".concat(
  Array.from({ length: 20 }, (_, i) => `[#abc${i}] [2026-05-14T00:00:00-04:00] body ${i}`).join(
    "\n- ",
  ),
)

// A response that comfortably clears MIN_OUTPUT_RATIO (5%) for INPUT_600.
const LONG_ENOUGH_RESPONSE =
  "## Cluster A\n- takeaway one. Sources: #abc1, #abc2\n- takeaway two. Sources: #abc3\n## Cluster B\n- takeaway three. Sources: #abc4, #abc5, #abc6\n"

describe("summarize — happy path", () => {
  it("sends the memoryMd as the user text", async () => {
    const { completeFn, calls } = captureCompleteArgs(LONG_ENOUGH_RESPONSE)
    await summarize(
      INPUT_600,
      { model: "claude-haiku-test", scope: "project" },
      { completeFn, render },
    )
    expect(calls.length).toBe(1)
    expect(calls[0].userText).toBe(INPUT_600)
  })

  it("uses the summarizer system prompt for the scope", async () => {
    const { completeFn, calls } = captureCompleteArgs(LONG_ENOUGH_RESPONSE)
    await summarize(
      INPUT_600,
      { model: "claude-haiku-test", scope: "project" },
      { completeFn, render },
    )
    expect(calls[0].system).toBe(buildSystemPrompt("project", render))
  })

  it("passes the configured model through", async () => {
    const { completeFn, calls } = captureCompleteArgs(LONG_ENOUGH_RESPONSE)
    await summarize(INPUT_600, { model: "claude-custom", scope: "project" }, { completeFn, render })
    expect(calls[0].model).toBe("claude-custom")
  })

  it("caps output tokens and forwards the timeout", async () => {
    const { completeFn, calls } = captureCompleteArgs(LONG_ENOUGH_RESPONSE)
    await summarize(
      INPUT_600,
      { model: "claude-haiku-test", scope: "project" },
      { completeFn, render },
    )
    expect(calls[0].maxTokens).toBe(8192)
    expect(calls[0].timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
  })

  it("returns the trimmed LLM output", async () => {
    const body =
      "## Cluster A\n- takeaway. Sources: #a, #b\n## Cluster B\n- another. Sources: #c, #d\n## Cluster C\n- third. Sources: #e, #f, #g"
    const response = "  \n" + body + "\n  \n"
    const { completeFn } = captureCompleteArgs(response)
    const out = await summarize(
      INPUT_600,
      { model: "claude-haiku-test", scope: "project" },
      { completeFn, render },
    )
    expect(out).toBe(body)
  })
})

describe("summarize — failure modes", () => {
  it("throws SummarizeError kind=send-failed when no completeFn is granted", async () => {
    let thrown: unknown
    try {
      await summarize(INPUT_600, { model: "claude-haiku-test", scope: "project" }, { render })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(SummarizeError)
    expect((thrown as SummarizeError).kind).toBe("send-failed")
  })

  it("throws SummarizeError kind=send-failed when completeFn throws", async () => {
    let thrown: unknown
    try {
      await summarize(
        INPUT_600,
        { model: "claude-haiku-test", scope: "project" },
        {
          render,
          completeFn: async () => {
            throw new Error("network down")
          },
        },
      )
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(SummarizeError)
    expect((thrown as SummarizeError).kind).toBe("send-failed")
  })

  /** Mimic a core CoreError: empty message, a `kind`, typed fields, toJSON. */
  function coreLike(kind: string, fields: Record<string, unknown>): Error {
    const err = new Error("")
    return Object.assign(err, {
      kind,
      ...fields,
      toJSON: () => ({ kind, fields }),
    })
  }

  async function sendFailedMessage(err: unknown): Promise<string> {
    try {
      await summarize(
        INPUT_600,
        { model: "claude-haiku-test", scope: "project" },
        {
          render,
          completeFn: async () => {
            throw err
          },
        },
      )
    } catch (e) {
      expect((e as SummarizeError).kind).toBe("send-failed")
      return (e as SummarizeError).message
    }
    throw new Error("summarize did not throw")
  }

  it("renders useful text for an empty-message NoProviderCredentialsError", async () => {
    const msg = await sendFailedMessage(
      coreLike("NoProviderCredentialsError", {
        providerId: "anthropic",
        modelId: "claude-x",
        credentialedProviders: [],
      }),
    )
    expect(msg).toContain('no credentials for provider "anthropic"')
    expect(msg).toContain("minimal-agent provider anthropic login")
  })

  it("renders text for the other auth kinds and names an unknown kind", async () => {
    expect(
      await sendFailedMessage(coreLike("NoProviderSelectedError", { modelId: "m1" })),
    ).toContain('no provider selected for model "m1"')
    expect(
      await sendFailedMessage(
        coreLike("GenericEndpointAuthError", { authType: "bearer", missing: "api-key" }),
      ),
    ).toContain("generic-endpoint auth-type bearer requires --api-key")
    expect(
      await sendFailedMessage(coreLike("UnhandledAuthTypeError", { authType: "zzz" })),
    ).toContain("unhandled generic-endpoint auth-type: zzz")
    expect(await sendFailedMessage(coreLike("SomeNewError", {}))).toContain("SomeNewError")
  })

  it("throws SummarizeError kind=timeout when the completion exceeds timeoutMs", async () => {
    let thrown: unknown
    try {
      await summarize(
        INPUT_600,
        { model: "claude-haiku-test", scope: "project", timeoutMs: 50 },
        {
          render,
          completeFn: () => new Promise((_resolve) => setTimeout(_resolve, 5000)),
        },
      )
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(SummarizeError)
    expect((thrown as SummarizeError).kind).toBe("timeout")
  })

  it("throws SummarizeError kind=empty-output for whitespace-only response", async () => {
    let thrown: unknown
    try {
      await summarize(
        INPUT_600,
        { model: "claude-haiku-test", scope: "project" },
        { render, completeFn: async () => "    \n\n   " },
      )
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(SummarizeError)
    expect((thrown as SummarizeError).kind).toBe("empty-output")
  })

  it("throws SummarizeError kind=too-short when output < MIN_OUTPUT_RATIO of input", async () => {
    const inputLen = INPUT_600.length
    const tooShort = "x".repeat(Math.floor(inputLen * MIN_OUTPUT_RATIO) - 1)
    let thrown: unknown
    try {
      await summarize(
        INPUT_600,
        { model: "claude-haiku-test", scope: "project" },
        { render, completeFn: async () => tooShort },
      )
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(SummarizeError)
    expect((thrown as SummarizeError).kind).toBe("too-short")
  })

  it("throws SummarizeError kind=too-long when output > input length", async () => {
    const tooLong = INPUT_600 + "x".repeat(10)
    let thrown: unknown
    try {
      await summarize(
        INPUT_600,
        { model: "claude-haiku-test", scope: "project" },
        { render, completeFn: async () => tooLong },
      )
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(SummarizeError)
    expect((thrown as SummarizeError).kind).toBe("too-long")
  })

  it("accepts output up to MAX_OUTPUT_RATIO of input", async () => {
    // Exactly at the input length (ratio 1.0) is allowed.
    const atLimit = "y".repeat(Math.floor(INPUT_600.length * MAX_OUTPUT_RATIO))
    const { completeFn } = captureCompleteArgs(atLimit)
    const out = await summarize(
      INPUT_600,
      { model: "claude-haiku-test", scope: "project" },
      { completeFn, render },
    )
    expect(out).toBe(atLimit)
  })
})
