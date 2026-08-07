import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { obscuraReleaseCachePath, writeCachedObscuraRelease } from "./lib/obscura-release-cache.ts"
import setup, { resetObscuraReleaseRefreshForTest } from "./setup.ts"

interface FakeInv {
  dir: string
  has(name: string): boolean
  get(name: string): { version: string | null } | undefined
  status(): "satisfied" | "missing" | "outdated" | "unknown-version"
}

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
    log: { info: () => {}, notice: () => {} },
  }
}

const TARGET_BY_PLATFORM: Record<string, string> = {
  "darwin-arm64": "aarch64-macos",
  "darwin-x64": "x86_64-macos",
  "linux-arm64": "aarch64-linux",
  "linux-x64": "x86_64-linux",
}

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
    resetObscuraReleaseRefreshForTest()
  })
  afterEach(() => {
    if (prevCfg === undefined) delete process.env.MINIMAL_AGENT_CONFIG
    else process.env.MINIMAL_AGENT_CONFIG = prevCfg
    if (prevHome === undefined) delete process.env.MINIMAL_AGENT_HOME
    else process.env.MINIMAL_AGENT_HOME = prevHome
    globalThis.fetch = prevFetch
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
    expect(result.haltIfMissing).toBeUndefined()
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
      tag: "latest",
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
    expect(result.haltIfMissing).toEqual(["obscura"])
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
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/releases/tags/latest")) {
        return Response.json({
          tag_name: "latest",
          assets: [
            { id: 1, name: asset },
            { id: 2, name: `${asset}.sha256` },
          ],
        })
      }
      if (url.includes("/releases/assets/2")) {
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
    expect(spec!.source.kind).toBe("github-release")
    if (spec!.source.kind === "github-release") {
      expect(spec!.source.repo).toBe("gastonmorixe/obscura-dist")
      expect(spec!.source.tag).toBe("latest")
      expect(spec!.source.asset).toBe(asset)
    }
    expect(result.haltIfMissing).toEqual(["obscura"])
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
        tag: "latest",
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
      if (url.includes("/releases/assets/2"))
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

  test("keeps installed binary when latest resolve fails", async () => {
    const cfgPath = join(cfgDir, "config.jsonc")
    writeFileSync(cfgPath, `{}`)
    process.env.MINIMAL_AGENT_CONFIG = cfgPath

    globalThis.fetch = (async () =>
      new Response("down", { status: 503 })) as unknown as typeof fetch

    const result = await setup(ctx({ has: () => true }))
    expect(result.requireBinaries).toBeUndefined()
    expect(result.haltIfMissing).toBeUndefined()
  })
})
