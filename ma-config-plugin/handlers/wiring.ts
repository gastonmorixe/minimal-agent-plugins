/**
 * Host wiring — the only place that touches `node:fs` / `node:path` and the
 * agent's environment. Bridges the pure `lib/` core to real disk + the
 * resolved config path + plugin discovery roots, so `lib/` stays host-free.
 *
 * @module config/handlers/wiring
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import {
  embeddedPluginPackages,
  type PluginPackage,
} from "@minimal-agent/core/host-kit/embedded-plugins"
import { resolveAgentHome } from "@minimal-agent/core/plugin-api/utils/agent-paths"

import type { DiscoverDeps } from "../lib/discovery.ts"
import type { FsDeps } from "../lib/model.ts"

/**
 * Resolve the config path with the SAME precedence as `src/config.ts`:
 * `MINIMAL_AGENT_CONFIG` override, else `~/.minimal-agent/config.jsonc`
 * (preferred when it exists), else `~/.minimal-agent/config.json`.
 *
 * `env` is the plugin-scoped env (handlers pass `ctx.env`); falls back to
 * `process.env` for the home dir.
 */
export function resolveConfigPath(
  env: Record<string, string> = process.env as Record<string, string>,
): string {
  const override = env.MINIMAL_AGENT_CONFIG
  if (override) return override
  const dir = resolveAgentHome(env)
  const jsonc = join(dir, "config.jsonc")
  if (existsSync(jsonc)) return jsonc
  // Prefer writing the documented `.jsonc` form for a fresh file even though
  // the legacy reader also accepts `.json`.
  const legacy = join(dir, "config.json")
  if (existsSync(legacy)) return legacy
  return jsonc
}

/** Build {@link FsDeps} bound to the real config file. */
export function realFsDeps(path: string): FsDeps {
  return {
    path,
    read: () => {
      try {
        return readFileSync(path, "utf8")
      } catch {
        return null
      }
    },
    write: (text: string) => {
      writeFileSync(path, text, "utf8")
    },
  }
}

/**
 * The plugin discovery roots, mirroring the loader's scan order (project,
 * then this plugin's own root). `packageDir` is this plugin's own dir, so its
 * parent is the first-party root that the host loaded: the dev checkout in
 * dev mode, the user clone in install mode.
 *
 * Order matters: first-seen id wins in `discoverPlugins`, matching the
 * loader's project-first precedence. There is no home tier.
 */
export function discoveryRoots(
  packageDir: string,
  cwd: string,
  env: Record<string, string> = process.env as Record<string, string>,
): string[] {
  // Opt-out: `MINIMAL_AGENT_CONFIG_SKIP_PLUGIN_DISCOVERY=1` returns no roots, so
  // the overlay shows only the static schema (no per-plugin enable toggles).
  // Used by the integration test to keep the field list deterministic (it can't
  // redirect the embedded root, which is this plugin's own parent dir — in a
  // repo checkout that parent is the plugins repo root, full of `ma-*-plugin`s).
  if (env.MINIMAL_AGENT_CONFIG_SKIP_PLUGIN_DISCOVERY === "1") return []
  const ownRoot = dirname(packageDir) // the checkout or the user clone
  return [
    join(cwd, ".agents", "minimal-agent", "plugins"), // project
    ownRoot,
  ]
}

/** Build {@link DiscoverDeps} wired to real fs. */
export function realDiscoverDeps(roots: string[]): DiscoverDeps {
  return {
    roots,
    join: (...parts: string[]) => join(...parts),
    readDir: (path: string) => {
      try {
        return readdirSync(path)
      } catch {
        return []
      }
    },
    readFile: (path: string) => {
      try {
        return readFileSync(path, "utf8")
      } catch {
        return null
      }
    },
  }
}

/**
 * Discovery deps that also see plugins EMBEDDED in a compiled binary.
 *
 * In a binary every first-party package lives in the generated table, not on
 * disk: core creates an empty `cache/embedded/<buildId>/<name>` dir and keeps
 * the manifest in memory, so scanning the parent root finds no
 * `manifest.json` and `/config` would show no plugin toggles at all.
 *
 * `discoverPlugins` treats every root as the PARENT of package dirs, so this
 * adds the shared build dir (`cache/embedded/<buildId>`) as one extra root and
 * serves its directory listing plus each `manifest.json` from the table. That
 * keeps the existing root-based precedence working: disk roots are scanned
 * first, so a project or user copy of an id wins, exactly as the loader does.
 */
export function embeddedAwareDiscoverDeps(roots: string[]): DiscoverDeps {
  const base = realDiscoverDeps(roots)
  // No roots means discovery was explicitly opted out
  // (`MINIMAL_AGENT_CONFIG_SKIP_PLUGIN_DISCOVERY=1`): honor it, do not smuggle
  // the embedded table back in.
  if (roots.length === 0) return base
  let packages: readonly PluginPackage[] = []
  try {
    packages = embeddedPluginPackages()
  } catch {
    // A source run registers no table. A failure here must never break
    // discovery for the disk roots.
    packages = []
  }
  if (packages.length === 0) return base

  const byDir = new Map(packages.map((pkg) => [pkg.dir, pkg]))
  // Every embedded package dir is `<buildRoot>/<name>`, so one shared parent.
  const buildRoot = dirname(packages[0]?.dir ?? "")
  const names = packages.map((pkg) => {
    const parts = pkg.dir.split(/[/\\]/)
    return parts[parts.length - 1] ?? pkg.name
  })

  return {
    ...base,
    roots: [...roots, buildRoot],
    readDir: (path: string) => {
      if (path === buildRoot) return [...names]
      return base.readDir(path)
    },
    readFile: (path: string) => {
      const fromDisk = base.readFile(path)
      if (fromDisk !== null) return fromDisk
      const pkg = byDir.get(dirname(path))
      if (pkg !== undefined && path.endsWith("manifest.json")) {
        return pkg.readText("manifest.json")
      }
      return null
    },
  }
}
