/**
 * Plugin setup hook for ma-fetch.
 *
 * Declares the `obscura` render-engine binary the Fetch tool needs, so the host
 * can provision it into the managed `~/.minimal-agent/bin/` on a fresh box (and
 * update it when a newer build is pinned). The plugin returns a descriptor as
 * DATA; the agent does the download / verify / install / audit with TUI
 * progress. The plugin NEVER touches the filesystem.
 *
 * ## Private binaries, account-less install
 *
 * obscura's SOURCE is private. We do NOT publish a public download URL. Instead
 * the compiled binaries live in a PRIVATE release repo (`obscura-dist`), and
 * this plugin ships an EMBEDDED read-only credential (a fine-grained PAT scoped
 * to only that repo, Contents: read-only). The host fetches the release asset
 * via the GitHub REST API using that embedded token, so ANY copy of the plugin
 * can install obscura, including a friend with no GitHub account of their own,
 * because the credential travels with the plugin, not with the user.
 *
 * The hardcoded coordinates (`repo` / `tag` / `asset` / `sha256` / `version`)
 * never expire: the real download URL is a short-lived signed URL minted fresh
 * by GitHub on each install and consumed immediately. Never stored here.
 *
 * Security posture of the embedded token: read-only, single-repo, and it only
 * grants pulling the (already-distributed) obscura binaries. A leak exposes
 * nothing else. Rotate by bumping the plugin release. The token is read from a
 * sibling `obscura-token.ts` (gitignored; CI writes the real value at release
 * time) so the secret is not committed to the plugin's source tree.
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
 * `MA_FETCH_BIN`). Local dev against `~/Projects/obscura` keeps working.
 *
 * @module setup
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

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

/** The PRIVATE repo holding compiled obscura binaries. */
const OBSCURA_REPO = "gastonmorixe/obscura-dist"

/**
 * The pinned build this ma-fetch release ships. `tag` + per-asset `sha256` +
 * `version` are filled by obscura CI's release step (it knows the epoch +
 * digests). `version` is the build epoch. Bumping it on the next plugin
 * release makes the host classify an older installed copy as `outdated` and
 * update it.
 */
const OBSCURA_VERSION = "1780598942"
const OBSCURA_TAG = "build-1780598942"

interface PlatformBuild {
  asset: string
  sha256: string
}

/** key = `${process.platform}-${process.arch}`. */
const OBSCURA_BUILDS: Record<string, PlatformBuild> = {
  "darwin-arm64": {
    asset: "obscura-aarch64-macos-1780598942.tar.gz",
    sha256: "e61a8217332d944c6aeb360caf5bbeb4d469d8f5c19aae4444fca1dd0f2ab4d7",
  },
  "linux-arm64": {
    asset: "obscura-aarch64-linux-1780598942.tar.gz",
    sha256: "61f02acc9dfcc22d9114aa78044a5efca28e50f5b20eaafe93a1ad4bd8f9287f",
  },
  // Filled as obscura CI publishes each target. Until a real sha is present the
  // install fails the sha256 check (fails closed: never installs a wrong file).
  "darwin-x64": { asset: "obscura-x86_64-macos-1780598942.tar.gz", sha256: "" },
  "linux-x64": { asset: "obscura-x86_64-linux-1780598942.tar.gz", sha256: "" },
}

/** Read `plugins["ma-fetch"].obscura.bin` from user config, if set. Lenient. */
function configuredObscuraBin(): string | undefined {
  const cfgPath =
    process.env.MINIMAL_AGENT_CONFIG ?? join(homedir(), ".minimal-agent", "config.jsonc")
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

const setup = (ctx: SetupContext): SetupResult => {
  // 1. Operator override → skip provisioning.
  const override = configuredObscuraBin()
  if (override) {
    ctx.log.notice("ma-fetch.setup", "obscura bin overridden in config; skipping provisioning", {
      bin: override,
    })
    return {}
  }

  // 2. Pick the build for this platform.
  const key = `${process.platform}-${process.arch}`
  const build = OBSCURA_BUILDS[key]
  if (!build || build.sha256.length === 0) {
    ctx.log.notice(
      "ma-fetch.setup",
      `no published obscura build for ${key}; set plugins["ma-fetch"].obscura.bin to use Fetch`,
      { platform: key },
    )
    return {}
  }

  // 3. Declare the requirement: a PRIVATE release asset fetched with the
  //    embedded read-only token. `obscura-worker` rides along as a sibling.
  const spec: SetupBinarySpec = {
    name: "obscura",
    version: OBSCURA_VERSION,
    source: {
      kind: "github-release",
      repo: OBSCURA_REPO,
      tag: OBSCURA_TAG,
      asset: build.asset,
      // Embedded so an account-less copy can still pull. Empty string ⇒ fall
      // back to the host's own token resolver (a dev machine logged into gh).
      ...(OBSCURA_DIST_TOKEN ? { token: OBSCURA_DIST_TOKEN } : {}),
    },
    sha256: build.sha256,
    archiveMember: "obscura",
    archiveExtraMembers: ["obscura-worker"],
  }

  return {
    requireBinaries: [spec],
    haltIfMissing: ["obscura"],
    haltMessage:
      "The Fetch tool needs the obscura render engine, which could not be installed " +
      "(offline, or no published build for this platform).\n" +
      'Fix: connect to the network and re-run, or set plugins["ma-fetch"].obscura.bin ' +
      "in ~/.minimal-agent/config.jsonc to a local obscura build.\n" +
      'Or disable Fetch: plugins["ma-fetch"].enabled = false.',
  }
}

export default setup
