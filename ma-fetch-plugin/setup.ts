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
 * ## Public binaries, no credentials
 *
 * Compiled binaries are published to the PUBLIC `gastonmorixe/obscura` repo's
 * Releases by its Dist Release workflow. At setup we resolve the rolling
 * `latest` release anonymously through the GitHub API (no hardcoded build
 * epoch in source), pin the asset to its immutable `build-<epoch>` tag, and
 * hand the host a plain public download URL plus the published sha256. No
 * token is embedded, read from env, or borrowed from `gh`.
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
  obscuraDownloadUrl,
  type ResolvedObscuraBuild,
  ResolveObscuraError,
  resolveObscuraBuild,
} from "./lib/resolve-obscura-release.ts"

// Structural copies of the host's setup types so this file type-checks
// standalone (the plugin carries no dependency on the agent source tree).
type SetupBinarySource = { kind: "url"; url: string; archive?: boolean }
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
function setupResultFor(build: ResolvedObscuraBuild, haltIfMissing: boolean): SetupResult {
  const spec: SetupBinarySpec = {
    name: "obscura",
    version: build.version,
    source: { kind: "url", url: obscuraDownloadUrl(build), archive: true },
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
function refreshCachedBuild(cachePath: string, platform: string, log: SetupContext["log"]): void {
  if (refreshInFlight) return
  refreshInFlight = (async () => {
    const build = await resolveObscuraBuild({ platformKey: platform })
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
    refreshCachedBuild(cachePath, platform, ctx.log)
    // The current process can use the last verified coordinates immediately;
    // a future boot observes the completed refresh.
    return setupResultFor(cached, !hasInstalledObscura)
  }

  // 3. No usable cache means Fetch cannot operate yet, so this first install
  // intentionally resolves synchronously and allows the host to provision it.
  let build: ResolvedObscuraBuild
  try {
    build = await resolveObscuraBuild({
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
  return setupResultFor(build, true)
}

export default setup
