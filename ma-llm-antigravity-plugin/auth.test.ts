/**
 * Tests for the credential shape, the expiry math, and the `agy` token import.
 *
 * Every fixture is synthetic: no real token, no real account, and no file
 * outside a temp directory that the test creates and removes.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import {
  type AntigravitySecrets,
  agyTokenFilePaths,
  antigravityExpiresAt,
  antigravitySecretsToBag,
  isExpired,
  REFRESH_SKEW_MS,
  readAgyTokenFile,
  readAntigravitySecrets,
} from "./auth.ts"

const dirs: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "agy-auth-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const base: AntigravitySecrets = {
  tokenType: "oauth",
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAt: 1_800_000_000_000,
}

describe("antigravitySecretsToBag / readAntigravitySecrets", () => {
  test("round trips the required fields", () => {
    const back = readAntigravitySecrets(antigravitySecretsToBag(base))
    expect(back).not.toBeNull()
    expect(back?.accessToken).toBe("access-token")
    expect(back?.refreshToken).toBe("refresh-token")
    expect(back?.expiresAt).toBe(1_800_000_000_000)
    expect(back?.tokenType).toBe("oauth")
  })

  test("an optional field is absent from the bag, not null", () => {
    const bag = antigravitySecretsToBag(base)
    expect("email" in bag).toBe(false)
    expect("project" in bag).toBe(false)
  })

  test("keeps the optional fields when present", () => {
    const bag = antigravitySecretsToBag({
      ...base,
      email: "user@example.test",
      project: "aicode-consumers",
      authMethod: "consumer",
      scope: "openid",
      importedFrom: "/x/y",
    })
    expect(bag.email).toBe("user@example.test")
    expect(bag.project).toBe("aicode-consumers")
    expect(bag.authMethod).toBe("consumer")
  })

  test("returns null when a required field is missing", () => {
    expect(readAntigravitySecrets({})).toBeNull()
    expect(readAntigravitySecrets({ accessToken: "a" })).toBeNull()
    expect(readAntigravitySecrets({ accessToken: "", refreshToken: "r" })).toBeNull()
  })
})

describe("antigravityExpiresAt", () => {
  const now = 1_000_000

  test("uses expires_in seconds", () => {
    expect(antigravityExpiresAt({ expires_in: 3_599 }, now)).toBe(now + 3_599_000)
  })

  test("accepts expires_in as a string", () => {
    expect(antigravityExpiresAt({ expires_in: "60" }, now)).toBe(now + 60_000)
  })

  test("parses the RFC3339 expiry of the agy file", () => {
    const ms = antigravityExpiresAt({ expiry: "2026-11-20T07:08:19.300175-05:00" }, now)
    expect(ms).toBe(Date.parse("2026-11-20T07:08:19.300175-05:00"))
  })

  test("an epoch value wins over the other shapes", () => {
    expect(antigravityExpiresAt({ expiresAt: 5_000, expires_in: 60 }, now)).toBe(5_000)
  })

  test("falls back to one hour when nothing parses", () => {
    expect(antigravityExpiresAt({}, now)).toBe(now + 3_599_000)
    expect(antigravityExpiresAt({ expiry: "not a date" }, now)).toBe(now + 3_599_000)
  })
})

describe("isExpired", () => {
  const now = 10_000_000

  test("false when the token is outside the skew window", () => {
    expect(isExpired({ ...base, expiresAt: now + REFRESH_SKEW_MS + 1 }, now)).toBe(false)
  })

  test("true inside the skew window, so the refresh happens early", () => {
    expect(isExpired({ ...base, expiresAt: now + REFRESH_SKEW_MS - 1 }, now)).toBe(true)
  })

  test("true for a past or absent expiry", () => {
    expect(isExpired({ ...base, expiresAt: now - 1 }, now)).toBe(true)
    expect(isExpired({ ...base, expiresAt: 0 }, now)).toBe(true)
  })

  test("a custom skew changes the window", () => {
    expect(isExpired({ ...base, expiresAt: now + 500 }, now, 1_000)).toBe(true)
    expect(isExpired({ ...base, expiresAt: now + 500 }, now, 100)).toBe(false)
  })
})

describe("agyTokenFilePaths", () => {
  test("lists the CLI file first and the legacy file second", () => {
    const paths = agyTokenFilePaths("/home/u")
    expect(paths[0]).toBe("/home/u/.gemini/antigravity-cli/antigravity-oauth-token")
    expect(paths[1]).toBe("/home/u/.gemini/jetski-standalone-oauth-token")
  })
})

describe("readAgyTokenFile", () => {
  const shape = {
    token: {
      access_token: "a-token",
      token_type: "Bearer",
      refresh_token: "r-token",
      expiry: "2026-11-20T07:08:19.300175-05:00",
    },
    auth_method: "consumer",
    id_token: "id-token",
  }

  test("reads the agy file shape and converts the expiry", () => {
    const path = join(scratch(), "token.json")
    writeFileSync(path, JSON.stringify(shape))
    const parsed = readAgyTokenFile(path)
    expect(parsed?.accessToken).toBe("a-token")
    expect(parsed?.refreshToken).toBe("r-token")
    expect(parsed?.authMethod).toBe("consumer")
    expect(parsed?.idToken).toBe("id-token")
    expect(parsed?.expiresAt).toBe(Date.parse(shape.token.expiry))
    expect(parsed?.importedFrom).toBe(path)
  })

  test("returns null for a missing file", () => {
    expect(readAgyTokenFile(join(scratch(), "absent.json"))).toBeNull()
  })

  test("returns null for broken JSON", () => {
    const path = join(scratch(), "broken.json")
    writeFileSync(path, "{not json")
    expect(readAgyTokenFile(path)).toBeNull()
  })

  test("returns null when a token field is missing", () => {
    const path = join(scratch(), "partial.json")
    writeFileSync(path, JSON.stringify({ token: { access_token: "only" } }))
    expect(readAgyTokenFile(path)).toBeNull()
  })

  test("never writes the file it reads", () => {
    const dir = scratch()
    const path = join(dir, "token.json")
    const text = JSON.stringify(shape)
    writeFileSync(path, text)
    readAgyTokenFile(path)
    expect(Bun.file(path).size).toBe(Buffer.byteLength(text))
  })
})
