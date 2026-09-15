import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import type { AuthIo } from "./auth.ts"
import { currentFlags, fetchBackendFlags } from "./feature-flags.ts"
import { cloudConfig, runLogin } from "./login.ts"
import {
  clearAuth,
  cloudAuthPath,
  hasAuth,
  loadAuth,
  type StoredAuth,
  saveAuth,
} from "./token-store.ts"

function tmpHome(): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "cloud-auth-"))
  return {
    env: { MINIMAL_AGENT_HOME: dir },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const AUTH: StoredAuth = {
  v: 1,
  accessToken: "BEARER-XYZ",
  userId: "user-1",
  obtainedAt: 1_700_000_000_000,
  baseUrl: "http://localhost:4000/api/auth",
}

describe("token-store", () => {
  it("saves + loads round-trip", () => {
    const h = tmpHome()
    try {
      const saved = saveAuth(AUTH, h.env)
      expect(saved.ok).toBe(true)
      expect(loadAuth(h.env)).toEqual(AUTH)
      expect(hasAuth(h.env)).toBe(true)
    } finally {
      h.cleanup()
    }
  })

  it("writes the file with 0600 permissions (owner-only)", () => {
    const h = tmpHome()
    try {
      saveAuth(AUTH, h.env)
      const mode = statSync(cloudAuthPath(h.env)).mode & 0o777
      expect(mode).toBe(0o600)
    } finally {
      h.cleanup()
    }
  })

  it("loadAuth returns null when absent or corrupt", () => {
    const h = tmpHome()
    try {
      expect(loadAuth(h.env)).toBeNull()
      expect(hasAuth(h.env)).toBe(false)
    } finally {
      h.cleanup()
    }
  })

  it("clearAuth removes the token (logout)", () => {
    const h = tmpHome()
    try {
      saveAuth(AUTH, h.env)
      clearAuth(h.env)
      expect(hasAuth(h.env)).toBe(false)
    } finally {
      h.cleanup()
    }
  })
})

describe("feature-flags token gating", () => {
  it("currentFlags: cloudEnabled false when not logged in, true when logged in", () => {
    const h = tmpHome()
    try {
      expect(currentFlags(h.env).cloudEnabled).toBe(false)
      saveAuth(AUTH, h.env)
      expect(currentFlags(h.env).cloudEnabled).toBe(true)
      expect(currentFlags(h.env).teleportEnabled).toBe(true)
    } finally {
      h.cleanup()
    }
  })

  it("fetchBackendFlags: no token ⇒ all off (logged out)", async () => {
    const h = tmpHome()
    try {
      const flags = await fetchBackendFlags("http://x/graphql", h.env, {
        fetch: (async () => new Response("{}")) as unknown as typeof fetch,
      })
      expect(flags.cloudEnabled).toBe(false)
    } finally {
      h.cleanup()
    }
  })

  it("fetchBackendFlags: maps me.flags from a real GraphQL response", async () => {
    const h = tmpHome()
    try {
      saveAuth(AUTH, h.env)
      const io = {
        fetch: (async (_url: string, init?: RequestInit) => {
          // assert the bearer + query rode along
          const headers = init?.headers as Record<string, string>
          expect(headers.authorization).toBe("Bearer BEARER-XYZ")
          return new Response(
            JSON.stringify({
              data: {
                me: {
                  flags: {
                    cloudEnabled: true,
                    teleportEnabled: true,
                    remotePeersEnabled: false,
                    all: { premiumExport: true },
                  },
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        }) as unknown as typeof fetch,
      }
      const flags = await fetchBackendFlags("http://localhost:4000/graphql", h.env, io)
      expect(flags.cloudEnabled).toBe(true)
      expect(flags.remotePeersEnabled).toBe(false)
      expect(flags.premiumExport).toBe(true) // from the open-ended `all` bag
    } finally {
      h.cleanup()
    }
  })

  it("fetchBackendFlags: token present but backend unreachable ⇒ logged-in defaults (degrade)", async () => {
    const h = tmpHome()
    try {
      saveAuth(AUTH, h.env)
      const io = {
        fetch: (async () => {
          throw new Error("ECONNREFUSED")
        }) as unknown as typeof fetch,
      }
      const flags = await fetchBackendFlags("http://localhost:4000/graphql", h.env, io)
      expect(flags.cloudEnabled).toBe(true)
    } finally {
      h.cleanup()
    }
  })
})

describe("login orchestration (runLogin) — full flow with mocked endpoints", () => {
  it("device.code → poll → persist, ending logged in with cloud enabled", async () => {
    const h = tmpHome()
    try {
      let call = 0
      const io: AuthIo = {
        fetch: (async (url: string) => {
          call += 1
          if (url.endsWith("/device/code")) {
            return new Response(
              JSON.stringify({
                device_code: "dev-1",
                user_code: "ABCD-1234",
                verification_uri: "http://localhost:4000/device",
                expires_in: 100,
                interval: 1,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            )
          }
          // /device/token: pending once, then success with a bearer header
          if (call === 2) {
            return new Response(JSON.stringify({ error: "authorization_pending" }), {
              status: 400,
              headers: { "content-type": "application/json" },
            })
          }
          return new Response(JSON.stringify({ user: { id: "user-1" } }), {
            status: 200,
            headers: { "content-type": "application/json", "set-auth-token": "BEARER-FROM-FLOW" },
          })
        }) as unknown as typeof fetch,
        sleep: async () => {},
        now: (() => {
          let t = 0
          return () => (t += 500)
        })(),
      }
      const res = await runLogin(cloudConfig(h.env), h.env, io)
      expect(res.ok).toBe(true)
      if (res.ok) expect(res.value.accessToken).toBe("BEARER-FROM-FLOW")
      // token persisted ⇒ logged in ⇒ cloud enabled
      expect(hasAuth(h.env)).toBe(true)
      expect(loadAuth(h.env)?.userId).toBe("user-1")
      expect(currentFlags(h.env).cloudEnabled).toBe(true)
    } finally {
      h.cleanup()
    }
  })

  it("cloudConfig reads env overrides", () => {
    const cfg = cloudConfig({
      MINIMAL_AGENT_CLOUD_URL: "https://api.example.com/api/auth",
      MINIMAL_AGENT_CLOUD_CLIENT_ID: "my-cli",
      MINIMAL_AGENT_CLOUD_SCOPE: "teleport",
    })
    expect(cfg.baseUrl).toBe("https://api.example.com/api/auth")
    expect(cfg.clientId).toBe("my-cli")
    expect(cfg.scope).toBe("teleport")
  })
})
