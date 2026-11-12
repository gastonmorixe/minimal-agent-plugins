import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { obscuraReleaseCachePath, writeCachedObscuraRelease } from "./lib/obscura-release-cache.ts"
import setup, { resetObscuraReleaseRefreshForTest } from "./setup.ts"

interface FakeInv {
  dir: string
  has(name: string): boolean
  get(name: string): { version: string | null } | undefined
  status(): "satisfied" | "missing" | "outdated" | "unknown-version"
}

/** Warnings the fake logger received, reset per test. */
let warnings: string[] = []

function ctx(inv: Partial<FakeInv> = {}, env: Record<string, string> = {}) {
  return {
    packageDir: "/pkg",
    cwd: "/cwd",
    env,
    binaries: {
      dir: "/bin",
      has: () => false,
      get: () => undefined,
      status: () => "missing" as const,
      ...inv,
    },
    log: {
      info: () => {},
      notice: () => {},
      warn: (_source: string, message: string) => {
        warnings.push(message)
      },
    },
  }
}

const TARGET_BY_PLATFORM: Record<string, string> = {
  "darwin-arm64": "aarch64-macos",
  "darwin-x64": "x86_64-macos",
  "linux-arm64": "aarch64-linux",
  "linux-x64": "x86_64-linux",
}

const TOKEN_VARS = ["MINIMAL_AGENT_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"]
const prevTokens: Record<string, string | undefined> = {}

describe("ma-fetch setup()", () => {
  let cfgDir: string
  let prevCfg: string | undefined
  let prevHome: string | undefined
  let prevFetch: typeof globalThis.fetch

  beforeEach(() => {
    cfgDir = mkdtempSync(join(tmpdir(), "ma-fetch-setup-"))
    prevCfg = process.env.MINIMAL_AGENT_CONFIG
    prevHome = process.env.MINIMAL_AGENT_HOME
    prevFetch = globalThis.fetch
    process.env.MINIMAL_AGENT_HOME = cfgDir
    warnings = []
    for (const k of TOKEN_VARS) {
      prevTokens[k] = process.env[k]
      delete process.env[k]
    }
    resetObscuraReleaseRefreshForTest()
  })
  afterEach(() => {
    if (prevCfg === undefined) delete process.env.MINIMAL_AGENT_CONFIG
    else process.env.MINIMAL_AGENT_CONFIG = prevCfg
    if (prevHome === undefined) delete process.env.MINIMAL_AGENT_HOME
    else process.env.MINIMAL_AGENT_HOME = prevHome
    globalThis.fetch = prevFetch
    for (const k of TOKEN_VARS) {
      if (prevTokens[k] === undefined) delete process.env[k]
      else process.env[k] = prevTokens[k]
    }
    resetObscuraReleaseRefreshForTest()
    rmSync(cfgDir, { recursive: true, force: true })
  })

  test("skips provisioning when obscura.bin is configured", async () => {
    const cfgPath = join(cfgDir, "config.jsonc")
    writeFileSync(
      cfgPath,
      `{
        // operator points at a local build
        "plugins": { "ma-fetch": { "obscura": { "bin": "/Users/me/Projects/obscura/target/release/obscura" } } },
      }`,
    )
    process.env.MINIMAL_AGENT_CONFIG = cfgPath
    const result = await setup(ctx())
    expect(result.requireBinaries).toBeUndefined()
    expect(result).not.toHaveProperty("haltIfMissing")
  })

  test("uses fresh cached release metadata without contacting GitHub", async () => {
    const cfgPath = join(cfgDir, "config.jsonc")
    writeFileSync(cfgPath, `{}`)
    process.env.MINIMAL_AGENT_CONFIG = cfgPath

    const platform = `${process.platform}-${process.arch}`
    const target = TARGET_BY_PLATFORM[platform]
    if (!target) return
    const asset = `obscura-${target}-424242.tar.gz`
    const sha = "c".repeat(64)
    writeCachedObscuraRelease(obscuraReleaseCachePath(cfgDir, platform), {
      version: "424242",
      tag: "build-424242",
      asset,
      sha256: sha,
      platform,
    })
    let requests = 0
    globalThis.fetch = (async () => {
      requests += 1
      return new Response("unexpected", { status: 500 })
    }) as unknown as typeof fetch

    const result = await setup(ctx())
    const spec = result.requireBinaries?.[0]
    expect(requests).toBe(0)
    expect(spec?.version).toBe("424242")
    expect(spec?.sha256).toBe(sha)
    // Never fatal: a missing engine disables Fetch, it does not halt boot.
    expect(result).not.toHaveProperty("haltIfMissing")
  })

  test("declares obscura from resolved latest release", async () => {
    const cfgPath = join(cfgDir, "config.jsonc")
    writeFileSync(cfgPath, `{}`)
    process.env.MINIMAL_AGENT_CONFIG = cfgPath

    const platform = `${process.platform}-${process.arch}`
    const target = TARGET_BY_PLATFORM[platform]
    if (!target) {
      const result = await setup(ctx())
      expect(result.requireBinaries).toBeUndefined()
      return
    }

    const asset = `obscura-${target}-424242.tar.gz`
    const sha = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    const authHeaders: (string | null)[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      authHeaders.push(new Headers(init?.headers).get("authorization"))
      if (url.includes("/repos/gastonmorixe/obscura/releases/tags/latest")) {
        return Response.json({
          tag_name: "latest",
          assets: [
            { id: 1, name: asset },
            { id: 2, name: `${asset}.sha256` },
          ],
        })
      }
      if (url.endsWith(`/releases/download/latest/${asset}.sha256`)) {
        return new Response(`${sha}  ${asset}\n`)
      }
      return new Response("nope", { status: 404 })
    }) as unknown as typeof fetch

    const result = await setup(ctx())
    const spec = result.requireBinaries?.[0]
    expect(spec).toBeDefined()
    expect(spec!.name).toBe("obscura")
    expect(spec!.version).toBe("424242")
    expect(spec!.sha256).toBe(sha)
    expect(spec!.archiveMember).toBe("obscura")
    expect(spec!.archiveExtraMembers).toEqual(["obscura-worker"])
    expect(spec!.source).toEqual({
      kind: "url",
      url: `https://github.com/gastonmorixe/obscura/releases/download/build-424242/${asset}`,
      archive: true,
    })
    expect(spec!.source).not.toHaveProperty("token")
    expect(authHeaders.every((h) => h === null)).toBe(true)
    expect(result).not.toHaveProperty("haltIfMissing")
  })

  test("uses stale cached metadata immediately and refreshes it in the background", async () => {
    const cfgPath = join(cfgDir, "config.jsonc")
    writeFileSync(cfgPath, `{}`)
    process.env.MINIMAL_AGENT_CONFIG = cfgPath

    const platform = `${process.platform}-${process.arch}`
    const target = TARGET_BY_PLATFORM[platform]
    if (!target) return
    const oldAsset = `obscura-${target}-424242.tar.gz`
    const freshAsset = `obscura-${target}-424243.tar.gz`
    writeCachedObscuraRelease(
      obscuraReleaseCachePath(cfgDir, platform),
      {
        version: "424242",
        tag: "build-424242",
        asset: oldAsset,
        sha256: "c".repeat(64),
        platform,
      },
      0,
    )
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/releases/tags/latest")) {
        return Response.json({
          tag_name: "latest",
          assets: [
            { id: 1, name: freshAsset },
            { id: 2, name: `${freshAsset}.sha256` },
          ],
        })
      }
      if (url.endsWith(`/releases/download/latest/${freshAsset}.sha256`))
        return new Response(`${"d".repeat(64)}  ${freshAsset}\n`)
      return new Response("nope", { status: 404 })
    }) as unknown as typeof fetch

    const result = await setup(ctx())
    expect(result.requireBinaries?.[0]?.version).toBe("424242")
    await Bun.sleep(10)
    expect(result.requireBinaries?.[0]?.version).toBe("424242")

    const refreshed = await setup(ctx())
    expect(refreshed.requireBinaries?.[0]?.version).toBe("424243")
  })

  test("ignores a v1 cache record from obscura-dist and re-resolves", async () => {
    const cfgPath = join(cfgDir, "config.jsonc")
    writeFileSync(cfgPath, `{}`)
    process.env.MINIMAL_AGENT_CONFIG = cfgPath

    const platform = `${process.platform}-${process.arch}`
    const target = TARGET_BY_PLATFORM[platform]
    if (!target) return
    const cachePath = obscuraReleaseCachePath(cfgDir, platform)
    mkdirSync(dirname(cachePath), { recursive: true })
    writeFileSync(
      cachePath,
      JSON.stringify({
        schemaVersion: 1,
        checkedAt: Date.now(),
        version: "1785979910",
        tag: "latest",
        asset: `obscura-${target}-1785979910.tar.gz`,
        sha256: "f".repeat(64),
        platform,
      }),
    )
    const asset = `obscura-${target}-555.tar.gz`
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/releases/tags/latest")) {
        return Response.json({
          tag_name: "latest",
          assets: [{ id: 1, name: asset, digest: `sha256:${"9".repeat(64)}` }],
        })
      }
      return new Response("nope", { status: 404 })
    }) as unknown as typeof fetch

    const result = await setup(ctx())
    expect(result.requireBinaries?.[0]?.version).toBe("555")
  })

  test("keeps installed binary when latest resolve fails", async () => {
    const cfgPath = join(cfgDir, "config.jsonc")
    writeFileSync(cfgPath, `{}`)
    process.env.MINIMAL_AGENT_CONFIG = cfgPath

    globalThis.fetch = (async () =>
      new Response("down", { status: 503 })) as unknown as typeof fetch

    const result = await setup(ctx({ has: () => true }))
    expect(result.requireBinaries).toBeUndefined()
    expect(result).not.toHaveProperty("haltIfMissing")
  })

  test("offline first start: no halt, one warning, Fetch left off", async () => {
    const cfgPath = join(cfgDir, "config.jsonc")
    writeFileSync(cfgPath, `{}`)
    process.env.MINIMAL_AGENT_CONFIG = cfgPath
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed: getaddrinfo ENOTFOUND api.github.com")
    }) as unknown as typeof fetch

    const result = await setup(ctx())
    expect(result).toEqual({})
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toStartWith("Fetch disabled:")
    expect(warnings[0]).not.toContain("\n")
  })

  test("rate limited: the warning names the limit and the token env var", async () => {
    const cfgPath = join(cfgDir, "config.jsonc")
    writeFileSync(cfgPath, `{}`)
    process.env.MINIMAL_AGENT_CONFIG = cfgPath
    if (!TARGET_BY_PLATFORM[`${process.platform}-${process.arch}`]) return
    globalThis.fetch = (async () =>
      new Response("rate limited", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      })) as unknown as typeof fetch

    const result = await setup(ctx())
    expect(result).toEqual({})
    expect(warnings[0]).toContain("rate limit")
    expect(warnings[0]).toContain("GITHUB_TOKEN")
  })

  test("sends an env GitHub token on the API lookup only, never on the download URL", async () => {
    const cfgPath = join(cfgDir, "config.jsonc")
    writeFileSync(cfgPath, `{}`)
    process.env.MINIMAL_AGENT_CONFIG = cfgPath
    const target = TARGET_BY_PLATFORM[`${process.platform}-${process.arch}`]
    if (!target) return
    process.env.GH_TOKEN = "gh-env-token"
    const asset = `obscura-${target}-777.tar.gz`
    const seen: Array<{ url: string; auth: string | null }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      seen.push({ url, auth: new Headers(init?.headers).get("authorization") })
      if (url.includes("/releases/tags/latest")) {
        return Response.json({
          tag_name: "latest",
          assets: [{ id: 1, name: asset, digest: `sha256:${"a".repeat(64)}` }],
        })
      }
      return new Response("nope", { status: 404 })
    }) as unknown as typeof fetch

    const result = await setup(ctx())
    expect(result.requireBinaries?.[0]?.version).toBe("777")
    expect(seen).toHaveLength(1)
    expect(seen[0]?.auth).toBe("Bearer gh-env-token")
    expect(result.requireBinaries?.[0]?.source).not.toHaveProperty("token")
  })

  test("a rejected token (401) falls back to an anonymous lookup", async () => {
    const cfgPath = join(cfgDir, "config.jsonc")
    writeFileSync(cfgPath, `{}`)
    process.env.MINIMAL_AGENT_CONFIG = cfgPath
    const target = TARGET_BY_PLATFORM[`${process.platform}-${process.arch}`]
    if (!target) return
    process.env.MINIMAL_AGENT_GITHUB_TOKEN = "expired"
    const asset = `obscura-${target}-778.tar.gz`
    const auths: Array<string | null> = []
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization")
      auths.push(auth)
      if (auth) return new Response("bad creds", { status: 401 })
      return Response.json({
        tag_name: "latest",
        assets: [{ id: 1, name: asset, digest: `sha256:${"b".repeat(64)}` }],
      })
    }) as unknown as typeof fetch

    const result = await setup(ctx())
    expect(result.requireBinaries?.[0]?.version).toBe("778")
    expect(auths).toEqual(["Bearer expired", null])
  })
})
