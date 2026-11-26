/**
 * Live model list: the host hook must call the control plane for real.
 *
 * The host hook `listLiveModels(auth)` gives no network client. A past defect
 * made the list throw on the missing client and return `[]`, with no request.
 * These tests drive the list with a recording client and check the URL set and
 * the rows.
 *
 * @module antigravity.live-models.test
 */

import { afterEach, describe, expect, it } from "bun:test"

import type { NetworkClient, NetworkRequestInput } from "@minimal-agent/core/plugin-api/net/types"

import { clearAntigravityLiveModelsCache, listAntigravityLiveModels } from "./live-models.ts"

const FIXTURE = new URL("./__fixtures__/fetch-available-models.json", import.meta.url)

interface Seen {
  url: string
  userAgent: string
}

function jsonBody(value: unknown, status = 200) {
  const text = JSON.stringify(value)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    body: new ReadableStream<Uint8Array>(),
    transport: { id: "test" },
    text: async () => text,
    json: async <T>() => value as T,
  }
}

function recordingClient(seen: Seen[], catalog: unknown, catalogStatus = 200): NetworkClient {
  return {
    async request(input: NetworkRequestInput) {
      const headers = (input.headers ?? {}) as Record<string, string>
      seen.push({ url: input.url, userAgent: headers["user-agent"] ?? "" })
      if (input.url.includes("loadCodeAssist")) {
        return jsonBody({ cloudaicompanionProject: "aicode-consumers" })
      }
      if (input.url.includes("fetchAvailableModels")) return jsonBody(catalog, catalogStatus)
      return jsonBody({}, 404)
    },
  } as unknown as NetworkClient
}

afterEach(() => {
  clearAntigravityLiveModelsCache()
})

describe("listAntigravityLiveModels", () => {
  it("calls loadCodeAssist and fetchAvailableModels only, and returns grouped rows", async () => {
    const catalog = await Bun.file(FIXTURE).json()
    const seen: Seen[] = []
    const rows = await listAntigravityLiveModels(
      { kind: "oauth", token: "test-token" },
      { networkClient: recordingClient(seen, catalog) },
    )

    expect(seen.map((s) => new URL(s.url).pathname)).toEqual([
      "/v1internal:loadCodeAssist",
      "/v1internal:fetchAvailableModels",
    ])
    for (const s of seen) {
      expect(new URL(s.url).host).toBe("daily-cloudcode-pa.googleapis.com")
      expect(s.userAgent).toMatch(/^antigravity/)
    }
    const ids = rows.map((r) => r.id)
    expect(ids).toContain("gemini-4-neon")
    // A family row replaces its effort variants.
    expect(ids).not.toContain("gemini-4-neon-high")
  })

  it("returns [] and reports the error to the debug sink on a 500", async () => {
    const seen: Seen[] = []
    const notes: string[] = []
    const rows = await listAntigravityLiveModels(
      { kind: "oauth", token: "test-token" },
      { networkClient: recordingClient(seen, { error: "boom" }, 500), debug: (m) => notes.push(m) },
    )
    expect(rows).toEqual([])
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain("fetchAvailableModels 500")
  })

  it("throws on a 403, so the host can refresh the token", async () => {
    const seen: Seen[] = []
    await expect(
      listAntigravityLiveModels(
        { kind: "oauth", token: "test-token" },
        { networkClient: recordingClient(seen, {}, 403) },
      ),
    ).rejects.toThrow(/403/)
  })
})
