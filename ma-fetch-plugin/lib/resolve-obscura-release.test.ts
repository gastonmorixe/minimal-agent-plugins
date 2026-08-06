import { describe, expect, test } from "bun:test"

import {
  type FetchLike,
  pickAssetForTarget,
  resolveObscuraBuild,
  targetForPlatform,
} from "./resolve-obscura-release.ts"

describe("targetForPlatform", () => {
  test("maps common Node platform keys", () => {
    expect(targetForPlatform("darwin-arm64")).toBe("aarch64-macos")
    expect(targetForPlatform("darwin-x64")).toBe("x86_64-macos")
    expect(targetForPlatform("linux-arm64")).toBe("aarch64-linux")
    expect(targetForPlatform("linux-x64")).toBe("x86_64-linux")
    expect(targetForPlatform("win32-x64")).toBeUndefined()
  })
})

describe("pickAssetForTarget", () => {
  const assets = [
    { id: 1, name: "obscura-aarch64-macos-1785512744.tar.gz" },
    { id: 2, name: "obscura-aarch64-macos-1785512744.tar.gz.sha256" },
    { id: 3, name: "obscura-x86_64-linux-1785512744.tar.gz" },
    { id: 4, name: "manifest-1785512744.json" },
  ]

  test("returns matching archive + epoch", () => {
    const picked = pickAssetForTarget(assets, "aarch64-macos")
    expect(picked?.asset.id).toBe(1)
    expect(picked?.epoch).toBe("1785512744")
  })

  test("ignores sidecars and unknown targets", () => {
    expect(pickAssetForTarget(assets, "aarch64-linux")).toBeUndefined()
  })
})

describe("resolveObscuraBuild", () => {
  test("resolves rolling latest via tag, then sidecar sha256", async () => {
    const calls: string[] = []
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith("/releases/tags/latest")) {
        return Response.json({
          tag_name: "latest",
          assets: [
            { id: 10, name: "obscura-aarch64-macos-999.tar.gz" },
            { id: 11, name: "obscura-aarch64-macos-999.tar.gz.sha256" },
          ],
        })
      }
      if (url.endsWith("/releases/assets/11")) {
        return new Response(
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  obscura-aarch64-macos-999.tar.gz\n",
          {
            headers: { "Content-Type": "application/octet-stream" },
          },
        )
      }
      return new Response("not found", { status: 404 })
    }

    const build = await resolveObscuraBuild({
      token: "t",
      platformKey: "darwin-arm64",
      fetch: fetchImpl,
    })
    expect(build).toEqual({
      version: "999",
      tag: "latest",
      asset: "obscura-aarch64-macos-999.tar.gz",
      sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      platform: "darwin-arm64",
    })
    expect(calls[0]).toContain("/releases/tags/latest")
  })

  test("falls back to /releases/latest when rolling tag is missing", async () => {
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input)
      if (url.endsWith("/releases/tags/latest")) {
        return new Response("{}", { status: 404 })
      }
      if (url.endsWith("/releases/latest")) {
        return Response.json({
          tag_name: "build-1780598942",
          assets: [
            { id: 20, name: "obscura-aarch64-linux-1780598942.tar.gz" },
            { id: 21, name: "obscura-aarch64-linux-1780598942.tar.gz.sha256" },
          ],
        })
      }
      if (url.endsWith("/releases/assets/21")) {
        return new Response("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n")
      }
      return new Response("nope", { status: 404 })
    }

    const build = await resolveObscuraBuild({
      token: "t",
      platformKey: "linux-arm64",
      fetch: fetchImpl,
    })
    expect(build.tag).toBe("build-1780598942")
    expect(build.version).toBe("1780598942")
    expect(build.sha256.startsWith("bbbb")).toBe(true)
  })
})
