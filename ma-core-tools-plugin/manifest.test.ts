import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { getDiagnosticBus, type LogEvent } from "@minimal-agent/core/host/diagnostics"
import { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"
import { SYNTHETIC_KINDS } from "@minimal-agent/core/plugin-api/types/synthetic-text"

import { createCoreToolsSyntheticProvider } from "./synthetic-text.ts"
import { createCoreToolTextProvider } from "./tool-text.ts"

const PLUGINS_ROOT = join(import.meta.dir, "..")
const PLUGIN_ID = "ma-core-tools-plugin"

interface Manifest {
  id: string
  required?: boolean
  toolText: Array<{ tools: string[] }>
  syntheticText: Array<{ kinds: string[] }>
}

const manifest = JSON.parse(
  readFileSync(join(import.meta.dir, "manifest.json"), "utf8"),
) as Manifest

describe("ma-core-tools-plugin manifest", () => {
  test("id and required", () => {
    expect(manifest.id).toBe(PLUGIN_ID)
    expect(manifest.required).toBe(true)
  })

  test("provider.tools equals the manifest tools list", () => {
    expect(manifest.toolText).toHaveLength(1)
    expect([...createCoreToolTextProvider().tools]).toEqual(manifest.toolText[0]?.tools ?? [])
  })

  test("provider.kinds equals the manifest kinds list", () => {
    expect(manifest.syntheticText).toHaveLength(1)
    expect<string[]>([...createCoreToolsSyntheticProvider().kinds]).toEqual(
      manifest.syntheticText[0]?.kinds ?? [],
    )
  })

  test("kinds are every tool_text.*, tool_output.{preview,truncated,streak} and mode.* kind", () => {
    const want: string[] = SYNTHETIC_KINDS.filter(
      (k) =>
        k.startsWith("tool_text.") ||
        k.startsWith("mode.") ||
        k === "tool_output.preview" ||
        k === "tool_output.truncated" ||
        k === "tool_output.streak",
    )
    expect(want.filter((k) => k.startsWith("tool_text."))).toHaveLength(30)
    expect<string[]>([...createCoreToolsSyntheticProvider().kinds].sort()).toEqual(want.sort())
  })

  test("loads through the plugin loader with no mismatch diagnostic", async () => {
    const events: LogEvent[] = []
    const off = getDiagnosticBus().on("*", (e) => events.push(e))
    const loader = await PluginLoader.load({
      roots: { embedded: [PLUGINS_ROOT], user: [], project: [] },
      enabledPluginIds: new Set([PLUGIN_ID]),
    })
    off()
    expect(
      events.filter(
        (e) => e.source.startsWith("synthetic_text.") || e.source.startsWith("tool_text."),
      ),
    ).toEqual([])
    const providers = loader.syntheticTextProviders()
    const own = providers.find((p) => p.kinds.includes("mode.change"))
    expect(own?.text("mode.change", { from: "default", to: "ask", at: "T" })).toBe(
      '<ma::agent::mode-change from="default" to="ask" at="T" />',
    )
  })
})
