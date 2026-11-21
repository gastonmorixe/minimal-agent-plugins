/**
 * LIVE e2e for the title side call: one real title request to the cheapest
 * Anthropic model, with the same shape that the title handler sends (SPEC
 * §5.1-§5.3, IMPL-PLAN §7 check A).
 *
 * NOT RUN BY DEFAULT. The `.e2e.ts` suffix keeps it out of a plain `bun test`,
 * and the suite also skips without `E2E=1` (or `MA_E2E_LIVE=1`) and a stored
 * credential. Opt in, from minimal-agent-plugins:
 *
 * ```sh
 * E2E=1 MA_E2E_CREDENTIAL_NAME=<credential-name> bun test ./ma-title-plugin/e2e/title.e2e.ts --timeout 60000
 * ```
 *
 * The `./` prefix is required: without it bun treats the name as a filter.
 * `MA_E2E_CREDENTIAL_NAME` has no default: without it the suite skips. The
 * test never prints the credential name or a secret.
 *
 * SAFETY
 * - The credential is read through `AuthStore.getSecrets` (read only). The
 *   token is never printed. No token refresh is done.
 * - No session file and no index line is written: the test calls the
 *   adapter directly, not the handler.
 * - Cost: 1 Messages call, about 1000 input and 30 output tokens on
 *   `claude-haiku-5-5` ($0.10 / $0.50 per M): about $0.0001.
 *
 * @module title/e2e/title.e2e
 */

import { describe, expect, it } from "bun:test"

import { AuthStore } from "@minimal-agent/core/host/auth-store"
import { createDefaultNetworkClient } from "@minimal-agent/core/host/network"
import type { CanonicalBlock } from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import type { CanonicalRequest } from "@minimal-agent/core/plugin-api/llm/canonical-request"
import type { ProviderAuth, RunContext } from "@minimal-agent/core/plugin-api/llm/provider-auth"
import type {
  NetworkClient,
  NetworkRequestInput,
  NetworkResponse,
} from "@minimal-agent/core/plugin-api/net/types"

import { anthropicAdapter, bootstrapAnthropic } from "../../ma-llm-anthropic-plugin/adapter.ts"
import { makeTestRegistry } from "../../ma-llm-anthropic-plugin/lib/test-registry.ts"
import {
  ANTHROPIC_PLAN_OAUTH,
  readAnthropicOAuthAuth,
} from "../../ma-llm-anthropic-plugin/oauth-login.ts"
import {
  buildBillingHeaderText,
  CLAUDE_CODE_IDENTITY,
} from "../../ma-llm-anthropic-plugin/system-prompt.ts"
import { pluginSideband } from "../../tests/support/sideband.ts"
import { SYSTEM_PROMPT, TITLE_MAX_TOKENS, TITLE_SCHEMA } from "../handlers/on_prompt_submitted.ts"
import { buildTitleInput } from "../lib/input.ts"
import { countWords, validateTitleResult } from "../lib/sanitize.ts"

// ---------------------------------------------------------------------------
// Opt-in gate
// ---------------------------------------------------------------------------

const on = (v: string | undefined): boolean => v === "1" || v === "true"
const LIVE =
  on(process.env.E2E) || on(process.env.MA_E2E_LIVE) || on(process.env.MINIMAL_AGENT_E2E_TITLE)
/** No default: the credential name is user data. Empty → the suite skips. */
const CREDENTIAL_NAME = (process.env.MA_E2E_CREDENTIAL_NAME ?? "").trim()
const MODEL_ID = process.env.MA_E2E_MODEL ?? "claude-haiku-5-5"
const PROMPT = "write the design spec for a title plugin"

function resolveLiveAuth(): ProviderAuth | null {
  try {
    const secrets = new AuthStore().getSecrets(ANTHROPIC_PLAN_OAUTH.id, CREDENTIAL_NAME)
    if (!secrets) return null
    const expiresAt = typeof secrets.expiresAt === "number" ? secrets.expiresAt : 0
    // Never refresh: an expired token means skip, not rotate.
    if (expiresAt > 0 && expiresAt < Date.now() + 60_000) return null
    return readAnthropicOAuthAuth(secrets)
  } catch {
    return null
  }
}

const AUTH = LIVE && CREDENTIAL_NAME !== "" ? resolveLiveAuth() : null
// The skip text never contains the credential name (user data).
const SKIP_REASON = !LIVE
  ? "set E2E=1 to run the live title e2e"
  : CREDENTIAL_NAME === ""
    ? "set MA_E2E_CREDENTIAL_NAME to the name of a stored credential"
    : AUTH === null
      ? `no usable stored credential (MA_E2E_CREDENTIAL_NAME) under "${ANTHROPIC_PLAN_OAUTH.id}"`
      : null
if (SKIP_REASON) console.log(`[title.e2e] skip: ${SKIP_REASON}`)

// ---------------------------------------------------------------------------
// Spy network client: records the beta header and the Messages body
// ---------------------------------------------------------------------------

interface SeenCall {
  url: string
  status: number
  beta: string
  body?: Record<string, unknown>
  errorBody?: string
}

const calls: SeenCall[] = []

function decodeBody(input: NetworkRequestInput): string | undefined {
  if (input.body === undefined) return undefined
  if (typeof input.body === "string") return input.body
  const gz = input.headers?.["content-encoding"] === "gzip"
  const bytes = gz ? Bun.gunzipSync(new Uint8Array(input.body)) : input.body
  return new TextDecoder().decode(bytes)
}

/** Wrap a response whose body was already read as text. */
function replay(res: NetworkResponse, text: string): NetworkResponse {
  return {
    status: res.status,
    headers: res.headers,
    transport: res.transport,
    ok: res.ok,
    body: new Response(text).body!,
    text: async () => text,
    json: async <T>() => JSON.parse(text) as T,
  }
}

function makeSpyClient(): NetworkClient {
  const real = createDefaultNetworkClient() as unknown as NetworkClient
  return {
    async request(input: NetworkRequestInput): Promise<NetworkResponse> {
      const call: SeenCall = {
        url: input.url,
        status: 0,
        beta: input.headers?.["anthropic-beta"] ?? "",
      }
      calls.push(call)
      if (input.url.startsWith("https://api.anthropic.com/v1/messages")) {
        const s = decodeBody(input)
        if (s) call.body = JSON.parse(s) as Record<string, unknown>
      }
      const res = await real.request(input)
      call.status = res.status
      if (!res.ok) {
        const text = await res.text()
        call.errorBody = text.slice(0, 300)
        return replay(res, text)
      }
      return res
    },
  }
}

// ---------------------------------------------------------------------------
// Request (the shape of the title handler, SPEC §5.1)
// ---------------------------------------------------------------------------

const reg = makeTestRegistry()
bootstrapAnthropic(reg.ctx)

/** The real codec: it strips the internal tags of the prompt and the title. */
const sb = await pluginSideband()

function titleRequest(): CanonicalRequest {
  const system: CanonicalBlock[] = [
    { type: "text", text: buildBillingHeaderText() },
    { type: "text", text: CLAUDE_CODE_IDENTITY },
    { type: "text", text: SYSTEM_PROMPT },
  ]
  return {
    modelId: MODEL_ID,
    purpose: "title",
    system,
    messages: [{ role: "user", content: [{ type: "text", text: buildTitleInput(PROMPT, sb) }] }],
    generation: { maxOutputTokens: TITLE_MAX_TOKENS },
    thinking: { mode: "off" },
    effort: "low",
    outputFormat: { type: "json_schema", schema: TITLE_SCHEMA, strict: true },
    // The title side call does not stream (profile stream "off"). The adapter
    // parses the one non-stream JSON Message.
    stream: false,
  }
}

interface RunResult {
  text: string
  stopReason: string | null
  input: number
  output: number
  latencyMs: number
}

async function runOnce(req: CanonicalRequest): Promise<RunResult> {
  const model = reg.resolveModel(MODEL_ID)
  const ctx: RunContext = {
    auth: AUTH!,
    sessionId: `e2e-title-${Date.now()}`,
    networkClient: makeSpyClient(),
  }
  const out: RunResult = { text: "", stopReason: null, input: 0, output: 0, latencyMs: 0 }
  const t0 = performance.now()
  for await (const ev of anthropicAdapter.run!(req, model, ctx)) {
    const e = ev as unknown as {
      type: string
      text?: string
      stopReason?: string | null
      initialUsage?: { inputTokens: number; outputTokens: number }
      usage?: { inputTokens: number; outputTokens: number }
    }
    if (e.type === "text_delta" && typeof e.text === "string") out.text += e.text
    if (e.type === "message_delta") out.stopReason = e.stopReason ?? null
    const usg = e.usage ?? e.initialUsage
    if (usg) {
      out.input = Math.max(out.input, usg.inputTokens)
      out.output = Math.max(out.output, usg.outputTokens)
    }
  }
  out.latencyMs = Math.round(performance.now() - t0)
  const price = model.pricing
  const cost = price ? (out.input * price.inputUSD + out.output * price.outputUSD) / 1e6 : NaN
  console.log(
    `[title.e2e] text=${JSON.stringify(out.text.trim())} stop=${String(out.stopReason)} ` +
      `in=${out.input} out=${out.output} ms=${out.latencyMs} cost=$${cost.toFixed(6)}`,
  )
  return out
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_REASON !== null)("title side call live e2e", () => {
  it("one title request gives a JSON title of 2 to 6 words", { timeout: 60_000 }, async () => {
    const res = await runOnce(titleRequest())

    const msg = calls.filter((c) => c.url.includes("/v1/messages")).at(-1)
    expect(msg).toBeDefined()
    console.log(`[title.e2e] anthropic-beta: ${msg!.beta}`)
    if (msg!.errorBody) console.log(`[title.e2e] error body: ${msg!.errorBody}`)
    expect(msg!.status).toBe(200)

    // The wire body has the title shape (SPEC §5.1): no stream, no temperature,
    // thinking disabled, a json_schema format.
    const body = msg!.body ?? {}
    expect(body.model).toBe(MODEL_ID)
    expect(body.stream).toBe(false)
    expect(body.temperature).toBeUndefined()
    expect(body.thinking).toEqual({ type: "disabled" })
    const fmt = (body.output_config as { format?: { type?: string } } | undefined)?.format
    expect(fmt?.type).toBe("json_schema")

    // The handler rules (SPEC §5.5).
    const json = JSON.parse(res.text) as { title?: unknown }
    const v = validateTitleResult({ stopReason: res.stopReason ?? undefined, json }, sb)
    expect(v).toMatchObject({ ok: true })
    if (!v.ok) return
    const words = countWords(v.title)
    expect(words).toBeGreaterThanOrEqual(2)
    expect(words).toBeLessThanOrEqual(6)
    expect(res.output).toBeLessThanOrEqual(TITLE_MAX_TOKENS)
  })
})
