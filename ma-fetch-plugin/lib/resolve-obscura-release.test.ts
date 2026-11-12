import { describe, expect, test } from "bun:test"

import {
  type FetchLike,
  obscuraDownloadUrl,
  pickAssetForTarget,
  ResolveObscuraError,
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

describe("obscuraDownloadUrl", () => {
  test("builds the public release download URL", () => {
    expect(
      obscuraDownloadUrl({ tag: "build-999", asset: "obscura-aarch64-linux-999.tar.gz" }),
    ).toBe(
      "https://github.com/gastonmorixe/obscura/releases/download/build-999/obscura-aarch64-linux-999.tar.gz",
    )
  })
})

describe("resolveObscuraBuild", () => {
  test("resolves rolling latest anonymously, sha256 from sidecar, pins build tag", async () => {
    const calls: { url: string; auth: string | null }[] = []
    const fetchImpl: FetchLike = async (input, init) => {
      const url = String(input)
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") })
      if (url.endsWith("/repos/gastonmorixe/obscura/releases/tags/latest")) {
        return Response.json({
          tag_name: "latest",
          assets: [
            { id: 10, name: "obscura-aarch64-macos-999.tar.gz" },
            {
              id: 11,
              name: "obscura-aarch64-macos-999.tar.gz.sha256",
              browser_download_url: "https://github.com/x/sidecar",
            },
          ],
        })
      }
      if (url === "https://github.com/x/sidecar") {
        return new Response(`${"a".repeat(64)}  obscura-aarch64-macos-999.tar.gz\n`)
      }
      return new Response("not found", { status: 404 })
    }

    const build = await resolveObscuraBuild({ platformKey: "darwin-arm64", fetch: fetchImpl })
    expect(build).toEqual({
      version: "999",
      tag: "build-999",
      asset: "obscura-aarch64-macos-999.tar.gz",
      sha256: "a".repeat(64),
      platform: "darwin-arm64",
    })
    expect(calls[0]!.url).toContain("/releases/tags/latest")
    expect(calls.every((c) => c.auth === null)).toBe(true)
  })

  test("prefers GitHub asset digest and skips the sidecar request", async () => {
    const calls: string[] = []
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith("/releases/tags/latest")) {
        return Response.json({
          tag_name: "latest",
          assets: [
            {
              id: 30,
              name: "obscura-x86_64-linux-777.tar.gz",
              digest: `sha256:${"E".repeat(64)}`,
            },
            { id: 31, name: "obscura-x86_64-linux-777.tar.gz.sha256" },
          ],
        })
      }
      return new Response("unexpected", { status: 500 })
    }
    const build = await resolveObscuraBuild({ platformKey: "linux-x64", fetch: fetchImpl })
    expect(build.sha256).toBe("e".repeat(64))
    expect(calls).toHaveLength(1)
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
      if (
        url ===
        "https://github.com/gastonmorixe/obscura/releases/download/build-1780598942/obscura-aarch64-linux-1780598942.tar.gz.sha256"
      ) {
        return new Response(`${"b".repeat(64)}\n`)
      }
      return new Response("nope", { status: 404 })
    }

    const build = await resolveObscuraBuild({ platformKey: "linux-arm64", fetch: fetchImpl })
    expect(build.tag).toBe("build-1780598942")
    expect(build.version).toBe("1780598942")
    expect(build.sha256).toBe("b".repeat(64))
  })

  test("fails closed when no checksum is published", async () => {
    const fetchImpl: FetchLike = async () =>
      Response.json({
        tag_name: "latest",
        assets: [{ id: 40, name: "obscura-aarch64-linux-5.tar.gz" }],
      })
    await expect(
      resolveObscuraBuild({ platformKey: "linux-arm64", fetch: fetchImpl }),
    ).rejects.toBeInstanceOf(ResolveObscuraError)
  })
})
