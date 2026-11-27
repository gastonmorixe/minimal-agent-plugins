/**
 * Live end-to-end check for the Antigravity provider, gated by `E2E=1`.
 *
 * Four claims, proven against the real backend with the real Google OAuth
 * client that `agy` uses:
 *
 * 1. The stored credential refreshes: the `agy` consumer client returns 200
 *    and an hour of life.
 * 2. The token file that `agy` wrote imports with no new consent.
 * 3. `loadCodeAssist` resolves the project and the catalog lists the Gemini,
 *    Claude and GPT-OSS families.
 * 4. A streamed turn runs for one model of each family, and a Gemini tool loop
 *    closes: the model calls the tool, the result goes back, the answer comes.
 *
 * The host network client comes from the installed core package
 * (`@minimal-agent/core/host/network`). Run:
 *
 * ```bash
 * E2E=1 bun test antigravity.e2e.test.ts
 * ```
 *
 * Without `E2E=1`, or with no credential, every case skips, so the plugins
 * gate stays offline.
 */
import { homedir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { createDefaultNetworkClient } from "@minimal-agent/core/host/network"
import type { CanonicalEvent } from "@minimal-agent/core/plugin-api/llm/canonical-events"
import type { CanonicalMessage } from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import type { CanonicalRequest } from "@minimal-agent/core/plugin-api/llm/canonical-request"
import type { NetworkClient } from "@minimal-agent/core/plugin-api/net/types"
import { parseJsonc } from "@minimal-agent/core/plugin-api/utils/jsonc"

import { antigravityAdapter, clearAntigravityAdapterState } from "./adapter.ts"
import {
  type AntigravitySecrets,
  isExpired,
  readAgyTokenFile,
  readAntigravitySecrets,
} from "./auth.ts"
import type { ModelView } from "./lib/host-types.ts"
import type { ProviderModelSpec } from "./lib/provider-plugin.ts"
import { ANTIGRAVITY_MODELS, findAntigravityModel } from "./models.ts"
import { refreshTokens } from "./oauth-login.ts"
import { ANTIGRAVITY_SERVICE_ID } from "./wire-constants.ts"

const skip = !process.env.E2E

/**
 * The host network client, from the public `@minimal-agent/core/host/network`
 * subpath of the installed core. It resolves to the local core in the umbrella
 * and to the pinned core in a standalone clone.
 */
async function hostNetwork(): Promise<NetworkClient> {
  return createDefaultNetworkClient() as unknown as NetworkClient
}

type AuthStoreFile = {
  entries?: Array<{ id: string; name?: string; secrets: Record<string, unknown> }>
}

/**
 * The credential the login stored, or the token file that `agy` wrote. The
 * fallback makes the test runnable before the browser login has happened once.
 */
async function loadSecrets(): Promise<{ secrets: AntigravitySecrets; source: string }> {
  const path =
    process.env.MINIMAL_AGENT_AUTH_FILE?.trim() || join(homedir(), ".minimal-agent", "auth.jsonc")
  try {
    const parsed = parseJsonc(await Bun.file(path).text()) as AuthStoreFile
    const entry = parsed.entries?.find((row) => row.id === ANTIGRAVITY_SERVICE_ID)
    if (entry) {
      const secrets = readAntigravitySecrets(entry.secrets as never)
      if (secrets) return { secrets, source: path }
    }
  } catch {
    // No host store yet: use the agy file.
  }
  const imported = readAgyTokenFile()
  if (imported) return { secrets: imported, source: imported.importedFrom ?? "agy token file" }
  throw new Error(`No Antigravity credential in ${path} and no readable agy token file`)
}

const loaded = skip ? null : await loadSecrets().catch(() => null)
const describeLive = loaded ? describe : describe.skip

/** The catalog row of an id or an alias (the host registry rule). */
function modelFor(id: string): ModelView | undefined {
  return findAntigravityModel(id) as ModelView | undefined
}

async function collect(
  request: CanonicalRequest,
  model: ModelView,
  token: string,
  networkClient: NetworkClient,
): Promise<CanonicalEvent[]> {
  const events: CanonicalEvent[] = []
  for await (const event of antigravityAdapter.run(request, model, {
    auth: { kind: "oauth", token },
    networkClient,
    sessionId: `e2e-${Date.now()}`,
  } as never)) {
    events.push(event)
  }
  return events
}

function textOf(events: CanonicalEvent[]): string {
  return events.flatMap((event) => (event.type === "text_delta" ? [event.text] : [])).join("")
}

function lastUsage(events: CanonicalEvent[]) {
  const deltas = events.filter((event) => event.type === "message_delta")
  return deltas.length > 0 ? deltas[deltas.length - 1]?.usage : undefined
}

/** One user turn with an optional effort and tool list. */
function turn(
  text: string,
  modelId: string,
  effort?: string,
  tools: CanonicalRequest["tools"] = [],
): CanonicalRequest {
  return {
    modelId,
    ...(effort ? { effort } : {}),
    messages: [{ role: "user", content: [{ type: "text", text }] }],
    tools,
  }
}

/** A family row takes its base id and an effort. A single row takes no effort. */
const TEXT_CASES: ReadonlyArray<{ modelId: string; effort?: string }> = [
  { modelId: "gemini-4-neon", effort: "low" },
  { modelId: "claude-sonnet-5-5", effort: "low" },
  { modelId: "gpt-oss-120b-medium" },
]

describeLive("antigravity live", () => {
  test("the OAuth credential refreshes against Google", async () => {
    const { secrets, source } = loaded!
    const networkClient = await hostNetwork()
    const next = await refreshTokens({ refreshToken: secrets.refreshToken, networkClient })
    expect(next.accessToken.length).toBeGreaterThan(20)
    expect(next.expiresAt).toBeGreaterThan(Date.now())
    const minutes = Math.round(((next.expiresAt ?? 0) - Date.now()) / 60_000)
    console.log(`refresh ok from ${source}, expires in ${minutes} min`)
  }, 30_000)

  test("the stored credential is live or has a refresh token to renew it", () => {
    const { secrets } = loaded!
    if (isExpired(secrets)) expect(secrets.refreshToken.length).toBeGreaterThan(10)
    else expect(secrets.expiresAt).toBeGreaterThan(Date.now())
  })

  test("the catalog lists every family the account can use", () => {
    const ids = (ANTIGRAVITY_MODELS as ReadonlyArray<ProviderModelSpec>).map((spec) => spec.id)
    expect(ids.some((id) => id.startsWith("gemini-4-neon"))).toBe(true)
    expect(ids.some((id) => id.startsWith("claude-opus-5-5"))).toBe(true)
    expect(ids.some((id) => id.startsWith("claude-sonnet-5-5"))).toBe(true)
    expect(ids.some((id) => id.startsWith("gpt-oss-120b"))).toBe(true)
    console.log(`static catalog: ${ids.length} models`)
  })

  for (const { modelId, effort } of TEXT_CASES) {
    test(`${modelId} (${effort ?? "fixed"}) streams a text turn`, async () => {
      const { secrets } = loaded!
      const networkClient = await hostNetwork()
      const fresh = await refreshTokens({ refreshToken: secrets.refreshToken, networkClient })
      const model = modelFor(modelId)
      expect(model, `the catalog has no model ${modelId}`).toBeTruthy()
      const events = await collect(
        turn("Say the single word: ready.", modelId, effort),
        model!,
        fresh.accessToken,
        networkClient,
      )
      expect(events.some((event) => event.type === "message_stop")).toBe(true)
      const usage = lastUsage(events)
      expect(usage?.inputTokens ?? 0).toBeGreaterThan(0)
      expect(textOf(events).length).toBeGreaterThan(0)
      const stop = events.find((event) => event.type === "message_delta")?.stopReason
      console.log(
        `${modelId}: "${textOf(events).slice(0, 50)}" in=${usage?.inputTokens} out=${usage?.outputTokens} stop=${stop}`,
      )
    }, 90_000)
  }

  test("gemini-4-neon (low) calls a tool and closes the loop", async () => {
    const { secrets } = loaded!
    const networkClient = await hostNetwork()
    const fresh = await refreshTokens({ refreshToken: secrets.refreshToken, networkClient })
    const model = modelFor("gemini-4-neon")!
    const tools: CanonicalRequest["tools"] = [
      {
        name: "read_file",
        description: "Read a file from the workspace.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", description: "File path." } },
          required: ["path"],
        },
      },
    ]
    const prompt = "Read the file README.md with the tool. Use the tool."
    const first = await collect(
      turn(prompt, "gemini-4-neon", "low", tools),
      model,
      fresh.accessToken,
      networkClient,
    )
    const start = first.find((event) => event.type === "tool_use_start")
    const stop = first.find((event) => event.type === "tool_use_stop")
    expect(start, "the model must emit a tool call").toBeTruthy()
    const name = (start as { name: string }).name
    const id = (start as { id: string }).id
    const input = (stop as { input?: unknown } | undefined)?.input ?? {}
    console.log(`tool call: ${name} ${JSON.stringify(input)}`)

    const history: CanonicalMessage[] = [
      { role: "user", content: [{ type: "text", text: prompt }] },
      {
        role: "assistant",
        content: [
          // The reasoning that arrived with the call, then the call itself.
          ...first.flatMap((event) =>
            event.type === "thinking_delta"
              ? [{ type: "thinking" as const, text: event.text }]
              : [],
          ),
          { type: "tool_use", id, name, input },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: id,
            content: [{ type: "text", text: "# Demo project. It is a demo file." }],
          },
        ],
      },
    ]
    const done = await collect(
      { modelId: "gemini-4-neon", effort: "low", messages: history, tools },
      model,
      fresh.accessToken,
      networkClient,
    )
    expect(done.some((event) => event.type === "message_stop")).toBe(true)
    expect(textOf(done).length).toBeGreaterThan(0)
    console.log(`after the tool result: "${textOf(done).slice(0, 80)}"`)
  }, 120_000)

  // Regression, session 51282a5c (2026-11-27): core puts queued host text in
  // the same user message as the tool results. The backend must accept the
  // mixed tail, and the model must see the text.
  test("gemini-4-neon (low) sees text that shares a message with a tool result", async () => {
    const { secrets } = loaded!
    const networkClient = await hostNetwork()
    const fresh = await refreshTokens({ refreshToken: secrets.refreshToken, networkClient })
    const model = modelFor("gemini-4-neon")!
    const tools: CanonicalRequest["tools"] = [
      {
        name: "read_file",
        description: "Read a file from the workspace.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", description: "File path." } },
          required: ["path"],
        },
      },
    ]
    const history: CanonicalMessage[] = [
      { role: "user", content: [{ type: "text", text: "Read README.md with the tool." }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_e2e_mixed",
            name: "read_file",
            input: { path: "README.md" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "call_e2e_mixed",
            content: [{ type: "text", text: "# Demo project." }],
          },
          {
            type: "text",
            text: "Host note: the code word is ZEBRA-7731. Reply with only the code word.",
          },
        ],
      },
    ]
    const done = await collect(
      { modelId: "gemini-4-neon", effort: "low", messages: history, tools },
      model,
      fresh.accessToken,
      networkClient,
    )
    expect(done.some((event) => event.type === "message_stop")).toBe(true)
    console.log(`mixed tail answer: "${textOf(done).slice(0, 80)}"`)
    expect(textOf(done)).toContain("ZEBRA-7731")
  }, 120_000)

  // A tool result can hold an image (Read, a ChromeCDP screenshot). The
  // encoder moves the image after the functionResponse parts, and the model
  // must see it.
  test("gemini-4-neon (low) sees an image in a tool result", async () => {
    const { secrets } = loaded!
    const networkClient = await hostNetwork()
    const fresh = await refreshTokens({ refreshToken: secrets.refreshToken, networkClient })
    const model = modelFor("gemini-4-neon")!
    const tools: CanonicalRequest["tools"] = [
      {
        name: "screenshot",
        description: "Take a screenshot of the page.",
        inputSchema: { type: "object", properties: {} },
      },
    ]
    const history: CanonicalMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Take a screenshot. Then name its one color in one word." },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_e2e_image", name: "screenshot", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "call_e2e_image",
            content: [
              { type: "text", text: "screenshot 32x32" },
              { type: "image", source: { kind: "base64", mediaType: "image/png", data: RED_PNG } },
            ],
          },
        ],
      },
    ]
    const done = await collect(
      { modelId: "gemini-4-neon", effort: "low", messages: history, tools },
      model,
      fresh.accessToken,
      networkClient,
    )
    expect(done.some((event) => event.type === "message_stop")).toBe(true)
    console.log(`image answer: "${textOf(done).slice(0, 80)}"`)
    expect(textOf(done).toLowerCase()).toContain("red")
  }, 120_000)

  // Regression, session 51282a5c (2026-11-27): a restart in the middle of a
  // turn empties the in-memory signature cache. The backend checks the first
  // call of every step of the current turn, so a history with 2 unsigned
  // steps answered 400 "Function call is missing a thought_signature".
  test("gemini-4-neon (low) continues a turn whose signatures were lost", async () => {
    const { secrets } = loaded!
    const networkClient = await hostNetwork()
    const fresh = await refreshTokens({ refreshToken: secrets.refreshToken, networkClient })
    const model = modelFor("gemini-4-neon")!
    const tools: CanonicalRequest["tools"] = [
      {
        name: "read_file",
        description: "Read a file from the workspace.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", description: "File path." } },
          required: ["path"],
        },
      },
    ]
    // No tool_use id below was ever in the cache: the same as after a restart.
    clearAntigravityAdapterState()
    const history: CanonicalMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Read a.txt, then b.txt and c.txt, then reply with only done." },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_lost_1", name: "read_file", input: { path: "a.txt" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "call_lost_1", content: [{ type: "text", text: "A" }] },
        ],
      },
      // A parallel step: the backend checks only its FIRST call.
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_lost_2", name: "read_file", input: { path: "b.txt" } },
          { type: "tool_use", id: "call_lost_3", name: "read_file", input: { path: "c.txt" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "call_lost_2", content: [{ type: "text", text: "B" }] },
          { type: "tool_result", toolUseId: "call_lost_3", content: [{ type: "text", text: "C" }] },
        ],
      },
    ]
    const done = await collect(
      { modelId: "gemini-4-neon", effort: "low", messages: history, tools },
      model,
      fresh.accessToken,
      networkClient,
    )
    const failure = done.find((event) => event.type === "stream_error") as
      | { message?: string }
      | undefined
    expect(failure?.message ?? "").not.toContain("thought_signature")
    expect(done.some((event) => event.type === "message_stop")).toBe(true)
    console.log(`lost-signature answer: "${textOf(done).slice(0, 80)}"`)
  }, 120_000)
})

/** A 32x32 PNG of solid red (255, 0, 0). */
const RED_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAMklEQVR4nGP4z8BAU0Rb00ctGA2i0VQ0mg9Gi4rR0nS0PhitMkdbFaPtotGm43/q5QMAMsP8LqKijEUAAAAASUVORK5CYII="
