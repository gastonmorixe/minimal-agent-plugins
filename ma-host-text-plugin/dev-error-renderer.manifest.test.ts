import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { createErrorRendererRegistry } from "@minimal-agent/core/errors"
import { getDiagnosticBus, type LogEvent } from "@minimal-agent/core/host/diagnostics"
import { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"

const PLUGINS_ROOT = join(import.meta.dir, "..")

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
    const noContrib = events.filter((e) => e.message.includes("no contributions"))
    expect(noContrib).toEqual([])
    expect(events.filter((e) => e.source.startsWith("error_renderer."))).toEqual([])
    expect(registry.render({ kind: "K", fields: { a: 1 } })).toBe('K {"a":1}')
  })
})
