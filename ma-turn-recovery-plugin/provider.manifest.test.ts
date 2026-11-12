import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { getDiagnosticBus, type LogEvent } from "@minimal-agent/core/host/diagnostics"
import { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"

const PLUGINS_ROOT = join(import.meta.dir, "..")
const PLUGIN_ID = "ma-turn-recovery-plugin"

describe("ma-turn-recovery-plugin manifest", () => {
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
    const providers = loader.syntheticTextProviders()
    expect(providers).toHaveLength(1)
    expect([...(providers[0]?.kinds ?? [])].sort()).toEqual([
      "tool_result.aborted",
      "tool_result.handler_error",
      "tool_result.interrupted_by_stop",
      "tool_result.policy_denied",
    ])
    expect(providers[0]?.text("tool_result.handler_error", { detail: "boom" })).toBe(
      "Handler error: boom",
    )
  })
})
