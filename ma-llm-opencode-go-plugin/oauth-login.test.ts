import { describe, expect, it } from "bun:test"

import { ProviderError } from "@minimal-agent/core/plugin-api/llm/errors"

import {
  completeOpencodeDeviceCode,
  OPENCODE_CONSOLE_OAUTH,
  OPENCODE_LOGIN_HINT,
  opencodeConsoleOAuthLogin,
  pickOpencodeOrg,
  readOpencodeOAuthAuth,
  refreshOpencodeOAuthCredential,
  requestOpencodeDeviceCode,
  SLOW_DOWN_STEP_MS,
} from "./oauth-login.ts"

type Call = {
  method: string
  url: string
  headers: Record<string, string>
  body?: unknown
  timeoutMs?: number
  capture?: { responseBody?: boolean }
}
type Reply = { status?: number; json?: unknown }

function mockClient(route: (call: Call) => Reply) {
  const calls: Call[] = []
  const client = {
    async request(input: {
      method: string
      url: string
      headers?: Record<string, string>
      body?: string
      timeoutMs?: number
      capture?: { responseBody?: boolean }
    }) {
      const call: Call = {
        method: input.method,
        url: input.url,
        headers: input.headers ?? {},
        body: input.body ? JSON.parse(input.body) : undefined,
        timeoutMs: input.timeoutMs,
        capture: input.capture,
      }
      calls.push(call)
      const reply = route(call)
      const status = reply.status ?? 200
      const text = reply.json === undefined ? "" : JSON.stringify(reply.json)
      return {
        status,
        ok: status >= 200 && status < 300,
        headers: new Headers(),
        body: new ReadableStream<Uint8Array>(),
        transport: { id: "mock" },
        async text() {
          return text
        },
        async json<T>() {
          return JSON.parse(text) as T
        },
      }
    },
  }
  return { client, calls }
}

const SERVER = "https://opencode.ai/console"

describe("OpenCode Console OAuth", () => {
  it("has the shared serviceId and a dummy config", () => {
    expect(opencodeConsoleOAuthLogin.serviceId).toBe("opencode-console-oauth")
    expect(opencodeConsoleOAuthLogin.displayName).toBe("OpenCode Console")
    expect(OPENCODE_CONSOLE_OAUTH.serviceId).toBe("opencode-console-oauth")
    expect(opencodeConsoleOAuthLogin.config().clientId).toBe("opencode-cli")
    expect(opencodeConsoleOAuthLogin.deviceCode).toBeDefined()
  })

  it("requests a device code with client_id and supports_org_scope", async () => {
    const { client, calls } = mockClient(() => ({
      json: {
        device_code: "dc",
        user_code: "ABCD-1234",
        verification_uri_complete: "device?code=ABCD",
        expires_in: 900,
        interval: 3,
      },
    }))
    const ch = await requestOpencodeDeviceCode({ networkClient: client })
    expect(calls[0]?.method).toBe("POST")
    expect(calls[0]?.url).toBe(`${SERVER}/auth/device/code`)
    expect(calls[0]?.body).toEqual({ client_id: "opencode-cli", supports_org_scope: true })
    expect(calls[0]?.headers["user-agent"]).toMatch(
      /^opencode\/latest\/\d+\.\d+\.\d+\/minimal-agent$/,
    )
    expect(ch.userCode).toBe("ABCD-1234")
    expect(ch.verificationUrl).toBe("https://opencode.ai/console/device?code=ABCD")
    expect(ch.pollIntervalMs).toBe(3000)
    expect(ch.expiresInMs).toBe(900_000)
    expect(ch.providerData).toEqual({ deviceCode: "dc", server: SERVER })
  })

  it("polls through pending and slow_down, then reads user and orgs", async () => {
    const polls: Reply[] = [
      { status: 400, json: { error: "authorization_pending" } },
      { status: 400, json: { error: "slow_down" } },
      { json: { access_token: "acc", refresh_token: "ref", expires_in: 3600, org_id: null } },
    ]
    const { client, calls } = mockClient((call) => {
      if (call.url.endsWith("/auth/device/token")) return polls.shift() ?? { status: 500 }
      if (call.url.endsWith("/api/user")) return { json: { id: "acct_1", email: "a@b.c" } }
      if (call.url.endsWith("/api/orgs"))
        return {
          json: [
            { id: "org_z", name: "Zeta" },
            { id: "org_a", name: "Alpha" },
          ],
        }
      return { status: 404 }
    })
    const waits: number[] = []
    const built = await completeOpencodeDeviceCode(
      {
        verificationUrl: "x",
        userCode: "U",
        pollIntervalMs: 1000,
        providerData: { deviceCode: "dc" },
      },
      { networkClient: client },
      { sleep: async (ms) => void waits.push(ms) },
    )
    expect(waits).toEqual([1000, 1000, 1000 + SLOW_DOWN_STEP_MS])
    const poll = calls.find((c) => c.url.endsWith("/auth/device/token"))
    expect(poll?.body).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: "dc",
      client_id: "opencode-cli",
    })
    const user = calls.find((c) => c.url.endsWith("/api/user"))
    expect(user?.headers.authorization).toBe("Bearer acc")
    const s = built.credential.secrets
    expect(built.credential.serviceId).toBe("opencode-console-oauth")
    expect(s.accessToken).toBe("acc")
    expect(s.refreshToken).toBe("ref")
    expect(s.accountID).toBe("acct_1")
    expect(s.email).toBe("a@b.c")
    expect(s.orgID).toBe("org_a")
    expect(s.orgName).toBe("Alpha")
    expect(s.server).toBe(SERVER)
    expect(Number(s.expiresAt)).toBeGreaterThan(Date.now())
    expect(built.result.account?.emailAddress).toBe("a@b.c")
  })

  it("fails on an unknown poll error", async () => {
    const { client } = mockClient(() => ({ status: 400, json: { error: "access_denied" } }))
    await expect(
      completeOpencodeDeviceCode(
        { verificationUrl: "x", userCode: "U", providerData: { deviceCode: "dc" } },
        { networkClient: client },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow(/access_denied/)
  })

  it("picks the org by token org_id, else first by name then id", () => {
    const orgs = [
      { id: "b", name: "Same" },
      { id: "a", name: "Same" },
      { id: "c", name: "Other" },
    ]
    expect(pickOpencodeOrg(orgs, null)?.id).toBe("c")
    expect(pickOpencodeOrg(orgs.slice(0, 2), null)?.id).toBe("a")
    expect(pickOpencodeOrg(orgs, "b")?.id).toBe("b")
    expect(pickOpencodeOrg(orgs, "zz")).toBeUndefined()
  })

  it("readAuth adds x-org-id only when an org exists", () => {
    expect(readOpencodeOAuthAuth({ accessToken: "t", orgID: "org_1" })).toEqual({
      kind: "oauth",
      token: "t",
      headers: { "x-org-id": "org_1" },
    })
    expect(readOpencodeOAuthAuth({ accessToken: "t" })).toEqual({ kind: "oauth", token: "t" })
    expect(readOpencodeOAuthAuth({})).toBeNull()
  })

  it("refresh rotates both tokens and keeps the profile", async () => {
    const { client, calls } = mockClient(() => ({
      json: { access_token: "acc2", refresh_token: "ref2", expires_in: 60 },
    }))
    const built = await refreshOpencodeOAuthCredential(
      {
        accessToken: "acc",
        refreshToken: "ref",
        server: SERVER,
        email: "a@b.c",
        accountID: "acct_1",
        orgID: "org_a",
        orgName: "Alpha",
      },
      { networkClient: client },
    )
    expect(calls[0]?.url).toBe(`${SERVER}/auth/device/token`)
    expect(calls[0]?.body).toEqual({
      grant_type: "refresh_token",
      refresh_token: "ref",
      client_id: "opencode-cli",
    })
    const s = built.credential.secrets
    expect(s.accessToken).toBe("acc2")
    expect(s.refreshToken).toBe("ref2")
    expect(s.orgID).toBe("org_a")
    expect(s.orgName).toBe("Alpha")
    expect(s.email).toBe("a@b.c")
  })

  it("refresh keeps the old refresh token when the server omits it, and has a timeout", async () => {
    const { client, calls } = mockClient(() => ({ json: { access_token: "acc2", expires_in: 60 } }))
    const built = await refreshOpencodeOAuthCredential(
      { accessToken: "acc", refreshToken: "ref", server: SERVER },
      { networkClient: client },
    )
    expect(built.credential.secrets.refreshToken).toBe("ref")
    expect(calls[0]?.timeoutMs).toBeGreaterThan(0)
  })

  it("defaults the token lifetime when expires_in is missing", async () => {
    const { client } = mockClient(() => ({ json: { access_token: "acc2", refresh_token: "r" } }))
    const built = await refreshOpencodeOAuthCredential(
      { accessToken: "acc", refreshToken: "ref" },
      { networkClient: client },
    )
    expect(Number(built.credential.secrets.expiresAt)).toBeGreaterThan(Date.now() + 30 * 60_000)
  })

  it("keeps polling through a non-JSON 5xx and does not capture the device-code body", async () => {
    const polls: Reply[] = [
      { status: 502 },
      { json: { access_token: "acc", refresh_token: "ref", expires_in: 3600 } },
    ]
    const { client } = mockClient((call) => {
      if (call.url.endsWith("/auth/device/token")) return polls.shift() ?? { status: 500 }
      if (call.url.endsWith("/api/user")) return { json: { id: "acct_1", email: "a@b.c" } }
      if (call.url.endsWith("/api/orgs")) return { json: [] }
      return { status: 404 }
    })
    const built = await completeOpencodeDeviceCode(
      {
        verificationUrl: "x",
        userCode: "U",
        pollIntervalMs: 1,
        providerData: { deviceCode: "dc" },
      },
      { networkClient: client },
      { sleep: async () => {} },
    )
    expect(built.credential.secrets.accessToken).toBe("acc")

    const dc = mockClient(() => ({
      json: { device_code: "dc", user_code: "U", verification_uri_complete: "x", expires_in: 9 },
    }))
    await requestOpencodeDeviceCode({ networkClient: dc.client })
    expect(dc.calls[0]?.capture?.responseBody).toBe(false)
  })

  it("refresh with a new org_id replaces org and clears the stale name", async () => {
    const { client } = mockClient(() => ({
      json: { access_token: "a", refresh_token: "r", expires_in: 60, org_id: "org_new" },
    }))
    const built = await refreshOpencodeOAuthCredential(
      { accessToken: "x", refreshToken: "y", orgID: "org_a", orgName: "Alpha" },
      { networkClient: client },
    )
    expect(built.credential.secrets.orgID).toBe("org_new")
    expect(built.credential.secrets.orgName).toBeUndefined()
  })

  it("refresh invalid_grant becomes an auth error with a login hint", async () => {
    const { client } = mockClient(() => ({ status: 400, json: { error: "invalid_grant" } }))
    const err = await refreshOpencodeOAuthCredential(
      { accessToken: "x", refreshToken: "y" },
      { networkClient: client },
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    const pe = err as ProviderError
    expect(pe.message).toContain("invalid_grant")
    expect(pe.hint).toBe(OPENCODE_LOGIN_HINT)
    expect(pe.hint).toBe("run: ma provider opencode-go login")
    expect(pe.code).toBe("opencode.signed_out")
    expect(pe.opts.status).toBe(401)
  })
})
