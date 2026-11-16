import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { getDiagnosticBus, type LogEvent } from "@minimal-agent/core/host/diagnostics"
import { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"

import { createTurnRecoveryProvider } from "./provider.ts"

const PLUGINS_ROOT = join(import.meta.dir, "..")
const PLUGIN_ID = "turn-recovery"

describe("turn-recovery manifest", () => {
  test("loads through the plugin loader and exposes one provider", async () => {
    const events: LogEvent[] = []
    const off = getDiagnosticBus().on("*", (e) => events.push(e))
    const loader = await PluginLoader.load({
      roots: { embedded: [PLUGINS_ROOT], user: [], project: [] },
      enabledPluginIds: new Set([PLUGIN_ID]),
    })
    off()
    const own = events.filter(
      (e) => e.message.includes(`plugin "${PLUGIN_ID}"`) && e.message.includes("no contributions"),
    )
    expect(own).toEqual([])
    expect(events.filter((e) => e.source.startsWith("synthetic_text."))).toEqual([])
    // Other required plugins (with their own providers) load too: pick ours by kind.
    const providers = loader
      .syntheticTextProviders()
      .filter((p) => p.kinds.includes("continue.max_tokens"))
    expect(providers).toHaveLength(1)
    const kinds: string[] = [...(providers[0]?.kinds ?? [])].sort()
    expect(kinds).toEqual([...createTurnRecoveryProvider().kinds].sort())
    expect(kinds).toHaveLength(19)
    expect(providers[0]?.text("tool_result.handler_error", { detail: "boom" })).toBe(
      "Handler error: boom",
    )
  })
})
