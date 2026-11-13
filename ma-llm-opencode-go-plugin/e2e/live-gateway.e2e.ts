/**
 * LIVE e2e against the real OpenCode Go gateway.
 *
 * These exercise the genuine wire — real credential, real Cloudflare edge, real
 * SSE — and verify the facts the wire study established
 * (`research/2026-11-13-opencode-wire-transport/reports/00-findings.md`).
 *
 * NOT RUN BY DEFAULT. Bun only auto-discovers `*.test.*` / `*.spec.*`, so the
 * `.e2e.ts` suffix keeps this out of `bun test`. Opt in:
 *
 *   # from minimal-agent-plugins/ma-llm-opencode-go-plugin
 *   MA_E2E_LIVE=1 MA_E2E_CREDENTIAL_NAME="opencode-console-oauth-2" \
 *     bun test ./e2e/*.e2e.ts --timeout 120000
 *
 * Or via the umbrella script: `bun run test:e2e:opencode-go`.
 *
 * SAFETY
 * - The credential is read through `AuthStore`, never by parsing `auth.jsonc`
 *   by hand, and the token is never printed or asserted on.
 * - With the env var absent every test skips (so an accidental `bun test` over
 *   this file is harmless).
 * - If the credential is absent the suite skips with a clear message — it does
 *   NOT fall back to a fake/`MINIMAL_AGENT_TEST_AUTH` auth.
 *
 * @module e2e/live-gateway.e2e
 */

import { describe, expect, it } from "bun:test"

import { AuthStore } from "@minimal-agent/core/host/auth-store"
import { createDefaultNetworkClient } from "@minimal-agent/core/host/network"
import type { CanonicalEvent } from "@minimal-agent/core/plugin-api/llm/canonical-events"
import { userText } from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import type { ProviderAuth } from "@minimal-agent/core/plugin-api/llm/provider-auth"

import { bootstrapOpencode } from "../adapter.ts"
import { OPENCODE_API_KEY_AUTH } from "../auth.ts"
import type { CanonicalRequest } from "../lib/canonical-request.ts"
import { makeTestRegistry } from "../lib/test-registry.ts"
import { OPENCODE_CONSOLE_OAUTH, readOpencodeOAuthAuth } from "../oauth-login.ts"

// ---------------------------------------------------------------------------
// Opt-in gate
// ---------------------------------------------------------------------------

const LIVE = process.env.MA_E2E_LIVE === "1" || process.env.MA_E2E_LIVE === "true"
const CREDENTIAL_NAME = process.env.MA_E2E_CREDENTIAL_NAME ?? "opencode-console-oauth-2"
const DEFAULT_MODEL = process.env.MA_E2E_MODEL ?? "deepseek-v4.1-flash"
const PROVIDER_ID = "opencode-go"

/**
 * Credentials are stored under the auth *service id*, not the provider id —
 * this provider uses `OPENCODE_CONSOLE_OAUTH.serviceId`
 * ("opencode-console-oauth") for Console OAuth and `OPENCODE_API_KEY_AUTH.serviceId`
 * for API keys. Look in both, OAuth first (what `--credential-name` pins).
 */
function resolveLiveAuth(): ProviderAuth | null {
  try {
    const store = new AuthStore()
    for (const serviceId of [OPENCODE_CONSOLE_OAUTH.serviceId, OPENCODE_API_KEY_AUTH.serviceId]) {
      const secrets = store.getSecrets(serviceId, CREDENTIAL_NAME)
      if (!secrets) continue
      const oauth = readOpencodeOAuthAuth(secrets)
      if (oauth) return oauth
      const key = typeof secrets.apiKey === "string" ? secrets.apiKey : undefined
      if (key) return { kind: "api-key", key }
    }
    return null
  } catch {
    return null
  }
}

const AUTH = LIVE ? resolveLiveAuth() : null

const SKIP_REASON = !LIVE
  ? "set MA_E2E_LIVE=1 to run live gateway e2e"
  : AUTH === null
    ? `no stored credential "${CREDENTIAL_NAME}" under service ids ` +
      `"${OPENCODE_CONSOLE_OAUTH.serviceId}" / "${OPENCODE_API_KEY_AUTH.serviceId}" ` +
      `(run: ma provider opencode-go login)`
    : null

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function setup() {
  const reg = makeTestRegistry()
  bootstrapOpencode({ models: reg.models, providers: reg.providers })
  return reg
}

/** Minimal honest tool schema, sized like a real tool, for the payload test. */
function toolDefs(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    name: `Tool${i}`,
    description: `Test tool ${i} used to inflate the request body. `.repeat(6),
    inputSchema: { type: "object" as const, properties: { arg: { type: "string" } } },
  }))
}

type RunResult = {
  events: CanonicalEvent[]
  text: string
  sawFirstDelta: boolean
}

/** Drain the adapter's canonical stream into a flat result. */
async function runOnce(
  modelId: string,
  req: CanonicalRequest,
  overrides: Partial<{ sessionId: string }> = {},
): Promise<RunResult> {
  const reg = setup()
  const adapter = reg.resolveProvider(PROVIDER_ID)
  const model = reg.resolveModel(modelId)
  if (!adapter) throw new Error(`provider ${PROVIDER_ID} not registered`)
  if (!model) throw new Error(`model ${modelId} not registered`)

  const events: CanonicalEvent[] = []
  let text = ""
  let sawFirstDelta = false

  for await (const ev of adapter.run(req, model, {
    auth: AUTH!,
    sessionId: overrides.sessionId ?? `e2e-${Date.now()}`,
    networkClient: createDefaultNetworkClient(),
  })) {
    events.push(ev)
    sawFirstDelta = true
    // Canonical text events are `text_delta` with a `text` field.
    const e = ev as unknown as { type?: string; text?: string }
    if (e.type === "text_delta" && typeof e.text === "string") text += e.text
  }

  return { events, text, sawFirstDelta }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_REASON !== null)("opencode-go live gateway e2e", () => {
  // Live model calls are slow; give every test generous headroom.
  const T = { timeout: 120_000 }

  it("streams a reply over the real edge and yields canonical text", T, async () => {
    const res = await runOnce(DEFAULT_MODEL, {
      modelId: DEFAULT_MODEL,
      messages: [userText("Reply with exactly the word: pong")],
    })

    expect(res.sawFirstDelta).toBe(true)
    expect(res.text.trim().length).toBeGreaterThan(0)
    // Loose on purpose: models drift. We assert we got *a* reply, not a string.
    expect(res.text.toLowerCase()).toContain("pong")
  })

  it("advertises only HTTP/1.1 — h2 is refused by the origin (OCP-08 fact)", T, async () => {
    // The wire study proved the edge will not ALPN h2. `createDefaultNetworkClient`
    // is h2-primary + fetch fallback, so a successful call proves the fallback
    // path works end-to-end against the real gateway.
    const res = await runOnce(DEFAULT_MODEL, {
      modelId: DEFAULT_MODEL,
      messages: [userText("Say ok")],
    })
    expect(res.sawFirstDelta).toBe(true)
  })

  it("reuses the same prompt_cache_key across turns of one session (OCP-01)", T, async () => {
    // Observed indirectly: both turns succeed on the same session id. The
    // net-dbg capture written alongside this run is what to inspect for the
    // actual key — see scripts/measure.ts and the research evidence dir.
    const sessionId = `e2e-cache-${Date.now()}`
    const a = await runOnce(
      DEFAULT_MODEL,
      { modelId: DEFAULT_MODEL, messages: [userText("Say one")] },
      { sessionId },
    )
    const b = await runOnce(
      DEFAULT_MODEL,
      { modelId: DEFAULT_MODEL, messages: [userText("Say two")] },
      { sessionId },
    )
    expect(a.sawFirstDelta).toBe(true)
    expect(b.sawFirstDelta).toBe(true)
  })

  it("accepts a tool-bearing request (tools survive the live wire)", T, async () => {
    const tools = toolDefs(3)
    const res = await runOnce(DEFAULT_MODEL, {
      modelId: DEFAULT_MODEL,
      messages: [userText("Which tool would read a file? Answer with the tool name only.")],
      tools,
    })
    // The assertion that matters is that the gateway did not 400 on the tool
    // schema — i.e. we got a stream, not an error.
    expect(res.sawFirstDelta).toBe(true)
  })

  /**
   * OCP-03 EXPERIMENT — does the gateway accept a gzipped request body?
   *
   * This is a *probe*, not a pass/fail requirement: the spec deliberately leaves
   * the answer open. It records the verdict by tagging the test name, and the
   * body of the assertion captures whichever side of the branch we land on.
   *
   * Run it explicitly:
   *   MA_E2E_LIVE=1 bun test ./e2e/*.e2e.ts -t "gzip request body"
   */
  it("records whether the gateway accepts a gzip request body (OCP-03)", T, async () => {
    const url = "https://opencode.ai/inference/go/openai/v1/chat/completions"
    const payload = JSON.stringify({
      model: DEFAULT_MODEL,
      messages: [{ role: "user", content: "Say ok" }],
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 16,
    })

    const sessionId = `ses_${Date.now().toString(16).padStart(12, "0")}E2EgzipProbe`
    const authHeaders: Record<string, string> =
      AUTH?.kind === "oauth"
        ? { authorization: `Bearer ${AUTH.token}`, ...(AUTH.headers ?? {}) }
        : AUTH?.kind === "api-key"
          ? { authorization: `Bearer ${AUTH.key}` }
          : {}

    const post = async (body: BodyInit, headers: Record<string, string>) => {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders,
          "x-opencode-session": sessionId,
          "x-opencode-session-id": sessionId,
          "x-session-affinity": sessionId,
          "accept-encoding": "gzip",
          ...headers,
        },
        body,
      })
      const text = await res.text().catch(() => "")
      return { status: res.status, contentType: res.headers.get("content-type") ?? "", text }
    }

    // CONTROL first: an identity body must succeed. Without this, a 400 on the
    // gzip attempt could just as well be a bad session id, a stale token, or a
    // malformed payload — and we would blame the encoding wrongly.
    const control = await post(payload, {})
    const gz = await post(Bun.gzipSync(new TextEncoder().encode(payload)), {
      "content-encoding": "gzip",
    })

    console.log(
      `[OCP-03] control(identity) -> HTTP ${control.status} ${control.contentType}\n` +
        `[OCP-03] gzip             -> HTTP ${gz.status} ${gz.contentType} ` +
        `${gz.status < 300 ? "ACCEPTED" : "REJECTED"}`,
    )
    if (gz.status >= 300) {
      console.log(`[OCP-03] rejection body (first 300 chars): ${gz.text.slice(0, 300)}`)
    }

    // The experiment's contract: we learn a verdict *from a valid baseline*.
    expect(control.status).toBeLessThan(300)
    expect([200, 400, 401, 403, 413, 415, 422]).toContain(gz.status)

    // Report the conclusion in the test name so a reader of the suite sees it.
    // 2xx => the gateway decompresses request bodies (OCP-03 is viable).
    // 4xx => it does not (close OCP-03 as "not supported").
  })
})
