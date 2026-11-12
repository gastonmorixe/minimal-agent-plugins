/**
 * Resolve the current obscura binary for this platform from the PUBLIC
 * `gastonmorixe/obscura` releases. No hardcoded build epoch: we read the
 * rolling `latest` release (with `/releases/latest` as fallback), pick the
 * asset for this platform, and pin it to its immutable
 * `build-<epoch>` tag so a later `latest` refresh (which prunes old assets)
 * can never 404 a cached install coordinate.
 *
 * The sha256 comes from GitHub's own asset `digest` field when present, else
 * from the `<asset>.sha256` sidecar the Dist Release workflow publishes. The
 * host verifies the downloaded bytes against it before install.
 *
 * The lookup is anonymous by default. Anonymous `api.github.com` calls share
 * a 60 per hour limit per IP, so when the environment already carries a
 * GitHub token (`MINIMAL_AGENT_GITHUB_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`) it
 * is sent on the API lookup only, never on the public CDN download. A token
 * is never required, and a rejected one (401) falls back to anonymous. The
 * plugin never runs `gh` or reads a credential store.
 *
 * @module lib/resolve-obscura-release
 */

/** Public repo whose Releases host the compiled obscura assets. */
export const OBSCURA_REPO = "gastonmorixe/obscura"

/**
 * Rolling release tag the Dist Release workflow keeps updated in place.
 * Preferred over `/releases/latest` so we track the CI pointer, not whichever
 * build GitHub happened to mark "latest".
 */
export const OBSCURA_ROLLING_TAG = "latest"

/** Maps Node `${platform}-${arch}` to the asset target slug used in filenames. */
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
  /** Public CDN URL (no auth needed on a public repo). */
  browser_download_url?: string
  /** GitHub-computed digest, e.g. `sha256:<hex>`. Absent on older releases. */
  digest?: string | null
}

export interface ObscuraRelease {
  tag_name: string
  assets: ObscuraReleaseAsset[]
}

/** Resolved install coordinates for one platform. */
export interface ResolvedObscuraBuild {
  /** Build epoch string (also used as BinarySpec.version). */
  version: string
  /** Immutable release tag that holds the asset, `build-<epoch>`. */
  tag: string
  /** Archive asset filename inside the release. */
  asset: string
  /** Lowercase hex sha256 of the archive bytes. */
  sha256: string
  /** Node platform key that matched, e.g. `darwin-arm64`. */
  platform: string
}

/** Minimal fetch shape so Bun's `preconnect`-augmented `typeof fetch` isn't required. */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface ResolveObscuraOptions {
  /** `owner/repo`. Defaults to {@link OBSCURA_REPO}. */
  repo?: string
  /** Override platform key (`darwin-arm64`). Defaults to runtime. */
  platformKey?: string
  /** Injected fetch (tests). Defaults to global fetch. */
  fetch?: FetchLike
  /** Prefer this tag first (`latest`). Empty means only `/releases/latest`. */
  preferTag?: string
  /**
   * Optional GitHub token for the `api.github.com` lookup (rate limit only;
   * the repo is public). See {@link githubTokenFromEnv}.
   */
  token?: string
}

/** Env vars checked, in order, for an optional GitHub API token. */
export const GITHUB_TOKEN_ENV_VARS = ["MINIMAL_AGENT_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"]

/**
 * First non-empty GitHub token in `env` (see {@link GITHUB_TOKEN_ENV_VARS}),
 * or undefined. Env only: no `gh auth token`, no keychain, no subprocess.
 */
export function githubTokenFromEnv(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  for (const k of GITHUB_TOKEN_ENV_VARS) {
    const v = env[k]?.trim()
    if (v) return v
  }
  return undefined
}

/** Thrown when the latest obscura release cannot be resolved for this host. */
export class ResolveObscuraError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ResolveObscuraError"
  }
}

const HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "ma-fetch/resolve-obscura",
  "X-GitHub-Api-Version": "2022-11-28",
} as const

/** Target slug for a Node platform key, or undefined if unsupported. */
export function targetForPlatform(platformKey: string): string | undefined {
  return PLATFORM_TO_TARGET[platformKey]
}

/** Immutable per-build tag for an epoch. */
export function buildTagFor(epoch: string): string {
  return `build-${epoch}`
}

/** Public, anonymous download URL for a resolved build. */
export function obscuraDownloadUrl(
  build: Pick<ResolvedObscuraBuild, "tag" | "asset">,
  repo: string = OBSCURA_REPO,
): string {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(build.tag)}/${encodeURIComponent(build.asset)}`
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

/** Human-readable reason for a failed GitHub API response. */
function apiFailure(res: Response, repo: string, what: string, hadToken: boolean): string {
  const limited =
    (res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0"
  if (limited) {
    return (
      `GitHub API rate limit reached for ${repo} ${what}` +
      (hadToken ? "" : " (set GITHUB_TOKEN or MINIMAL_AGENT_GITHUB_TOKEN to raise it)")
    )
  }
  return `GitHub API ${res.status} for ${repo} ${what}`
}

/**
 * Load a release: try the rolling `latest` tag first, then GitHub's
 * `/releases/latest` pointer. Sends `token` when given, and retries a 401
 * (bad or expired token) once anonymously, since the repo is public.
 */
export async function fetchObscuraRelease(
  opts: Pick<ResolveObscuraOptions, "repo" | "fetch" | "preferTag" | "token"> = {},
): Promise<ObscuraRelease> {
  const repo = opts.repo ?? OBSCURA_REPO
  const fetchImpl = opts.fetch ?? globalThis.fetch
  const prefer = opts.preferTag ?? OBSCURA_ROLLING_TAG
  const base = `https://api.github.com/repos/${repo}/releases`
  let token = opts.token
  const get = async (url: string): Promise<Response> => {
    const headers: Record<string, string> = { ...HEADERS }
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await fetchImpl(url, { headers })
    if (res.status === 401 && token) {
      token = undefined
      return await fetchImpl(url, { headers: { ...HEADERS } })
    }
    return res
  }

  if (prefer) {
    const res = await get(`${base}/tags/${encodeURIComponent(prefer)}`)
    if (res.ok) return (await res.json()) as ObscuraRelease
    if (res.status !== 404) {
      throw new ResolveObscuraError(apiFailure(res, repo, `tag ${prefer}`, !!token))
    }
  }

  const res = await get(`${base}/latest`)
  if (!res.ok) {
    throw new ResolveObscuraError(apiFailure(res, repo, "/releases/latest", !!token))
  }
  return (await res.json()) as ObscuraRelease
}

/** `sha256:<hex>` digest field to bare lowercase hex, else undefined. */
function hexFromDigest(digest: string | null | undefined): string | undefined {
  const m = digest?.match(/^sha256:([0-9a-f]{64})$/i)
  return m ? m[1]!.toLowerCase() : undefined
}

/**
 * sha256 for an archive: GitHub's asset digest first (no extra request), else
 * the `<asset>.sha256` sidecar from the public CDN. Never hashes the archive
 * itself, setup must stay cheap.
 */
export async function sha256ForAsset(
  repo: string,
  tag: string,
  asset: ObscuraReleaseAsset,
  assets: ObscuraReleaseAsset[],
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<string> {
  const fromDigest = hexFromDigest(asset.digest)
  if (fromDigest) return fromDigest

  const sidecar = assets.find((a) => a.name === `${asset.name}.sha256`)
  if (!sidecar) {
    throw new ResolveObscuraError(`no sha256 published for ${asset.name} in ${repo}@${tag}`)
  }
  const url = sidecar.browser_download_url ?? obscuraDownloadUrl({ tag, asset: sidecar.name }, repo)
  const res = await fetchImpl(url, {
    headers: { "User-Agent": HEADERS["User-Agent"] },
    redirect: "follow",
  })
  if (!res.ok) throw new ResolveObscuraError(`sha256 sidecar fetch ${res.status} for ${url}`)
  const hex = (await res.text()).trim().split(/\s+/)[0]
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) {
    throw new ResolveObscuraError(`malformed sha256 sidecar for ${asset.name}`)
  }
  return hex.toLowerCase()
}

/**
 * Resolve the current obscura build for this (or an overridden) platform.
 * Throws {@link ResolveObscuraError} when the platform is unsupported, the
 * release has no matching asset or checksum, or GitHub fails.
 */
export async function resolveObscuraBuild(
  opts: ResolveObscuraOptions = {},
): Promise<ResolvedObscuraBuild> {
  const platform = opts.platformKey ?? `${process.platform}-${process.arch}`
  const target = targetForPlatform(platform)
  if (!target) {
    throw new ResolveObscuraError(`unsupported platform ${platform}`)
  }

  const repo = opts.repo ?? OBSCURA_REPO
  const fetchImpl = opts.fetch ?? globalThis.fetch
  const release = await fetchObscuraRelease({
    repo,
    fetch: fetchImpl,
    preferTag: opts.preferTag,
    token: opts.token,
  })
  const picked = pickAssetForTarget(release.assets, target)
  if (!picked) {
    throw new ResolveObscuraError(
      `no obscura asset for ${platform} (${target}) in ${repo}@${release.tag_name}`,
    )
  }

  const sha256 = await sha256ForAsset(
    repo,
    release.tag_name,
    picked.asset,
    release.assets,
    fetchImpl,
  )
  return {
    version: picked.epoch,
    // Pin to the immutable per-build tag. The rolling `latest` release prunes
    // superseded assets, so a cached `latest/<old asset>` URL would 404.
    tag: buildTagFor(picked.epoch),
    asset: picked.asset.name,
    sha256,
    platform,
  }
}
