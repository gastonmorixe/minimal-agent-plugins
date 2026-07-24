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

describe("cursor provider plugin shape", () => {
  test("plugin id and hooks", () => {
    expect(cursorProviderPlugin.id).toBe("cursor")
    expect(cursorProviderPlugin.shortCode).toBe("cur")
    expect(cursorProviderPlugin.apiKeyAuth).toBe(cursorApiKeyAuth)
    expect(cursorProviderPlugin.oauthLogin).toBe(cursorOAuthLogin)
    expect(typeof cursorProviderPlugin.listLiveModels).toBe("function")
    expect(cursorProviderPlugin.publicModelList).toBeUndefined()
    expect(typeof cursorProviderPlugin.register).toBe("function")
  })

  test("adapter surface is cursor-agent-run", () => {
    expect(cursorAdapter.id).toBe("cursor")
    expect(cursorAdapter.surfaces).toEqual([CURSOR_SURFACE_AGENT_RUN])
  })

  test("stream headers advertise spike client version + connect-accept-encoding", async () => {
    const { buildClientIds } = await import("./ids.ts")
    const { CURSOR_CLIENT_VERSION_DEFAULT } = await import("./wire-constants.ts")
    const ids = await buildClientIds({ machineId: "a".repeat(64), sessionId: "s" })
    const headers = buildCursorHeaders({
      token: "t",
      ids,
      streaming: true,
      clientType: "cli",
    })
    expect(headers["x-cursor-client-version"]).toBe(CURSOR_CLIENT_VERSION_DEFAULT)
    expect(headers["x-cursor-client-version"]).toBe("3.12.30")
    expect(headers["connect-accept-encoding"]).toBe("gzip")
    expect(headers["user-agent"]).toBe("connect-es/1.6.1")
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

  test("buildCursorHeaders sets checksum and content-type", async () => {
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

  test("static catalog / ad-hoc seed use empty effort levels until live enrich", async () => {
    const { registerCursorModels, registerCursorAdHocModelInto } = await import("./models.ts")
    const entries = new Map<
      string,
      { capabilities: { effort: { levels: string[] }; thinking: { visible: boolean } } }
    >()
    const models = {
      register(spec: {
        id: string
        capabilities: { effort: { levels: string[] }; thinking: { visible: boolean } }
      }) {
        entries.set(spec.id, spec)
      },
      setDefault() {},
    }
    registerCursorModels(models as never)
    const seed = entries.get("cursor-composer-2.5-fast")
    expect(seed?.capabilities.thinking.visible).toBe(true)
    expect(seed?.capabilities.effort.levels).toEqual([])
    registerCursorAdHocModelInto(models as never, "cursor-adhoc-test")
    expect(entries.get("cursor-adhoc-test")?.capabilities.effort.levels).toEqual([])
  })
})
