/**
 * Unit tests for ma-llm-cursor-plugin scaffold (Phase 2.0).
 * Pure helpers only — no network.
 */

import { describe, expect, test } from "bun:test"

import { cursorAdapter, cursorProviderPlugin } from "./adapter.ts"
import { buildCursorApiKeyCredential, cursorApiKeyAuth, readCursorApiKey } from "./auth.ts"
import { cursorCaps } from "./capabilities.ts"
import { buildCursorChecksum, scrambleTimestampBytes, timestampBytes } from "./checksum.ts"
import { bearerToken, buildCursorHeaders } from "./headers.ts"
import { buildClientIds, toHex } from "./ids.ts"
import { cursorWireModelId, registerCursorAdHocModelInto, resolveCursorWireId } from "./models.ts"
import { cursorOAuthLogin } from "./oauth-login.ts"
import {
  concat,
  decodeFields,
  encBool,
  encMsg,
  encString,
  encVarint,
  encVarintField,
  getFirstString,
  getFirstVarint,
} from "./proto/wire.ts"
import { CURSOR_SURFACE_AGENT_RUN } from "./wire-constants.ts"

describe("cursor wire model id aliases", () => {
  test("auto display slug resolves to default for AgentService/Run", () => {
    expect(resolveCursorWireId("auto")).toBe("default")
    expect(resolveCursorWireId("cursor-auto")).toBe("default")
    expect(resolveCursorWireId("default")).toBe("default")
    expect(resolveCursorWireId("composer-2.5-fast")).toBe("composer-2.5-fast")
    expect(resolveCursorWireId("cursor-composer-2.5-fast")).toBe("composer-2.5-fast")
  })

  test("Cursor Grok exploded SKUs stay as Run slugs; parents keep the API name", () => {
    expect(resolveCursorWireId("cursor-grok-4.5-high-fast")).toBe("cursor-grok-4.5-high-fast")
    expect(resolveCursorWireId("cursor-grok-4.6")).toBe("grok-4.6")
    expect(resolveCursorWireId("cursor-grok-4.6-high")).toBe("cursor-grok-4.6-high")
    expect(
      cursorWireModelId({
        id: "cursor-grok-4.5-high-fast",
        vendorIds: { cursor: "cursor-grok-4.5-high-fast" },
      }),
    ).toBe("cursor-grok-4.5-high-fast")
  })

  test("ad-hoc cursor-auto stores vendorIds.cursor=default", () => {
    const entries = new Map<string, { id: string; vendorIds?: Record<string, string> }>()
    const registrar = {
      register(spec: { id: string; vendorIds?: Record<string, string> }) {
        entries.set(spec.id, spec)
      },
      setDefault() {},
    }
    registerCursorAdHocModelInto(registrar as never, "cursor-auto")
    const entry = entries.get("cursor-auto")
    expect(entry?.vendorIds?.cursor).toBe("default")
    expect(cursorWireModelId(entry!)).toBe("default")
  })

  test("cursorWireModelId still maps bare auto vendor id", () => {
    expect(cursorWireModelId({ id: "cursor-auto", vendorIds: { cursor: "auto" } })).toBe("default")
  })
})

describe("cursor provider plugin shape", () => {
  test("plugin id and hooks", () => {
    expect(cursorProviderPlugin.id).toBe("cursor")
    expect(cursorProviderPlugin.shortCode).toBe("cur")
    expect(cursorProviderPlugin.apiKeyAuth).toBe(cursorApiKeyAuth)
    expect(cursorProviderPlugin.oauthLogin).toBe(cursorOAuthLogin)
    expect(typeof cursorProviderPlugin.listLiveModels).toBe("function")
    expect(cursorProviderPlugin.publicModelList).toBeUndefined()
    expect(typeof cursorProviderPlugin.register).toBe("function")
    expect(typeof cursorProviderPlugin.onStartupProbe).toBe("function")
  })

  test("adapter surface is cursor-agent-run", () => {
    expect(cursorAdapter.id).toBe("cursor")
    expect(cursorAdapter.surfaces).toEqual([CURSOR_SURFACE_AGENT_RUN])
  })

  test("stream headers advertise CLI client version + connect-accept-encoding", async () => {
    const { buildClientIds } = await import("./ids.ts")
    const ids = await buildClientIds({ machineId: "a".repeat(64), sessionId: "s" })
    const prev = process.env.MA_CURSOR_CLIENT_VERSION
    process.env.MA_CURSOR_CLIENT_VERSION = "cli-test-override"
    try {
      const headers = buildCursorHeaders({
        token: "t",
        ids,
        streaming: true,
        clientType: "cli",
      })
      expect(headers["x-cursor-client-version"]).toBe("cli-test-override")
      expect(headers["connect-accept-encoding"]).toBe("gzip")
      expect(headers["user-agent"]).toBe("connect-es/1.6.1")
      expect(headers["x-cursor-checksum"]).toBeUndefined()
      expect(headers["x-client-key"]).toBeUndefined()
    } finally {
      if (prev === undefined) delete process.env.MA_CURSOR_CLIENT_VERSION
      else process.env.MA_CURSOR_CLIENT_VERSION = prev
    }
  })

  test("listLiveModels is wired (may reject without network/auth)", async () => {
    expect(typeof cursorProviderPlugin.listLiveModels).toBe("function")
    // Offline unit test: either returns rows or rejects — must not hang.
    try {
      const rows = await cursorProviderPlugin.listLiveModels!({ kind: "api-key", key: "x" })
      expect(Array.isArray(rows)).toBe(true)
    } catch (e) {
      expect(String(e)).toMatch(/listLiveModels|not implemented|exchange|network|fetch|Cursor/i)
    }
  })

  test("run is async and requires resolved auth (api-key exchange fails offline)", async () => {
    const gen = cursorAdapter.run(
      {
        modelId: "composer-2.5-fast",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      },
      {
        id: "composer-2.5-fast",
        providerId: "cursor",
        surfaceId: CURSOR_SURFACE_AGENT_RUN,
        displayName: "x",
        capabilities: cursorCaps({ thinking: true }),
        pricing: {
          inputUSD: 0,
          outputUSD: 0,
          cacheWriteUSD: 0,
          cacheReadUSD: 0,
          webSearchPerCallUSD: 0,
        },
      },
      { auth: { kind: "api-key", key: "not-a-real-key" }, sessionId: "test-session" },
    )
    const iter = gen[Symbol.asyncIterator]()
    await expect(iter.next()).rejects.toThrow()
  })
})

describe("checksum", () => {
  test("timestampBytes is 6 bytes with JS shift semantics (report 09)", () => {
    const ms = 1_700_000_000_000
    const b = timestampBytes(ms)
    expect(b.length).toBe(6)
    // Same clock → identical bytes (JS >> is 32-bit; intentional IDE parity).
    expect(timestampBytes(ms)).toEqual(b)
    expect(timestampBytes(ms + 1e6)).not.toEqual(b)
  })

  test("scramble is deterministic and length-preserving", () => {
    const input = new Uint8Array([1, 2, 3, 4, 5, 6])
    const a = scrambleTimestampBytes(input)
    const b = scrambleTimestampBytes(input)
    expect(a).toEqual(b)
    expect(a.length).toBe(6)
    expect(a).not.toEqual(input)
  })

  test("buildCursorChecksum length with 64-char ids (report 09)", () => {
    const machineId = "a".repeat(64)
    const macMachineId = "b".repeat(64)
    const got = buildCursorChecksum(machineId, macMachineId, 1_700_000_000_000)
    // base64(6 bytes) is 8 chars + 64 + "/" + 64 = 137
    expect(got.length).toBe(137)
    expect(got.endsWith(`${machineId}/${macMachineId}`)).toBe(true)
  })

  test("buildCursorChecksum without macMachineId", () => {
    const machineId = "c".repeat(64)
    const got = buildCursorChecksum(machineId, undefined, 1_700_000_000_000)
    expect(got.endsWith(machineId)).toBe(true)
    expect(got.includes("/")).toBe(false)
  })
})

describe("proto wire", () => {
  test("string field round-trip", () => {
    const buf = encString(1, "hello")
    expect(getFirstString(buf, 1)).toBe("hello")
  })

  test("varint field round-trip", () => {
    const buf = encVarintField(2, 42)
    expect(getFirstVarint(buf, 2)).toBe(42)
  })

  test("bool true encodes; false omitted", () => {
    expect(encBool(3, false).length).toBe(0)
    expect(getFirstVarint(encBool(3, true), 3)).toBe(1)
  })

  test("nested message", () => {
    const inner = encString(1, "inner")
    const outer = encMsg(5, inner)
    const fields = decodeFields(outer)
    expect(fields.length).toBe(1)
    expect(fields[0]!.no).toBe(5)
    const body = fields[0]!.value
    expect(body instanceof Uint8Array).toBe(true)
    expect(getFirstString(body as Uint8Array, 1)).toBe("inner")
  })

  test("concat + multi-field decode", () => {
    const buf = concat(encString(1, "a"), encVarintField(2, 7))
    expect(getFirstString(buf, 1)).toBe("a")
    expect(getFirstVarint(buf, 2)).toBe(7)
  })

  test("encVarint small values", () => {
    expect([...encVarint(0)]).toEqual([0])
    expect([...encVarint(127)]).toEqual([127])
    expect([...encVarint(128)]).toEqual([128, 1])
  })
})

describe("ids + headers", () => {
  test("toHex", () => {
    expect(toHex(new Uint8Array([0, 255, 16]))).toBe("00ff10")
  })

  test("buildClientIds defaults clientKey to sha256", async () => {
    const ids = await buildClientIds({ machineId: "m".repeat(64), sessionId: "sess" })
    expect(ids.machineId.length).toBe(64)
    expect(ids.clientKey.length).toBe(64)
    expect(ids.sessionId).toBe("sess")
  })

  test("bearerToken from oauth only (api-key needs exchange)", () => {
    expect(bearerToken({ kind: "oauth", token: "oai" })).toBe("oai")
    expect(bearerToken({ kind: "api-key", key: "raw-key" })).toBeNull()
  })

  test("buildCursorHeaders matches CLI (no IDE checksum) by default", async () => {
    const ids = await buildClientIds({
      machineId: "a".repeat(64),
      macMachineId: "b".repeat(64),
      clientKey: "k".repeat(64),
      sessionId: "s",
    })
    const headers = buildCursorHeaders({
      token: "secret",
      ids,
      streaming: true,
      nowMs: 1_700_000_000_000,
    })
    expect(headers.authorization).toBe("Bearer secret")
    expect(headers["content-type"]).toBe("application/connect+proto")
    expect(headers["connect-protocol-version"]).toBe("1")
    expect(headers["x-cursor-client-type"]).toBe("cli")
    expect(headers["x-ghost-mode"]).toBe("true")
    expect(headers["x-cursor-checksum"]).toBeUndefined()
    expect(headers["x-client-key"]).toBeUndefined()
    expect(headers["x-session-id"]).toBeUndefined()
  })

  test("buildCursorHeaders fingerprint=ide restores checksum headers", async () => {
    const ids = await buildClientIds({
      machineId: "a".repeat(64),
      macMachineId: "b".repeat(64),
      clientKey: "k".repeat(64),
      sessionId: "s",
    })
    const headers = buildCursorHeaders({
      token: "secret",
      ids,
      streaming: true,
      nowMs: 1_700_000_000_000,
      fingerprint: "ide",
    })
    expect(headers["x-cursor-checksum"]?.length).toBe(137)
    expect(headers["x-client-key"]).toBe("k".repeat(64))
  })
})

describe("auth helpers", () => {
  test("api key credential round-trip", () => {
    const cred = buildCursorApiKeyCredential("sk-test")
    expect(cred.serviceId).toBe("cursor-api-key")
    expect(readCursorApiKey(cred.secrets)).toBe("sk-test")
  })
})

describe("capabilities seed", () => {
  test("cursorCaps(thinking) defaults still advertise effort levels (helper API)", () => {
    const caps = cursorCaps({ thinking: true, contextWindow: 200_000 })
    expect(caps.contextWindow).toBe(200_000)
    expect(caps.thinking.visible).toBe(true)
    expect(caps.effort.levels.length).toBeGreaterThan(0)
  })

  test("static catalog registers all live host ids and preserves closed efforts", async () => {
    const { registerCursorModels, registerCursorAdHocModelInto } = await import("./models.ts")
    const entries = new Map<
      string,
      {
        capabilities: {
          effort: { levels: string[] }
          thinking: { visible: boolean }
          modalities?: { image: boolean }
        }
        vendorIds?: { cursor?: string }
      }
    >()
    const models = {
      register(spec: {
        id: string
        capabilities: {
          effort: { levels: string[] }
          thinking: { visible: boolean }
          modalities?: { image: boolean }
        }
      }) {
        entries.set(spec.id, spec)
      },
      setDefault() {},
    }
    registerCursorModels(models as never)
    const namespaced = [...entries.keys()].filter((id) => id.startsWith("cursor-"))
    expect(namespaced.length).toBe(299)
    expect(entries.has("grok-4.6")).toBe(true)
    expect(entries.get("grok-4.6")?.vendorIds?.cursor).toBe("grok-4.6")
    const fast = entries.get("cursor-grok-4.6-high-fast")
    expect(fast?.capabilities.thinking.visible).toBe(true)
    expect(fast?.capabilities.modalities?.image).toBe(true)
    expect(fast?.capabilities.effort.levels).toEqual(["high"])
    expect(fast?.vendorIds?.cursor).toBe("cursor-grok-4.6-high-fast")
    const nonFast = entries.get("cursor-grok-4.6-high")
    expect(nonFast?.capabilities.thinking.visible).toBe(true)
    expect(nonFast?.capabilities.effort.levels).toEqual(["high"])
    expect(nonFast?.vendorIds?.cursor).toBe("cursor-grok-4.6-high")
    const alias = entries.get("cursor-grok-4.6")
    expect(alias?.capabilities.thinking.visible).toBe(true)
    expect((alias as { vendorIds?: { cursor?: string } } | undefined)?.vendorIds?.cursor).toBe(
      "grok-4.6",
    )
    expect(alias?.capabilities.effort.levels).toEqual(["low", "medium", "high", "xhigh"])
    const vision = entries.get("cursor-gpt-5.6-sol-medium")
    expect(vision?.capabilities.modalities?.image).toBe(true)
    const auto = entries.get("cursor-auto")
    expect(auto?.vendorIds?.cursor).toBe("default")
    expect(auto?.capabilities.thinking.visible).toBe(false)
    registerCursorAdHocModelInto(models as never, "cursor-adhoc-test")
    expect(entries.get("cursor-adhoc-test")?.capabilities.effort.levels).toEqual([])
  })
})
