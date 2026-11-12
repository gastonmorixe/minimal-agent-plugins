import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { createErrorRendererRegistry } from "@minimal-agent/core/errors"
import { getDiagnosticBus, type LogEvent } from "@minimal-agent/core/host/diagnostics"
import { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"

const PLUGINS_ROOT = join(import.meta.dir, "..")

const PLUGIN_ID = "ma-host-text-plugin"

/** Keep only "no contributions" events that name THIS plugin (siblings may warn). */
function ownNoContribEvents(events: readonly LogEvent[]): LogEvent[] {
  return events.filter(
    (e) => e.message.includes(`plugin "${PLUGIN_ID}"`) && e.message.includes("no contributions"),
  )
}

describe("ownNoContribEvents filter", () => {
  test("ignores sibling plugin warnings and keeps this plugin's", () => {
    const mk = (id: string): LogEvent =>
      ({
        source: "plugin_loader",
        message: `dir: plugin "${id}" declares no contributions (x) and ships no PROMPT.md; it will load but do nothing`,
      }) as unknown as LogEvent
    const sibling = mk("ma-sideband-plugin")
    const own = mk(PLUGIN_ID)
    expect(ownNoContribEvents([sibling, own])).toEqual([own])
    expect(ownNoContribEvents([sibling])).toEqual([])
  })
})

describe("ma-host-text-plugin manifest", () => {
  test("loads through the plugin loader and registers the dev renderer", async () => {
    const registry = createErrorRendererRegistry()
    const events: LogEvent[] = []
    const off = getDiagnosticBus().on("*", (e) => events.push(e))
    await PluginLoader.load({
      roots: { embedded: [PLUGINS_ROOT], user: [], project: [] },
      errorRendererRegistry: registry,
      enabledPluginIds: new Set(["ma-host-text-plugin"]),
    })
    off()
    expect(ownNoContribEvents(events)).toEqual([])
    // Unfiltered: only this plugin is enabled and the registry is fresh, so no sibling emits error_renderer.* events.
    expect(events.filter((e) => e.source.startsWith("error_renderer."))).toEqual([])
    expect(registry.render({ kind: "K", fields: { a: 1 } })).toBe('K {"a":1}')
  })
})
