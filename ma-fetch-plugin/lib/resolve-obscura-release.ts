/**
 * Resolve the current obscura binary for this platform from the private
 * `obscura-dist` release repo. No hardcoded build epoch: we always follow the
 * rolling `latest` release (with `/releases/latest` as fallback), then read the
 * matching asset + `.sha256` sidecar so the host can verify before install.
 *
 * @module lib/resolve-obscura-release
 */

/** Private repo that hosts compiled obscura release assets. */
export const OBSCURA_DIST_REPO = "gastonmorixe/obscura-dist"

/**
 * Rolling release tag Dist Release keeps updated in place. Preferred over
 * `/releases/latest` so we track the CI pointer, not whichever build-* GitHub
 * marked "latest" by accident.
 */
export const OBSCURA_ROLLING_TAG = "latest"

/** Maps Node `${platform}-${arch}` → asset target slug used in filenames. */
const PLATFORM_TO_TARGET: Record<string, string> = {
  "darwin-arm64": "aarch64-macos",
  "darwin-x64": "x86_64-macos",
  "linux-arm64": "aarch64-linux",
  "linux-x64": "x86_64-linux",
}

/** Asset filename: `obscura-<target>-<epoch>.tar.gz`. */
const ASSET_RE = /^obscura-([a-z0-9_]+-[a-z0-9]+)-(\d+)\.tar\.gz$/

export interface ObscuraReleaseAsset {
  id: number
  name: string
}

export interface ObscuraRelease {
  tag_name: string
  assets: ObscuraReleaseAsset[]
}

/** Resolved install coordinates for one platform. */
export interface ResolvedObscuraBuild {
  /** Build epoch string (also used as BinarySpec.version). */
  version: string
  /** Release tag to fetch (`latest` when the rolling release exists). */
  tag: string
  /** Archive asset filename inside the release. */
  asset: string
  /** Lowercase hex sha256 of the archive bytes. */
  sha256: string
  /** Node platform key that matched, e.g. `darwin-arm64`. */
  platform: string
}

export interface ResolveObscuraOptions {
  /** `owner/repo`. Defaults to {@link OBSCURA_DIST_REPO}. */
  repo?: string
  /** Override platform key (`darwin-arm64`). Defaults to runtime. */
  platformKey?: string
  /** Bearer token for the private dist repo. */
  token: string
  /** Injected fetch (tests). Defaults to global fetch. */
  fetch?: typeof globalThis.fetch
  /** Prefer this tag first (`latest`). Empty → only `/releases/latest`. */
  preferTag?: string
}

export class ResolveObscuraError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ResolveObscuraError"
  }
}

/** Target slug for a Node platform key, or undefined if unsupported. */
export function targetForPlatform(platformKey: string): string | undefined {
  return PLATFORM_TO_TARGET[platformKey]
}

/**
 * Pick the obscura archive asset for `target` from a release asset list.
 * Returns the asset + epoch derived from the filename.
 */
export function pickAssetForTarget(
  assets: ObscuraReleaseAsset[],
  target: string,
): { asset: ObscuraReleaseAsset; epoch: string } | undefined {
  for (const a of assets) {
    const m = a.name.match(ASSET_RE)
    if (!m) continue
    if (m[1] !== target) continue
    return { asset: a, epoch: m[2]! }
  }
  return undefined
}

async function apiJson<T>(
  url: string,
  token: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<{ ok: true; status: number; body: T } | { ok: false; status: number }> {
  const res = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "ma-fetch/resolve-obscura",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "follow",
  })
  if (!res.ok) return { ok: false, status: res.status }
  return { ok: true, status: res.status, body: (await res.json()) as T }
}

async function apiBytes(
  url: string,
  token: string,
  fetchImpl: typeof globalThis.fetch,
  accept: string,
): Promise<ArrayBuffer> {
  const res = await fetchImpl(url, {
    headers: {
      Accept: accept,
      Authorization: `Bearer ${token}`,
      "User-Agent": "ma-fetch/resolve-obscura",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "follow",
  })
  if (!res.ok) {
    throw new ResolveObscuraError(`GitHub asset fetch ${res.status} for ${url}`)
  }
  return await res.arrayBuffer()
}

/**
 * Load a release: try the rolling `latest` tag first, then GitHub's
 * `/releases/latest` pointer.
 */
export async function fetchObscuraRelease(
  opts: Pick<ResolveObscuraOptions, "repo" | "token" | "fetch" | "preferTag">,
): Promise<ObscuraRelease> {
  const repo = opts.repo ?? OBSCURA_DIST_REPO
  const fetchImpl = opts.fetch ?? globalThis.fetch
  const prefer = opts.preferTag ?? OBSCURA_ROLLING_TAG
  const base = `https://api.github.com/repos/${repo}/releases`

  if (prefer) {
    const tagged = await apiJson<ObscuraRelease>(
      `${base}/tags/${encodeURIComponent(prefer)}`,
      opts.token,
      fetchImpl,
    )
    if (tagged.ok) return tagged.body
    if (tagged.status !== 404) {
      throw new ResolveObscuraError(`GitHub API ${tagged.status} for ${repo} tag ${prefer}`)
    }
  }

  const latest = await apiJson<ObscuraRelease>(`${base}/latest`, opts.token, fetchImpl)
  if (!latest.ok) {
    throw new ResolveObscuraError(`GitHub API ${latest.status} for ${repo} /releases/latest`)
  }
  return latest.body
}

/** Read sha256 from `<asset>.sha256` sidecar, else hash the archive bytes. */
export async function sha256ForAsset(
  repo: string,
  asset: ObscuraReleaseAsset,
  assets: ObscuraReleaseAsset[],
  token: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<string> {
  const sidecar = assets.find((a) => a.name === `${asset.name}.sha256`)
  if (sidecar) {
    const buf = await apiBytes(
      `https://api.github.com/repos/${repo}/releases/assets/${sidecar.id}`,
      token,
      fetchImpl,
      "application/octet-stream",
    )
    const txt = new TextDecoder().decode(buf).trim()
    const hex = txt.split(/\s+/)[0]
    if (hex && /^[0-9a-f]{64}$/i.test(hex)) return hex.toLowerCase()
  }

  const archive = await apiBytes(
    `https://api.github.com/repos/${repo}/releases/assets/${asset.id}`,
    token,
    fetchImpl,
    "application/octet-stream",
  )
  const { createHash } = await import("node:crypto")
  return createHash("sha256").update(Buffer.from(archive)).digest("hex")
}

/**
 * Resolve the current obscura build for this (or an overridden) platform.
 * Throws {@link ResolveObscuraError} when the platform is unsupported, the
 * release has no matching asset, or GitHub/auth fails.
 */
export async function resolveObscuraBuild(
  opts: ResolveObscuraOptions,
): Promise<ResolvedObscuraBuild> {
  const platform = opts.platformKey ?? `${process.platform}-${process.arch}`
  const target = targetForPlatform(platform)
  if (!target) {
    throw new ResolveObscuraError(`unsupported platform ${platform}`)
  }
  if (!opts.token.trim()) {
    throw new ResolveObscuraError("missing GitHub token for obscura-dist")
  }

  const repo = opts.repo ?? OBSCURA_DIST_REPO
  const fetchImpl = opts.fetch ?? globalThis.fetch
  const release = await fetchObscuraRelease({
    repo,
    token: opts.token,
    fetch: fetchImpl,
    preferTag: opts.preferTag,
  })
  const picked = pickAssetForTarget(release.assets, target)
  if (!picked) {
    throw new ResolveObscuraError(
      `no obscura asset for ${platform} (${target}) in ${repo}@${release.tag_name}`,
    )
  }

  const sha256 = await sha256ForAsset(repo, picked.asset, release.assets, opts.token, fetchImpl)
  return {
    version: picked.epoch,
    // Prefer the rolling tag when we resolved via it; otherwise the concrete tag.
    tag: release.tag_name,
    asset: picked.asset.name,
    sha256,
    platform,
  }
}
