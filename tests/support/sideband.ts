/**
 * Test helper: the real sideband API of this checkout. It boots the core
 * registry over all `ma-*` manifests with the public `loadSidebandOnly`
 * (the same boot path as a reader with no loader), so the real codec
 * (`ma-sideband-plugin`) and the real kind declarations render the tags.
 * Tests only. A provider test gives it as the third argument of
 * `text(kind, facts, sb)`.
 *
 * @module tests/support/sideband
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { loadSidebandOnly, type SidebandApi } from "@minimal-agent/core/host/sideband"

const PLUGINS = resolve(import.meta.dir, "../..")
const NO_DIR = join(PLUGINS, "tmp", "sideband-fixture-no-dir")

/** The ids of all `ma-*` plugins (a plugin that is off by default still declares kinds). */
function pluginIds(): Set<string> {
  const ids = new Set<string>()
  for (const dir of readdirSync(PLUGINS)) {
    const path = join(PLUGINS, dir, "manifest.json")
    if (!dir.startsWith("ma-") || !existsSync(path)) continue
    ids.add((JSON.parse(readFileSync(path, "utf8")) as { id: string }).id)
  }
  return ids
}

const noop = (): void => {}

let cached: Promise<SidebandApi> | undefined

/** The sideband API with the real codec and the manifest kinds. Built one time. */
export function pluginSideband(): Promise<SidebandApi> {
  cached ??= loadSidebandOnly({
    roots: { embedded: [PLUGINS], user: [NO_DIR], project: [NO_DIR] },
    enabledPluginIds: pluginIds(),
    diagnostics: {
      sessionId: undefined,
      emit: noop,
      emergency: noop,
      alert: noop,
      critical: noop,
      error: noop,
      warn: noop,
      notice: noop,
      info: noop,
      debug: noop,
    },
  })
  return cached
}
