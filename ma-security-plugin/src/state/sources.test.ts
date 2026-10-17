import { rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import { gen } from "../rules/gen.ts"
import { makeFixtureDir, removeFixtureDir } from "../test-support.ts"

import { createKnownValueIndex } from "./known-value.ts"
import { memorySessionKey } from "./session-key.ts"
import {
  CREDENTIAL_FILE_MAX_BYTES,
  credentialItems,
  envItems,
  HarnessCredentialSource,
  loadEnv,
  readCredentialItems,
} from "./sources.ts"

const root = makeFixtureDir("b6-src-")
afterAll(() => removeFixtureDir(root))

// Synthetic values only (seeded generator).
const access = gen({ prefix: "sk-tst-oat01-", len: 60, charset: "alnum-_", seed: 501 })
const refresh = gen({ prefix: "sk-tst-ort01-", len: 60, charset: "alnum-_", seed: 502 })
const apiKey = gen({ prefix: "tk_", len: 40, charset: "alnum", seed: 503 })
const refresh2 = gen({ prefix: "sk-tst-ort01-", len: 60, charset: "alnum-_", seed: 504 })
const acctId = gen({ len: 32, charset: "hex", seed: 505 })
const email = "fixture.user@example.test"

function authDoc(refreshToken: string): string {
  return [
    "// synthetic credential fixture",
    "{",
    '  "anthropic-plan-oauth": {',
    `    "accessToken": "${access}", "refreshToken": "${refreshToken}",`,
    `    "expiresAt": 1999999999999, "scope": "user:inference", "tokenType": "Bearer",`,
    `    "account": { "emailAddress": "${email}", "accountUuid": "${acctId}",`,
    '      "firstName": "Ann", "displayName": "Fixture Person" },',
    '    "plan": "max-subscription-plan", "apiBaseUrl": "https://api.example.test/v1"',
    "  },",
    `  "providers": [ { "api_key": "${apiKey}" } ],`,
    "}",
  ].join("\n")
}

describe("credentialItems", () => {
  it("takes only secret and identity keys", () => {
    const doc = {
      a: { accessToken: access, plan: "pro-plan-xyz", scope: "scope-value-1", userId: acctId },
      b: [{ apiKey }],
      c: { idToken: 42, email },
    }
    const items = credentialItems(doc)
    expect(items.map((i) => i.value).sort()).toEqual([access, acctId, apiKey, email].sort())
    expect(items.find((i) => i.value === email)?.meta.kind).toBe("email")
    expect(items.find((i) => i.value === acctId)?.meta.ruleId).toBe("pii.harness-identity")
    expect(items.find((i) => i.value === access)?.meta.ruleId).toBe("secret.known-value.harness")
  })
})

describe("envItems", () => {
  it("matches names case-insensitively", () => {
    const env = {
      MY_API_KEY: "envval-11111",
      gh_token: "envval-22222",
      DB_PASSWD: "envval-33333",
      Some_Secret: "envval-44444",
      AWS_CREDENTIAL_X: "envval-55555",
      X_AUTH_Y: "envval-66666",
      USER_PASSWORD: "envval-77777",
      PATH: "/usr/bin:/bin:/opt/x",
      HOME: "/home/someone-x",
    }
    expect(
      envItems(env)
        .map((i) => i.value)
        .sort(),
    ).toEqual([1, 2, 3, 4, 5, 6, 7].map((n) => `envval-${String(n).repeat(5)}`))
  })

  it("loadEnv adds env values as source env", () => {
    const ix = createKnownValueIndex({ key: memorySessionKey() })
    expect(loadEnv(ix, { SVC_TOKEN: apiKey, SHORT_KEY: "abc" })).toEqual({ added: 1 })
    expect(ix.lookupValue(apiKey)?.source).toBe("env")
  })
})

describe("HarnessCredentialSource", () => {
  it("loads, reloads on mtime change (add-only), keeps last good on failure", () => {
    const path = join(root, "auth.jsonc")
    writeFileSync(path, authDoc(refresh), { mode: 0o600 })
    const ix = createKnownValueIndex({ key: memorySessionKey() })
    const src = new HarnessCredentialSource(path)
    expect(src.refresh(ix)).toEqual({ added: 6 }) // Ann is under 8 chars
    expect(ix.lookupValue("Ann")).toBeUndefined()
    expect(ix.lookupValue("max-subscription-plan")).toBeUndefined()
    expect(ix.lookupValue("https://api.example.test/v1")).toBeUndefined()
    expect(ix.lookupValue("user:inference")).toBeUndefined()
    expect(src.refresh(ix)).toBe("unchanged")

    // Rotation: new refresh token, old one stays.
    writeFileSync(path, authDoc(refresh2))
    utimesSync(path, new Date(), new Date(Date.now() + 5000))
    expect(src.refresh(ix)).toEqual({ added: 1 })
    expect(ix.lookupValue(refresh)).toBeDefined()
    expect(ix.lookupValue(refresh2)).toBeDefined()

    // Half-written file: error, index intact, no value in the message.
    writeFileSync(path, `{ "x": { "accessToken": "${access}`)
    utimesSync(path, new Date(), new Date(Date.now() + 10000))
    const r = src.refresh(ix)
    expect(r).toEqual({ error: "credential file parse failed" })
    expect(ix.lastLoadError).toBe("credential file parse failed")
    expect(ix.size).toBe(7)

    // Missing file.
    rmSync(path)
    expect(src.refresh(ix)).toEqual({ error: "credential file missing" })
    expect(ix.size).toBe(7)
    expect(ix.find(`a ${access} b ${email}`).length).toBe(2)
  })

  it("fix2: a failed load backs off until the stamp changes", () => {
    const path = join(root, "auth-backoff.jsonc")
    writeFileSync(path, `{ "x": { "accessToken": "${access}`, { mode: 0o600 })
    const ix = createKnownValueIndex({ key: memorySessionKey() })
    let reads = 0
    const src = new HarnessCredentialSource(path, (p) => {
      reads++
      return readCredentialItems(p)
    })
    expect(src.refresh(ix)).toEqual({ error: "credential file parse failed" })
    expect(src.refresh(ix)).toBe("unchanged")
    expect(src.refresh(ix)).toBe("unchanged")
    expect(reads).toBe(1)
    writeFileSync(path, authDoc(refresh))
    utimesSync(path, new Date(), new Date(Date.now() + 20000))
    expect(src.refresh(ix)).toEqual({ added: 6 })
    expect(reads).toBe(2)
  })

  it("fix2: a missing file at first refresh is tried once, then backs off", () => {
    const path = join(root, "auth-never.jsonc")
    const ix = createKnownValueIndex({ key: memorySessionKey() })
    let reads = 0
    const src = new HarnessCredentialSource(path, (p) => {
      reads++
      return readCredentialItems(p)
    })
    expect(src.refresh(ix)).toEqual({ error: "credential file missing" })
    expect(src.refresh(ix)).toBe("unchanged")
    expect(reads).toBe(1)
  })
})

describe("fix3: credential read is the safe single-fd read", () => {
  it("a symlinked credential file is refused, never followed", () => {
    const real = join(root, "auth-real.jsonc")
    writeFileSync(real, authDoc(refresh), { mode: 0o600 })
    const link = join(root, "auth-link.jsonc")
    symlinkSync(real, link)
    expect(() => readCredentialItems(link)).toThrow("credential file unreadable")
    expect(readCredentialItems(real).length).toBeGreaterThan(0)
  })

  it("a dir is unreadable, a missing file is missing, a relative path is refused", () => {
    expect(() => readCredentialItems(root)).toThrow("credential file unreadable")
    expect(() => readCredentialItems(join(root, "no-such.jsonc"))).toThrow(
      "credential file missing",
    )
    expect(() => readCredentialItems("auth.jsonc")).toThrow("credential file unreadable")
  })

  it("over the cap is too big", () => {
    const big = join(root, "auth-big.jsonc")
    writeFileSync(big, " ".repeat(CREDENTIAL_FILE_MAX_BYTES + 1))
    expect(() => readCredentialItems(big)).toThrow("credential file too big")
  })
})

describe("fix2: env is injected", () => {
  it("loadEnv needs an env argument and reads only it", () => {
    const ix = createKnownValueIndex({ key: memorySessionKey() })
    const env = { FIX_TOKEN: apiKey }
    expect(loadEnv(ix, env)).toEqual({ added: 1 })
    expect(loadEnv.length).toBe(2)
  })
})
