/**
 * Tests for the embedded-aware plugin discovery wiring.
 *
 * The bug this guards: in a compiled binary every first-party package lives
 * in the generated embed table, not on disk. Core creates an EMPTY
 * `<cacheRoot>/<buildId>/<name>` directory and keeps `manifest.json` in
 * memory, so a filesystem-only scan of the parent root finds no manifest and
 * `/config` showed zero plugin toggles in the binary.
 *
 * @module config/handlers/wiring.test
 */

import { describe, expect, it } from "bun:test"

import { type DiscoverDeps, discoverPlugins } from "../lib/discovery.ts"

import { embeddedAwareDiscoverDeps, realDiscoverDeps } from "./wiring.ts"

const EMBEDDED_CACHE_ROOT = "/home/u/.minimal-agent/cache/embedded"
const EMBEDDED_ROOT = `${EMBEDDED_CACHE_ROOT}/build-1`

/** The cache dir core computes for an embedded package. */
function embeddedDir(name: string): string {
  return `${EMBEDDED_ROOT}/${name}`
}

/**
 * Install a fake embedded table for the duration of `fn`.
 *
 * `embeddedAwareDiscoverDeps` calls the real `embeddedPluginPackages()`, which
 * reads module-level registration state. The test registers through the real
 * setter so the production path is exercised: the manifest body lives in the
 * table's `texts`, exactly as the generated CLI table carries it.
 */
async function withEmbeddedPackages(
  packages: { name: string; manifest: Record<string, unknown> }[],
  fn: (deps: DiscoverDeps) => void,
): Promise<void> {
  const { registerEmbeddedPlugins, clearEmbeddedPlugins, pruneEmbeddedCache } = await import(
    "@minimal-agent/core/host-kit/embedded-plugins"
  )
  const table = {
    buildId: "build-1",
    packages: Object.fromEntries(
      packages.map((p) => [
        p.name,
        { texts: { "manifest.json": JSON.stringify(p.manifest) }, modules: {}, files: {} },
      ]),
    ),
  }
  registerEmbeddedPlugins(table as any, { cacheRoot: EMBEDDED_CACHE_ROOT })
  try {
    fn(embeddedAwareDiscoverDeps(["/proj/.agents/minimal-agent/plugins"]))
  } finally {
    pruneEmbeddedCache()
    clearEmbeddedPlugins()
  }
}

describe("embeddedAwareDiscoverDeps", () => {
  it("falls back to plain disk discovery when no table is registered", () => {
    const deps = embeddedAwareDiscoverDeps(["/proj/.agents/minimal-agent/plugins"])
    expect(deps.roots).toEqual(["/proj/.agents/minimal-agent/plugins"])
  })

  it("returns real fs deps unchanged when nothing is embedded", () => {
    const disk = realDiscoverDeps(["/proj/.agents/minimal-agent/plugins"])
    const aware = embeddedAwareDiscoverDeps(["/proj/.agents/minimal-agent/plugins"])
    expect(aware.roots).toEqual(disk.roots)
    expect(aware.readFile("/nope/manifest.json")).toBeNull()
    expect(aware.readDir("/nope")).toEqual([])
  })

  it("honors the discovery opt-out even when a table is registered", async () => {
    const manifest = { id: "alpha", name: "Alpha" }
    await withEmbeddedPackages([{ name: "ma-alpha-plugin", manifest }], () => {
      // `MINIMAL_AGENT_CONFIG_SKIP_PLUGIN_DISCOVERY=1` makes discoveryRoots
      // return [], so no embedded root may be added back.
      const deps = embeddedAwareDiscoverDeps([])
      expect(deps.roots).toEqual([])
      expect(discoverPlugins(deps)).toEqual([])
    })
  })

  it("finds an embedded plugin whose cache dir holds no manifest file", async () => {
    const manifest = {
      id: "alpha",
      name: "Alpha",
      description: "Embedded plugin. Second sentence.",
    }
    await withEmbeddedPackages([{ name: "ma-alpha-plugin", manifest }], (deps) => {
      const dir = embeddedDir("ma-alpha-plugin")
      // The shared build dir is the extra root; each package is one entry.
      expect(deps.roots).toContain(EMBEDDED_ROOT)
      expect(deps.readDir(EMBEDDED_ROOT)).toEqual(["ma-alpha-plugin"])
      expect(deps.readFile(`${dir}/manifest.json`)).toContain('"alpha"')

      const found = discoverPlugins(deps)
      expect(found.map((p) => p.id)).toEqual(["alpha"])
      expect(found[0]?.name).toBe("Alpha")
      expect(found[0]?.manifestDisabled).toBe(false)
    })
  })

  it("keeps disk precedence over an embedded package with the same id", async () => {
    const manifest = { id: "alpha", name: "Embedded Alpha", description: "Embedded copy." }
    await withEmbeddedPackages([{ name: "ma-alpha-plugin", manifest }], (deps) => {
      const projectRoot = "/proj/.agents/minimal-agent/plugins"
      const diskFile = `${projectRoot}/ma-alpha-plugin/manifest.json`
      const withDisk: DiscoverDeps = {
        ...deps,
        readDir: (path: string) =>
          path === projectRoot ? ["ma-alpha-plugin"] : deps.readDir(path),
        readFile: (path: string) =>
          path === diskFile
            ? JSON.stringify({ id: "alpha", name: "Disk Alpha", description: "Disk copy." })
            : deps.readFile(path),
      }

      const found = discoverPlugins(withDisk)
      expect(found.map((p) => p.id)).toEqual(["alpha"])
      expect(found[0]?.name).toBe("Disk Alpha")
    })
  })

  it("surfaces several embedded packages at once", async () => {
    const packages = [
      { name: "ma-alpha-plugin", manifest: { id: "alpha", name: "Alpha" } },
      { name: "ma-beta-plugin", manifest: { id: "beta", name: "Beta", enabled: false } },
    ]
    await withEmbeddedPackages(packages, (deps) => {
      const found = discoverPlugins(deps)
      expect(found.map((p) => p.id)).toEqual(["alpha", "beta"])
      expect(found.find((p) => p.id === "beta")?.manifestDisabled).toBe(true)
    })
  })
})
