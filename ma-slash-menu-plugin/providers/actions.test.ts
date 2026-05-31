import { describe, expect, it } from "bun:test"

import type { CommandInfo } from "../lib/host-types.ts"

import { commandItems } from "./actions.ts"

const SAMPLE: CommandInfo[] = [
  { name: "config", summary: "Edit settings", argHint: "[get <id>]", pluginId: "config" },
  { name: "loop", summary: "Run on repeat", pluginId: "schedule" },
]

describe("commandItems", () => {
  it("maps each registered command to an 'act' item", () => {
    const items = commandItems(SAMPLE)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      slug: "config",
      description: "Edit settings",
      category: "act",
    })
    expect(items[1]).toMatchObject({ slug: "loop", description: "Run on repeat", category: "act" })
  })

  it("carries actionId + pluginId + argHint in the payload", () => {
    const [config] = commandItems(SAMPLE)
    expect(config!.payload).toMatchObject({
      actionId: "config",
      kind: "command",
      pluginId: "config",
      argHint: "[get <id>]",
    })
  })

  it("omits argHint from payload when absent", () => {
    const [, loop] = commandItems(SAMPLE)
    expect((loop!.payload as Record<string, unknown>).argHint).toBeUndefined()
  })

  it("returns an empty list for no commands", () => {
    expect(commandItems([])).toEqual([])
  })

  it("preserves the host's command order (host already sorts)", () => {
    const items = commandItems(SAMPLE)
    expect(items.map((i) => i.slug)).toEqual(["config", "loop"])
  })
})
