/**
 * Tests for cold-start quota priming (`primeAntigravitySessionInfo`) and
 * stored-credential selection from `auth.jsonc`.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { NetworkClient, NetworkResponse } from "@minimal-agent/core/plugin-api/net/types"

import { antigravityProviderPlugin } from "./adapter.ts"
import { antigravitySecretsToBag } from "./auth.ts"
import { clearAntigravityLiveModelsCache } from "./live-models.ts"
import {
  clearAntigravitySessionUsage,
  fetchAntigravitySessionInfo,
  primeAntigravitySessionInfo,
} from "./session-info.ts"
import { ANTIGRAVITY_CREDENTIAL_NAME, ANTIGRAVITY_SERVICE_ID } from "./wire-constants.ts"

const dirs: string[] = []
const prevHome = process.env.MINIMAL_AGENT_HOME
const prevAuthFile = process.env.MINIMAL_AGENT_AUTH_FILE

const QUOTA_BODY = {
  groups: [
    {
      displayName: "Gemini Models",
      buckets: [
        {
          bucketId: "gemini-5h",
          remainingFraction: 0.75,
          resetTime: "2030-01-02T03:04:05Z",
        },
      ],
    },
  ],
}

interface SeenRequest {
  url: string
  headers?: Record<string, string>
  body?: string
}

function makeAuthHome(entries: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "agy-session-info-"))
  dirs.push(dir)
  writeFileSync(
    join(dir, "auth.jsonc"),
    `// test store\n${JSON.stringify({ entries }, null, 2)}\n`,
    "utf8",
  )
  return dir
}

function oauthEntry(
  name: string,
  opts: { accessToken: string; refreshToken?: string; expiresAt?: number; project?: string },
) {
  return {
    id: ANTIGRAVITY_SERVICE_ID,
    name,
    secrets: antigravitySecretsToBag({
      tokenType: "oauth",
      accessToken: opts.accessToken,
      refreshToken: opts.refreshToken ?? "refresh-1",
      expiresAt: opts.expiresAt ?? Date.now() + 3_600_000,
      ...(opts.project ? { project: opts.project } : {}),
    }),
  }
}

function respond(status: number, body: unknown): NetworkResponse {
  const text = JSON.stringify(body)
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ "content-type": "application/json" }),
    body: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(text))
        c.close()
      },
    }),
    transport: { id: "fake" },
    text: async () => text,
    json: async <T>() => body as T,
  }
}

function fakeNetwork(
  seen: SeenRequest[],
  opts: {
    quotaStatus?: number
    refreshAccessToken?: string
    delayMs?: number
  } = {},
): NetworkClient {
  return {
    async request(input) {
      seen.push({
        url: input.url,
        headers: input.headers,
        body: typeof input.body === "string" ? input.body : undefined,
      })
      if (opts.delayMs) await Bun.sleep(opts.delayMs)
      if (input.url.includes("oauth2.googleapis.com/token")) {
        return respond(200, {
          access_token: opts.refreshAccessToken ?? "fresh-token",
          expires_in: 3600,
        })
      }
      if (input.url.includes(":loadCodeAssist")) {
        return respond(200, { cloudaicompanionProject: "aicode-consumers" })
      }
      if (input.url.includes(":retrieveUserQuotaSummary")) {
        return respond(opts.quotaStatus ?? 200, QUOTA_BODY)
      }
      return respond(404, {})
    },
  } as NetworkClient
}

beforeEach(() => {
  clearAntigravitySessionUsage()
  clearAntigravityLiveModelsCache()
  delete process.env.MINIMAL_AGENT_AUTH_FILE
})

afterEach(() => {
  clearAntigravitySessionUsage()
  clearAntigravityLiveModelsCache()
  if (prevHome === undefined) delete process.env.MINIMAL_AGENT_HOME
  else process.env.MINIMAL_AGENT_HOME = prevHome
  if (prevAuthFile === undefined) delete process.env.MINIMAL_AGENT_AUTH_FILE
  else process.env.MINIMAL_AGENT_AUTH_FILE = prevAuthFile
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe("primeAntigravitySessionInfo", () => {
  test("reads the stored OAuth credential through antigravityProviderPlugin.primeSessionInfo", async () => {
    process.env.MINIMAL_AGENT_HOME = makeAuthHome([
      oauthEntry(ANTIGRAVITY_CREDENTIAL_NAME, { accessToken: "tok-default" }),
    ])
    const seen: SeenRequest[] = []

    await antigravityProviderPlugin.primeSessionInfo?.({
      modelId: "gemini-4-neon",
      networkClient: fakeNetwork(seen),
    })

    const info = fetchAntigravitySessionInfo()
    expect(info?.quota?.windows).toEqual([
      {
        id: "gemini-5h",
        utilization: 0.25,
        resetAtMs: Date.UTC(2030, 0, 2, 3, 4, 5),
      },
    ])
    const quotaCall = seen.find((r) => r.url.includes(":retrieveUserQuotaSummary"))
    expect(quotaCall?.headers?.authorization).toBe("Bearer tok-default")
  })

  test("honors ctx.credentialName and never falls back to entries[0] on a miss", async () => {
    process.env.MINIMAL_AGENT_HOME = makeAuthHome([
      oauthEntry("First", { accessToken: "tok-first", project: "proj-1" }),
      oauthEntry("Work", { accessToken: "tok-work", project: "proj-2" }),
    ])

    const seenHit: SeenRequest[] = []
    await primeAntigravitySessionInfo({
      modelId: "gemini-4-neon",
      credentialName: "Work",
      networkClient: fakeNetwork(seenHit),
    })
    expect(
      seenHit.find((r) => r.url.includes(":retrieveUserQuotaSummary"))?.headers?.authorization,
    ).toBe("Bearer tok-work")

    clearAntigravitySessionUsage()
    const seenMiss: SeenRequest[] = []
    await primeAntigravitySessionInfo({
      modelId: "gemini-4-neon",
      credentialName: "Missing",
      networkClient: fakeNetwork(seenMiss),
    })
    expect(seenMiss).toEqual([])
    expect(fetchAntigravitySessionInfo()).toBeUndefined()
  })

  test("skips priming when ctx.authKind is api-key", async () => {
    process.env.MINIMAL_AGENT_HOME = makeAuthHome([
      oauthEntry(ANTIGRAVITY_CREDENTIAL_NAME, { accessToken: "tok-oauth" }),
    ])
    const seen: SeenRequest[] = []

    await primeAntigravitySessionInfo({
      modelId: "gemini-4-neon",
      authKind: "api-key",
      networkClient: fakeNetwork(seen),
    })

    expect(seen).toEqual([])
    expect(fetchAntigravitySessionInfo()).toBeUndefined()
  })

  test("refreshes an expired stored OAuth access token in memory before fetching quota", async () => {
    process.env.MINIMAL_AGENT_HOME = makeAuthHome([
      oauthEntry(ANTIGRAVITY_CREDENTIAL_NAME, {
        accessToken: "expired-tok",
        refreshToken: "refresh-expired",
        expiresAt: Date.now() - 10_000,
        project: "aicode-consumers",
      }),
    ])
    const seen: SeenRequest[] = []

    await primeAntigravitySessionInfo({
      modelId: "gemini-4-neon",
      networkClient: fakeNetwork(seen, { refreshAccessToken: "refreshed-tok" }),
    })

    expect(seen.some((r) => r.url.includes("oauth2.googleapis.com/token"))).toBe(true)
    const quotaCall = seen.find((r) => r.url.includes(":retrieveUserQuotaSummary"))
    expect(quotaCall?.headers?.authorization).toBe("Bearer refreshed-tok")
    expect(fetchAntigravitySessionInfo()?.quota?.windows).toHaveLength(1)
  })

  test("deduplicates concurrent calls and serves cached quota within TTL", async () => {
    process.env.MINIMAL_AGENT_HOME = makeAuthHome([
      oauthEntry(ANTIGRAVITY_CREDENTIAL_NAME, {
        accessToken: "tok-concurrent",
        project: "aicode-consumers",
      }),
    ])
    const seen: SeenRequest[] = []
    const client = fakeNetwork(seen, { delayMs: 25 })

    await Promise.all([
      primeAntigravitySessionInfo({ modelId: "gemini-4-neon", networkClient: client }),
      primeAntigravitySessionInfo({ modelId: "gemini-4-neon", networkClient: client }),
    ])
    await primeAntigravitySessionInfo({ modelId: "gemini-4-neon", networkClient: client })

    const quotaCalls = seen.filter((r) => r.url.includes(":retrieveUserQuotaSummary"))
    expect(quotaCalls).toHaveLength(1)
  })

  test("falls back to global fetch when ctx.networkClient is omitted", async () => {
    process.env.MINIMAL_AGENT_HOME = makeAuthHome([
      oauthEntry(ANTIGRAVITY_CREDENTIAL_NAME, {
        accessToken: "tok-fetch",
        project: "aicode-consumers",
      }),
    ])
    const originalFetch = globalThis.fetch
    const seenUrls: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      seenUrls.push(url)
      return new Response(JSON.stringify(QUOTA_BODY), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch

    try {
      await antigravityProviderPlugin.primeSessionInfo?.({ modelId: "gemini-4-neon" })
      expect(seenUrls.some((u) => u.includes(":retrieveUserQuotaSummary"))).toBe(true)
      expect(fetchAntigravitySessionInfo()?.quota?.windows).toHaveLength(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("never throws when auth store is missing or backend returns 500", async () => {
    process.env.MINIMAL_AGENT_HOME = join(tmpdir(), "agy-missing-dir-does-not-exist")
    await primeAntigravitySessionInfo({ modelId: "gemini-4-neon" })
    expect(fetchAntigravitySessionInfo()).toBeUndefined()

    process.env.MINIMAL_AGENT_HOME = makeAuthHome([
      oauthEntry(ANTIGRAVITY_CREDENTIAL_NAME, {
        accessToken: "tok-500",
        project: "aicode-consumers",
      }),
    ])
    const seen: SeenRequest[] = []
    await primeAntigravitySessionInfo({
      modelId: "gemini-4-neon",
      networkClient: fakeNetwork(seen, { quotaStatus: 500 }),
    })
    expect(fetchAntigravitySessionInfo()).toBeUndefined()
  })
})
