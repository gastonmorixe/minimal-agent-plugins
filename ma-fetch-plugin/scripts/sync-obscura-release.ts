#!/usr/bin/env bun
/**
 * Optional offline pin helper for ma-fetch.
 *
 * Runtime setup() resolves the rolling `latest` obscura release (no
 * hardcoded epoch). This script remains for operators who want to inspect
 * epoch/sha256s for debugging, or dump a pin map for a fork.
 *
 * Reads a release from the public `gastonmorixe/obscura` repo via the GitHub
 * API (anonymous), takes each platform's sha256 from GitHub's asset digest or
 * the release's `.sha256` sidecar, and prints the resolved map as JSON. It
 * never touches `setup.ts`.
 *
 * Run from the plugins repo (or anywhere; paths resolve relative to this file):
 *
 *   bun ma-fetch-plugin/scripts/sync-obscura-release.ts latest
 *   bun ma-fetch-plugin/scripts/sync-obscura-release.ts build-1780598942
 *
 * Auth: none. The repo is public. Anonymous API calls are rate limited to 60/h.
 *
 * @module scripts/sync-obscura-release
 */

import { buildTagFor, OBSCURA_REPO, sha256ForAsset } from "../lib/resolve-obscura-release.ts"

const REPO = OBSCURA_REPO

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
  browser_download_url?: string
  digest?: string | null
}

function fail(message: string): never {
  process.stderr.write(`sync-obscura-release: ${message}\n`)
  process.exit(1)
}

async function main(): Promise<void> {
  const tag = process.argv[2]
  if (!tag) fail("usage: sync-obscura-release.ts <tag|latest>")

  const relUrl =
    tag === "latest"
      ? `https://api.github.com/repos/${REPO}/releases/latest`
      : `https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`
  const res = await fetch(relUrl, {
    headers: { "User-Agent": "ma-fetch/sync", Accept: "application/vnd.github+json" },
  })
  if (!res.ok) fail(`GitHub API ${res.status} for ${relUrl}`)
  const rel = (await res.json()) as {
    tag_name: string
    assets: ReleaseAsset[]
  }
  const realTag = rel.tag_name
  process.stderr.write(`Release: ${realTag} (${rel.assets.length} assets)\n`)

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
    const sha = await sha256ForAsset(REPO, realTag, asset, rel.assets)
    builds[key] = { asset: asset.name, sha256: sha }
    process.stderr.write(`  ${key}: ${asset.name} ${sha.slice(0, 12)}…\n`)
  }
  if (Object.keys(builds).length === 0) fail("no obscura-* assets found in the release")
  if (!epoch) fail("could not derive an epoch from any asset name")

  const out = { repo: REPO, tag: realTag, pin: buildTagFor(epoch), version: epoch, builds }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
  process.stderr.write(
    "\n(setup.ts is unpinned and resolves latest at runtime; this dump is informational)\n",
  )
}

await main()
