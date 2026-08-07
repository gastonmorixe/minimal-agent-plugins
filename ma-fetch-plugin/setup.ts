/**
 * Plugin setup hook for ma-fetch.
 *
 * Declares the `obscura` render-engine binary the Fetch tool needs, so the host
 * can provision it into the managed `~/.minimal-agent/bin/` on a fresh box (and
 * update it when a newer build is published). The plugin returns a descriptor as
 * DATA; the agent does the download / verify / install / audit with TUI
 * progress. The plugin only maintains a small, non-secret release-coordinate
 * cache; it never touches managed binary files or the host binary manifest.
 *
 * ## Private binaries, account-less install
 *
 * obscura's SOURCE is private. Compiled binaries live in a PRIVATE release repo
 * (`obscura-dist`). This plugin ships an EMBEDDED read-only credential (a
 * fine-grained PAT scoped to only that repo, Contents: read-only). At setup we
 * resolve the rolling `latest` release via the GitHub API (no hardcoded build
 * epoch in source), then ask the host to fetch that asset with the same token.
 *
 * Security posture of the embedded token: read-only, single-repo, and it only
 * grants pulling the (already-distributed) obscura binaries. A leak exposes
 * nothing else. Rotate by bumping the plugin release. The token is read from a
 * sibling `obscura-token.ts`.
 *
 * ## How the backend finds the binary at runtime
 *
 * This setup hook only DECLARES + installs the binary into the agent-managed
 * dir. At call time the dispatcher (`lib/backend.ts:resolveBackendBin`) finds
 * it again, fail-closed, with no `PATH` fallback:
 *
 *   1. Operator override `plugins["ma-fetch"].obscura.bin` (absolute path) wins.
 *   2. Else `<MINIMAL_AGENT_BIN_DIR>/obscura`, where `MINIMAL_AGENT_BIN_DIR` is
 *      advertised by the host every session and points at the same managed dir
 *      this hook installs into (`~/.minimal-agent/bin`). The plugin learns the
 *      location ONLY from that env var; it never hard-codes a home path.
 *   3. Neither → the tool reports `engine-unavailable`. We never run a bare
 *      `obscura` off the user's `PATH`.
 *
 * ## Operator override
 *
 * If the user sets `plugins["ma-fetch"].obscura.bin` to their own obscura
 * build, provisioning is skipped (their path wins; the backend reads
 * `MA_FETCH_BIN`). Local dev against a local obscura checkout keeps working.
 *
 * @module setup
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import {
  isCachedObscuraReleaseFresh,
  obscuraReleaseCachePath,
  readCachedObscuraRelease,
  writeCachedObscuraRelease,
} from "./lib/obscura-release-cache.ts"
import { agentHome } from "./lib/paths.ts"
import {
  OBSCURA_DIST_REPO,
  type ResolvedObscuraBuild,
  ResolveObscuraError,
  resolveObscuraBuild,
} from "./lib/resolve-obscura-release.ts"
import { OBSCURA_DIST_TOKEN } from "./obscura-token.ts"

// Structural copies of the host's setup types so this file type-checks
// standalone (the plugin carries no dependency on the agent source tree).
type SetupBinarySource =
  | { kind: "url"; url: string; archive?: boolean }
  | {
      kind: "github-release"
      repo: string
      tag: string
      asset: string
      token?: string
      archive?: boolean
    }
interface SetupBinarySpec {
  name: string
  version: string
  source: SetupBinarySource
  sha256: string
  archiveMember?: string
  archiveExtraMembers?: string[]
}
interface SetupContext {
  packageDir: string
  cwd: string
  env: Record<string, string>
  abort?: AbortSignal
  binaries: {
    readonly dir: string
    has(name: string): boolean
    get(name: string): { version: string | null } | undefined
    status(spec: SetupBinarySpec): "satisfied" | "missing" | "outdated" | "unknown-version"
  }
  log: {
    info(source: string, message: string, sd?: Record<string, string | number | boolean>): void
    notice(source: string, message: string, sd?: Record<string, string | number | boolean>): void
  }
}
interface SetupResult {
  requireBinaries?: SetupBinarySpec[]
  haltIfMissing?: string[]
  haltMessage?: string
}

/** One process shares an in-flight stale-cache refresh across setup calls. */
let refreshInFlight: Promise<void> | null = null

/** Build the binary-install descriptor returned to the host. */
function setupResultFor(
  build: ResolvedObscuraBuild,
  haltIfMissing: boolean,
  token?: string,
): SetupResult {
  const spec: SetupBinarySpec = {
    name: "obscura",
    version: build.version,
    source: {
      kind: "github-release",
      repo: OBSCURA_DIST_REPO,
      tag: build.tag,
      asset: build.asset,
      ...(OBSCURA_DIST_TOKEN ? { token: OBSCURA_DIST_TOKEN } : token ? { token } : {}),
    },
    sha256: build.sha256,
    archiveMember: "obscura",
    archiveExtraMembers: ["obscura-worker"],
  }
  return {
    requireBinaries: [spec],
    ...(haltIfMissing
      ? {
          haltIfMissing: ["obscura"],
          haltMessage:
            "The Fetch tool needs the obscura render engine, which could not be installed " +
            "(offline, or no published build for this platform).\n" +
            'Fix: connect to the network and re-run, or set plugins["ma-fetch"].obscura.bin ' +
            "in ~/.minimal-agent/config.jsonc to a local obscura build.\n" +
            'Or disable Fetch: plugins["ma-fetch"].enabled = false.',
        }
      : {}),
  }
}

/**
 * Refresh stale metadata in the background. The returned promise is retained
 * only to coalesce simultaneous setup calls; startup deliberately never awaits
 * it once a last-known-good record exists.
 */
function refreshCachedBuild(
  cachePath: string,
  platform: string,
  env: Record<string, string>,
  log: SetupContext["log"],
): void {
  if (refreshInFlight) return
  refreshInFlight = (async () => {
    const token = await resolveDistToken(env)
    if (!token) return
    const build = await resolveObscuraBuild({ token, platformKey: platform })
    writeCachedObscuraRelease(cachePath, build)
    log.info("ma-fetch.setup", "refreshed obscura latest release", {
      tag: build.tag,
      version: build.version,
      asset: build.asset,
      platform: build.platform,
    })
  })()
    .catch((e) => {
      log.notice("ma-fetch.setup", "could not refresh latest obscura; keeping cached release", {
        detail: e instanceof Error ? e.message : String(e),
        platform,
      })
    })
    .finally(() => {
      refreshInFlight = null
    })
}

/** Test-only reset for the module-level stale-refresh coalescer. */
export function resetObscuraReleaseRefreshForTest(): void {
  refreshInFlight = null
}

/** Read `plugins["ma-fetch"].obscura.bin` from user config, if set. Lenient. */
function configuredObscuraBin(): string | undefined {
  const cfgPath = process.env.MINIMAL_AGENT_CONFIG ?? join(agentHome(), "config.jsonc")
  try {
    if (!existsSync(cfgPath)) return undefined
    const raw = readFileSync(cfgPath, "utf8")
    const stripped = raw
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/,(\s*[}\]])/g, "$1")
    const cfg = JSON.parse(stripped) as {
      plugins?: { "ma-fetch"?: { obscura?: { bin?: unknown } } }
    }
    const bin = cfg.plugins?.["ma-fetch"]?.obscura?.bin
    return typeof bin === "string" && bin.trim().length > 0 ? bin.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * Token used to read obscura-dist. Prefer the embedded read-only PAT; fall back
 * to host/env/`gh` so a dev box without a baked token still works.
 */
async function resolveDistToken(env: Record<string, string>): Promise<string> {
  if (OBSCURA_DIST_TOKEN.trim()) return OBSCURA_DIST_TOKEN.trim()
  const fromEnv =
    env.MINIMAL_AGENT_GITHUB_TOKEN?.trim() ||
    env.GITHUB_TOKEN?.trim() ||
    env.GH_TOKEN?.trim() ||
    process.env.MINIMAL_AGENT_GITHUB_TOKEN?.trim() ||
    process.env.GITHUB_TOKEN?.trim() ||
    process.env.GH_TOKEN?.trim()
  if (fromEnv) return fromEnv
  try {
    const proc = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" })
    const out = (await new Response(proc.stdout).text()).trim()
    await proc.exited
    if (proc.exitCode === 0 && out.length > 0) return out
  } catch {
    // fall through
  }
  return ""
}

const setup = async (ctx: SetupContext): Promise<SetupResult> => {
  // 1. Operator override → skip provisioning.
  const override = configuredObscuraBin()
  if (override) {
    ctx.log.notice("ma-fetch.setup", "obscura bin overridden in config; skipping provisioning", {
      bin: override,
    })
    return {}
  }

  // 2. Reuse the last known release immediately. A stale entry triggers an
  // unawaited refresh so regular interactive boots never wait on GitHub.
  const platform = `${process.platform}-${process.arch}`
  const cachePath = obscuraReleaseCachePath(agentHome({ ...process.env, ...ctx.env }), platform)
  const cached = readCachedObscuraRelease(cachePath)
  const hasInstalledObscura = ctx.binaries.has("obscura")
  if (cached && cached.platform === platform) {
    if (isCachedObscuraReleaseFresh(cached)) {
      return setupResultFor(cached, !hasInstalledObscura)
    }
    refreshCachedBuild(cachePath, platform, ctx.env, ctx.log)
    // The current process can use the last verified coordinates immediately;
    // a future boot observes the completed refresh.
    return setupResultFor(cached, !hasInstalledObscura)
  }

  // 3. No usable cache means Fetch cannot operate yet, so this first install
  // intentionally resolves synchronously and allows the host to provision it.
  const token = await resolveDistToken(ctx.env)
  if (!token) {
    ctx.log.notice(
      "ma-fetch.setup",
      'no GitHub token available to resolve obscura-dist; set plugins["ma-fetch"].obscura.bin or embed OBSCURA_DIST_TOKEN',
      { platform },
    )
    return {}
  }

  let build: ResolvedObscuraBuild
  try {
    build = await resolveObscuraBuild({
      token,
      platformKey: platform,
      fetch: async (input, init) => {
        if (ctx.abort?.aborted) throw new ResolveObscuraError("setup aborted")
        return await fetch(input, { ...init, signal: ctx.abort })
      },
    })
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    if (ctx.binaries.has("obscura")) {
      ctx.log.notice(
        "ma-fetch.setup",
        `could not resolve latest obscura (${detail}); keeping installed copy`,
        { platform },
      )
      return {}
    }
    ctx.log.notice(
      "ma-fetch.setup",
      `could not resolve latest obscura for ${platform}: ${detail}`,
      { platform },
    )
    return {}
  }

  writeCachedObscuraRelease(cachePath, build)
  ctx.log.info("ma-fetch.setup", "resolved obscura latest release", {
    tag: build.tag,
    version: build.version,
    asset: build.asset,
    platform: build.platform,
  })
  return setupResultFor(build, true, token)
}

export default setup
