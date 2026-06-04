#!/usr/bin/env bun
/**
 * Sync the ma-fetch plugin to a published obscura release.
 *
 * Reads a release from the private `gastonmorixe/obscura-dist` repo via the
 * GitHub API, computes each platform's sha256 from the release's `.sha256`
 * sidecars (falling back to downloading the asset when a sidecar is missing),
 * and rewrites the pinned block in `setup.ts` (`OBSCURA_VERSION`, `OBSCURA_TAG`,
 * `OBSCURA_BUILDS`). It never touches `obscura-token.ts`.
 *
 * Run from the plugins repo (or anywhere; paths resolve relative to this file):
 *
 *   bun ma-fetch-plugin/scripts/sync-obscura-release.ts latest
 *   bun ma-fetch-plugin/scripts/sync-obscura-release.ts build-1780598942
 *
 * Auth: uses `GITHUB_TOKEN` / `GH_TOKEN` if set, else `gh auth token`. The
 * token only needs read access to `obscura-dist`.
 *
 * @module scripts/sync-obscura-release
 */

import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const REPO = "gastonmorixe/obscura-dist"

/** Maps the Rust target slug in an asset name to a Node platform-arch key. */
const TARGET_TO_KEY: Record<string, string> = {
  "aarch64-macos": "darwin-arm64",
  "x86_64-macos": "darwin-x64",
  "aarch64-linux": "linux-arm64",
  "x86_64-linux": "linux-x64",
}

/** Asset filename shape: `obscura-<target>-<epoch>.tar.gz`. */
const ASSET_RE = /^obscura-([a-z0-9_]+-[a-z0-9]+)-(\d+)\.tar\.gz$/

interface ReleaseAsset {
  id: number
  name: string
}

async function resolveToken(): Promise<string> {
  const env = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim()
  if (env) return env
  try {
    const proc = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" })
    const out = (await new Response(proc.stdout).text()).trim()
    await proc.exited
    if (proc.exitCode === 0 && out.length > 0) return out
  } catch {
    // fall through
  }
  fail("no GitHub token available (set GITHUB_TOKEN / GH_TOKEN, or run `gh auth login`)")
}

function fail(message: string): never {
  process.stderr.write(`sync-obscura-release: ${message}\n`)
  process.exit(1)
}

async function api(url: string, token: string, accept: string): Promise<Response> {
  const res = await fetch(url, {
    headers: { "User-Agent": "ma-fetch/sync", Authorization: `Bearer ${token}`, Accept: accept },
    redirect: "follow",
  })
  if (!res.ok) fail(`GitHub API ${res.status} for ${url}`)
  return res
}

async function main(): Promise<void> {
  const tag = process.argv[2]
  if (!tag) fail("usage: sync-obscura-release.ts <tag|latest>")
  const token = await resolveToken()

  // 1. Resolve the release (by tag, or the rolling `latest`).
  const relUrl =
    tag === "latest"
      ? `https://api.github.com/repos/${REPO}/releases/latest`
      : `https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`
  const rel = (await (await api(relUrl, token, "application/vnd.github+json")).json()) as {
    tag_name: string
    assets: ReleaseAsset[]
  }
  const realTag = rel.tag_name
  process.stderr.write(`Release: ${realTag} (${rel.assets.length} assets)\n`)

  // 2. Walk the binary assets, derive (key, epoch, sha256) for each.
  const byId = new Map(rel.assets.map((a) => [a.name, a]))
  const builds: Record<string, { asset: string; sha256: string }> = {}
  let epoch = ""
  for (const asset of rel.assets) {
    const m = asset.name.match(ASSET_RE)
    if (!m) continue
    const key = TARGET_TO_KEY[m[1]!]
    if (!key) {
      process.stderr.write(`  skip unknown target: ${asset.name}\n`)
      continue
    }
    epoch = m[2]!
    const sha = await shaFor(asset, byId, token)
    builds[key] = { asset: asset.name, sha256: sha }
    process.stderr.write(`  ${key}: ${asset.name} ${sha.slice(0, 12)}…\n`)
  }
  if (Object.keys(builds).length === 0) fail("no obscura-* assets found in the release")
  if (!epoch) fail("could not derive an epoch from any asset name")

  // 3. Rewrite setup.ts.
  const setupPath = join(dirname(import.meta.dir), "setup.ts")
  patchSetup(setupPath, epoch, realTag, builds)
  process.stderr.write(`\nUpdated ${setupPath}\n`)
  process.stderr.write(`  OBSCURA_VERSION = ${epoch}\n  OBSCURA_TAG = ${realTag}\n`)
  process.stderr.write("Next: `bun test setup.test.ts`, then commit setup.ts.\n")
}

/**
 * Resolve an asset's sha256: prefer the `<asset>.sha256` sidecar, else download
 * the asset and hash it. The sidecar avoids pulling tens of MB just to hash.
 */
async function shaFor(
  asset: ReleaseAsset,
  byId: Map<string, ReleaseAsset>,
  token: string,
): Promise<string> {
  const sidecar = byId.get(`${asset.name}.sha256`)
  if (sidecar) {
    const txt = await (
      await api(
        `https://api.github.com/repos/${REPO}/releases/assets/${sidecar.id}`,
        token,
        "application/octet-stream",
      )
    ).text()
    const hex = txt.trim().split(/\s+/)[0]
    if (hex && /^[0-9a-f]{64}$/i.test(hex)) return hex.toLowerCase()
  }
  // Fallback: download + hash the asset bytes.
  const buf = await (
    await api(
      `https://api.github.com/repos/${REPO}/releases/assets/${asset.id}`,
      token,
      "application/octet-stream",
    )
  ).arrayBuffer()
  const { createHash } = await import("node:crypto")
  return createHash("sha256").update(Buffer.from(buf)).digest("hex")
}

/** Render the OBSCURA_BUILDS object literal, preserving a stable key order. */
function renderBuilds(builds: Record<string, { asset: string; sha256: string }>): string {
  const order = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]
  const keys = [...new Set([...order.filter((k) => k in builds), ...Object.keys(builds)])]
  const lines = keys.map((k) => {
    const b = builds[k]!
    return `  "${k}": {\n    asset: "${b.asset}",\n    sha256: "${b.sha256}",\n  },`
  })
  return `const OBSCURA_BUILDS: Record<string, PlatformBuild> = {\n${lines.join("\n")}\n}`
}

/**
 * Replace the pinned block in `setup.ts`: `OBSCURA_VERSION`, `OBSCURA_TAG`, and
 * the whole `OBSCURA_BUILDS` literal. Anchored on the exact declarations so the
 * surrounding comments and code are untouched.
 */
function patchSetup(
  path: string,
  epoch: string,
  tag: string,
  builds: Record<string, { asset: string; sha256: string }>,
): void {
  let src = readFileSync(path, "utf8")

  const verRe = /const OBSCURA_VERSION = "[^"]*"/
  const tagRe = /const OBSCURA_TAG = "[^"]*"/
  // Match from the builds declaration through its closing brace at column 0.
  const buildsRe = /const OBSCURA_BUILDS: Record<string, PlatformBuild> = \{[\s\S]*?\n\}/

  if (!verRe.test(src)) fail("could not find OBSCURA_VERSION in setup.ts")
  if (!tagRe.test(src)) fail("could not find OBSCURA_TAG in setup.ts")
  if (!buildsRe.test(src)) fail("could not find OBSCURA_BUILDS in setup.ts")

  src = src.replace(verRe, `const OBSCURA_VERSION = "${epoch}"`)
  src = src.replace(tagRe, `const OBSCURA_TAG = "${tag}"`)
  src = src.replace(buildsRe, renderBuilds(builds))

  writeFileSync(path, src)
}

await main()
