import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { createPendingGateway } from "./pending-gateway.ts"
import { saveAuth } from "./token-store.ts"

function tmpHome(): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pending-gw-"))
  return {
    env: { MINIMAL_AGENT_HOME: dir },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const login = (env: NodeJS.ProcessEnv) =>
  saveAuth(
    { v: 1, accessToken: "BEARER-XYZ", obtainedAt: 1, baseUrl: "http://localhost:4000/api/auth" },
    env,
  )

const gqlResponse = (data: unknown) =>
  new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })

describe("createPendingGateway.listPending", () => {
  it("queries pendingPrompts with the Bearer and coerces the rows", async () => {
    const h = tmpHome()
    try {
      login(h.env)
      let sentAuth: string | undefined
      let sentBody: { query: string; variables: { sid: string } } | undefined
      const fetchSpy = (async (_url: string, init?: RequestInit) => {
        sentAuth = (init?.headers as Record<string, string>).authorization
        sentBody = JSON.parse(String(init?.body))
        return gqlResponse({
          pendingPrompts: [
            { pendingId: "p1", sid: "s1", content: "do X", status: "pending", createdAt: "t" },
            {
              pendingId: "p2",
              sid: "s1",
              content: { rich: true },
              status: "pending",
              createdAt: "t",
            },
          ],
        })
      }) as unknown as typeof fetch
      const gw = createPendingGateway({
        graphqlUrl: "http://localhost:4000/graphql",
        env: h.env,
        fetch: fetchSpy,
      })
      const res = await gw.listPending("s1")
      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(res.value.map((p) => p.pendingId)).toEqual(["p1", "p2"])
        expect(res.value[0]?.content).toBe("do X")
        expect(res.value[1]?.content).toEqual({ rich: true })
      }
      expect(sentAuth).toBe("Bearer BEARER-XYZ")
      expect(sentBody?.variables.sid).toBe("s1")
    } finally {
      h.cleanup()
    }
  })

  it("returns ok:false when not logged in", async () => {
    const h = tmpHome()
    try {
      const gw = createPendingGateway({
        graphqlUrl: "http://x/graphql",
        env: h.env,
        fetch: (async () => gqlResponse({ pendingPrompts: [] })) as unknown as typeof fetch,
      })
      const res = await gw.listPending("s1")
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reason).toContain("not logged in")
    } finally {
      h.cleanup()
    }
  })

  it("surfaces a GraphQL error as ok:false", async () => {
    const h = tmpHome()
    try {
      login(h.env)
      const gw = createPendingGateway({
        graphqlUrl: "http://x/graphql",
        env: h.env,
        fetch: (async () =>
          new Response(JSON.stringify({ errors: [{ message: "unauthorized" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch,
      })
      const res = await gw.listPending("s1")
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reason).toContain("unauthorized")
    } finally {
      h.cleanup()
    }
  })
})

describe("createPendingGateway.claim", () => {
  it("maps a winning claim (claimed:true + content)", async () => {
    const h = tmpHome()
    try {
      login(h.env)
      const gw = createPendingGateway({
        graphqlUrl: "http://x/graphql",
        env: h.env,
        fetch: (async () =>
          gqlResponse({
            claimPendingPrompt: { claimed: true, pendingId: "p1", content: "do X" },
          })) as unknown as typeof fetch,
      })
      const res = await gw.claim("p1")
      expect(res.ok).toBe(true)
      if (res.ok && res.value.claimed) {
        expect(res.value.pendingId).toBe("p1")
        expect(res.value.content).toBe("do X")
      } else {
        throw new Error("expected claimed:true")
      }
    } finally {
      h.cleanup()
    }
  })

  it("maps a lost claim (claimed:false + reason)", async () => {
    const h = tmpHome()
    try {
      login(h.env)
      const gw = createPendingGateway({
        graphqlUrl: "http://x/graphql",
        env: h.env,
        fetch: (async () =>
          gqlResponse({
            claimPendingPrompt: { claimed: false, pendingId: "p1", reason: "already-claimed" },
          })) as unknown as typeof fetch,
      })
      const res = await gw.claim("p1")
      expect(res.ok).toBe(true)
      if (res.ok && !res.value.claimed) {
        expect(res.value.reason).toBe("already-claimed")
      } else {
        throw new Error("expected claimed:false")
      }
    } finally {
      h.cleanup()
    }
  })
})
