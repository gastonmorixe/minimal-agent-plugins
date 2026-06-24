import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

import { __resetRelaysForTests, ensureRelay, injectorFor, stopRelay } from "./relay-session.ts"
import { saveAuth } from "./token-store.ts"

afterEach(() => __resetRelaysForTests())

function tmpHome(loggedIn: boolean): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "relay-sess-"))
  const env = { MINIMAL_AGENT_HOME: dir } as NodeJS.ProcessEnv
  if (loggedIn) {
    saveAuth(
      { v: 1, accessToken: "B", obtainedAt: 1, baseUrl: "http://localhost:4000/api/auth" },
      env,
    )
  }
  return { env, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe("relay-session gating", () => {
  it("ensureRelay is a no-op (null) when not logged in", () => {
    const h = tmpHome(false)
    try {
      expect(ensureRelay("s1", () => {}, h.env)).toBeNull()
      expect(injectorFor("s1")).toBeNull()
    } finally {
      h.cleanup()
    }
  })

  it("ensureRelay starts a relay when logged in + cloud enabled; injectorFor returns it", () => {
    const h = tmpHome(true)
    try {
      const state = ensureRelay("s1", () => {}, h.env)
      expect(state).not.toBeNull()
      expect(injectorFor("s1")).toBe(state?.injector ?? null)
    } finally {
      stopRelay("s1")
      h.cleanup()
    }
  })

  it("ensureRelay is idempotent — same state object on repeat calls", () => {
    const h = tmpHome(true)
    try {
      const a = ensureRelay("s1", () => {}, h.env)
      const b = ensureRelay("s1", () => {}, h.env)
      expect(a).toBe(b)
    } finally {
      stopRelay("s1")
      h.cleanup()
    }
  })

  it("the relay's injector stamps a matching user record (the upload-stamp wiring)", () => {
    const h = tmpHome(true)
    try {
      const emitted: unknown[] = []
      const state = ensureRelay("s1", (_c, p) => emitted.push(p), h.env)
      // simulate a claimed prompt by injecting through the relay's injector
      state?.injector.inject({ pendingId: "P1", content: "hi" })
      expect(emitted).toHaveLength(1) // prompt.inject emitted
      const inj = injectorFor("s1")
      const user = inj?.stampPendingId({ kind: "user", content: "hi" })
      expect(user?.pendingId).toBe("P1")
    } finally {
      stopRelay("s1")
      h.cleanup()
    }
  })

  it("stopRelay drops the session", () => {
    const h = tmpHome(true)
    try {
      ensureRelay("s1", () => {}, h.env)
      expect(injectorFor("s1")).not.toBeNull()
      stopRelay("s1")
      expect(injectorFor("s1")).toBeNull()
    } finally {
      h.cleanup()
    }
  })
})
