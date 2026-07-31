/**
 * Live E2E for Cursor AgentService/Run (gated by E2E=1).
 *
 * Requires Cursor credentials in ~/.minimal-agent/auth.jsonc (cursor-oauth or
 * cursor-api-key). Bidi tool tests use the host NetworkClient (same path as the
 * product TUI) so keepRequestOpen + writeRequestBody are exercised end-to-end.
 */

import { access } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { describe, expect, test } from "bun:test"

import { cursorAdapter } from "./adapter.ts"
import { CURSOR_API_KEY_AUTH, readCursorApiKey } from "./auth.ts"
import { cursorCaps } from "./capabilities.ts"
import { resetCursorBidiSessionsForTests } from "./cursor-bidi-session.ts"
import { parseJsonc } from "./lib/jsonc.ts"
import type { NetworkClient } from "./lib/net-types.ts"
import type { ProviderAuth } from "./lib/provider-auth.ts"
import type { AuthSecretBag } from "./lib/provider-plugin.ts"
import { CURSOR_OAUTH, readCursorOAuthAuth } from "./oauth-login.ts"
import { CURSOR_SURFACE_AGENT_RUN } from "./wire-constants.ts"

const skip = !process.env.E2E

/**
 * Load the host NetworkClient from a sibling minimal-agent-core checkout.
 * Uses a non-literal dynamic import so standalone plugins CI typecheck does
 * not require that sibling tree (E2E stays local / monorepo-only).
 */
async function createE2ENetworkClient(): Promise<NetworkClient> {
  const pluginsRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
  const coreNetwork = join(pluginsRoot, "..", "minimal-agent-core", "src", "network", "index.ts")
  try {
    await access(coreNetwork)
  } catch {
    throw new Error(
      `cursor e2e requires sibling minimal-agent-core at ${coreNetwork} (not available in standalone CI)`,
    )
  }
  const specifier = pathToFileURL(coreNetwork).href
  const mod = (await import(specifier)) as {
    createDefaultNetworkClient: () => NetworkClient
  }
  return mod.createDefaultNetworkClient()
}

type AuthStoreFile = {
  version?: number
  entries?: Array<{ id: string; name?: string; secrets: AuthSecretBag }>
}

async function loadCursorAuthFromStore(): Promise<ProviderAuth> {
  const path =
    process.env.MINIMAL_AGENT_AUTH_FILE?.trim() || join(homedir(), ".minimal-agent", "auth.jsonc")
  const text = await Bun.file(path).text()
  const parsed = parseJsonc(text) as AuthStoreFile
  const entries = parsed.entries ?? []
  const oauthEntry = entries.find((e) => e.id === CURSOR_OAUTH.serviceId)
  if (oauthEntry) {
    const auth = readCursorOAuthAuth(oauthEntry.secrets)
    if (auth) return auth
  }
  const keyEntry = entries.find((e) => e.id === CURSOR_API_KEY_AUTH.serviceId)
  if (keyEntry) {
    const key = readCursorApiKey(keyEntry.secrets)
    if (key) return { kind: "api-key", key }
  }
  throw new Error(
    `No Cursor credentials in ${path} (expected id ${CURSOR_OAUTH.serviceId} or ${CURSOR_API_KEY_AUTH.serviceId})`,
  )
}

const ZERO_PRICING = {
  inputUSD: 0,
  outputUSD: 0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0,
  webSearchPerCallUSD: 0,
} as const

type TimedEvent = { type: string }

/** Consume an async generator with a hard wall-clock timeout and stderr progress logs. */
async function consumeWithTimeout<T extends TimedEvent>(
  label: string,
  gen: AsyncGenerator<T> | AsyncIterable<T>,
  opts: { timeoutMs: number },
): Promise<{ events: T[]; text: string }> {
  const events: T[] = []
  let text = ""
  const t0 = Date.now()
  const log = (msg: string) => console.error(`[cursor-e2e:${label} +${Date.now() - t0}ms] ${msg}`)
  const deadline = Date.now() + opts.timeoutMs
  const iter = Symbol.asyncIterator in gen ? (gen as AsyncIterable<T>)[Symbol.asyncIterator]() : gen

  log(`start (timeout ${opts.timeoutMs}ms)`)
  while (true) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error(
        `${label}: timed out after ${opts.timeoutMs}ms — events: ${events.map((e) => e.type).join(", ") || "(none)"}`,
      )
    }

    const next = await Promise.race([
      iter.next(),
      new Promise<IteratorResult<T>>((_, reject) => {
        setTimeout(() => {
          reject(
            new Error(
              `${label}: no event for ${remaining}ms — events so far: ${events.map((e) => e.type).join(", ") || "(none)"}`,
            ),
          )
        }, remaining)
      }),
    ])

    if (next.done) {
      log(`generator done (${events.length} events)`)
      break
    }

    const ev = next.value
    events.push(ev)
    log(`event ${ev.type}`)
    if (ev.type === "stream_error") {
      throw (ev as { cause?: Error }).cause ?? new Error(`${label}: stream_error`)
    }
    if (ev.type === "text_delta" && "text" in ev && typeof ev.text === "string") {
      text += ev.text
    }
  }

  return { events, text }
}

describe("cursor provider live (E2E=1)", () => {
  test.skipIf(skip)(
    "cursor-auto text round-trip",
    async () => {
      delete process.env.MA_CURSOR_STREAM_TRANSPORT
      const auth = await loadCursorAuthFromStore()
      const networkClient = await createE2ENetworkClient()
      const events: Array<{ type: string }> = []
      try {
        const gen = cursorAdapter.run(
          {
            modelId: "cursor-auto",
            messages: [
              { role: "user", content: [{ type: "text", text: "Reply with exactly: PONG" }] },
            ],
            generation: { maxOutputTokens: 64 },
          },
          {
            id: "cursor-auto",
            providerId: "cursor",
            surfaceId: CURSOR_SURFACE_AGENT_RUN,
            displayName: "Auto (Cursor)",
            capabilities: cursorCaps(),
            pricing: ZERO_PRICING,
            vendorIds: { cursor: "default" },
          },
          { auth, sessionId: "e2e-cursor-session", networkClient },
        )
        let text = ""
        for await (const ev of gen) {
          events.push({ type: ev.type })
          if (ev.type === "text_delta") text += ev.text
          if (ev.type === "stream_error") throw ev.cause ?? new Error("stream_error")
        }
        expect(events.some((e) => e.type === "message_start")).toBe(true)
        expect(events.some((e) => e.type === "message_stop")).toBe(true)
        expect(text.toUpperCase()).toContain("PONG")
      } finally {
        await networkClient.close?.()
      }
    },
    60_000,
  )

  test.skipIf(skip)(
    "bidi MCP tool round-trip (ModelInfo)",
    async () => {
      delete process.env.MA_CURSOR_STREAM_TRANSPORT
      process.env.MA_CURSOR_BIDI_DEBUG = "1"
      const auth = await loadCursorAuthFromStore()
      const networkClient = await createE2ENetworkClient()
      const sessionId = `e2e-cursor-bidi-${crypto.randomUUID()}`
      const model = {
        id: "cursor-auto",
        providerId: "cursor",
        surfaceId: CURSOR_SURFACE_AGENT_RUN,
        displayName: "Auto (Cursor)",
        capabilities: cursorCaps(),
        pricing: ZERO_PRICING,
        vendorIds: { cursor: "default" },
      }
      const modelInfoTool = {
        name: "ModelInfo",
        description: "Return session model and provider metadata as JSON text.",
        inputSchema: { type: "object", properties: {} },
      }

      try {
        const gen1 = cursorAdapter.run(
          {
            modelId: "cursor-auto",
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "You must call the ModelInfo tool once, then answer with exactly: GOT-MODEL",
                  },
                ],
              },
            ],
            tools: [modelInfoTool],
            generation: { maxOutputTokens: 256 },
          },
          model,
          { auth, sessionId, networkClient },
        )

        const phase1 = await consumeWithTimeout("gen1-tool-request", gen1, { timeoutMs: 35_000 })
        const stopReason = phase1.events
          .filter((e) => e.type === "message_delta")
          .map((e) => (e as { stopReason?: string }).stopReason)
          .findLast(Boolean)
        const toolUseId =
          phase1.events
            .filter((e) => e.type === "tool_use_start")
            .map((e) => (e as { id?: string }).id)
            .find(Boolean) ?? ""
        const toolName =
          phase1.events
            .filter((e) => e.type === "tool_use_start")
            .map((e) => (e as { name?: string }).name)
            .find(Boolean) ?? ""

        expect(stopReason).toBe("tool_use")
        expect(toolName).toBe("ModelInfo")
        expect(toolUseId.length).toBeGreaterThan(0)

        const gen2 = cursorAdapter.run(
          {
            modelId: "cursor-auto",
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "You must call the ModelInfo tool once, then answer with exactly: GOT-MODEL",
                  },
                ],
              },
              {
                role: "assistant",
                content: [{ type: "tool_use", id: toolUseId, name: toolName, input: {} }],
              },
              {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    toolUseId,
                    content: [
                      {
                        type: "text",
                        text: JSON.stringify({ model: "cursor-auto", provider: "cursor" }),
                      },
                    ],
                  },
                ],
              },
            ],
            tools: [modelInfoTool],
            generation: { maxOutputTokens: 256 },
          },
          model,
          { auth, sessionId, networkClient },
        )

        const phase2 = await consumeWithTimeout("gen2-after-mcp-result", gen2, {
          timeoutMs: 25_000,
        })
        expect(phase2.text.toUpperCase()).toContain("GOT-MODEL")
      } finally {
        delete process.env.MA_CURSOR_BIDI_DEBUG
        resetCursorBidiSessionsForTests()
        await networkClient.close?.()
      }
    },
    70_000,
  )

  test.skipIf(skip)(
    "live AvailableModels registers namespaced ids",
    async () => {
      const { listCursorLiveModels } = await import("./live-models.ts")
      const auth = await loadCursorAuthFromStore()
      const rows = await listCursorLiveModels(auth)
      expect(Array.isArray(rows)).toBe(true)
      if (rows.length === 0) return
      for (const row of rows) {
        expect(row.id.startsWith("cursor-")).toBe(true)
      }
    },
    30_000,
  )
})
