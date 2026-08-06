#!/usr/bin/env bun
/**
 * Optional offline pin helper for ma-fetch.
 *
 * Runtime setup() resolves the rolling `latest` obscura-dist release (no
 * hardcoded epoch). This script remains for operators who want to inspect
 * epoch/sha256s for debugging, or dump a pin map for a fork.
 *
 * Reads a release from the private `gastonmorixe/obscura-dist` repo via the
 * GitHub API, computes each platform's sha256 from the release's `.sha256`
 * sidecars (falling back to downloading the asset when a sidecar is missing),
 * and prints the resolved map as JSON. It never touches `setup.ts` or
 * `obscura-token.ts`.
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

  const out = { repo: REPO, tag: realTag, version: epoch, builds }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
  process.stderr.write(
    "\n(setup.ts is unpinned and resolves latest at runtime; this dump is informational)\n",
  )
}

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

await main()

export {}
