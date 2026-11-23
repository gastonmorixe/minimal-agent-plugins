/**
 * The footer follows a target switch during the session (`/model`,
 * `/effort`, `/provider`). The host writes the live target to the env
 * (cli `startup/live-target.ts`) and sends `target.didSwitch`. the owner saw
 * the footer keep the boot effort ("haiku-5.5:low" while the session ran at
 * effort high) and the boot model until the next response.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

import handle from "./handler.ts"
import type { LiveAreaHandlerContext } from "./host-types.ts"

const KEYS = ["MINIMAL_AGENT_MODEL", "MINIMAL_AGENT_PROVIDER", "MINIMAL_AGENT_EFFORT"] as const
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

/** A host with no quota and a fixed model label: only the context and model segments draw. */
function context(asked: string[]): LiveAreaHandlerContext {
  return {
    abort: new AbortController().signal,
    footerReservedWidth: 1,
    host: {
      sessionInfo: {
        providerInfo: async (modelId: string) => {
          asked.push(modelId)
          return { contextWindow: 200_000, modelLabel: `lbl-${modelId}` }
        },
        tokens: () => ({
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheCreate: 0,
          total: 2,
          turns: 1,
          contextSize: 1000,
        }),
      },
    },
  } as unknown as LiveAreaHandlerContext
}

const plain = (s: string | null): string => (s ?? "").replace(/\u001b\[[0-9;]*m/g, "")

describe("the footer reads the live target at each draw", () => {
  it("a change of the effort shows at the next draw (it was read once, at load)", async () => {
    process.env.MINIMAL_AGENT_MODEL = "m1"
    process.env.MINIMAL_AGENT_EFFORT = "low"
    const first = plain(await handle(context([])))
    expect(first).toContain("low")
    process.env.MINIMAL_AGENT_EFFORT = "high"
    const second = plain(await handle(context([])))
    expect(second).toContain("high")
    expect(second).not.toContain("low")
  })

  it("a change of the model asks the provider about the new model", async () => {
    const asked: string[] = []
    process.env.MINIMAL_AGENT_MODEL = "m1"
    await handle(context(asked))
    process.env.MINIMAL_AGENT_MODEL = "m2"
    const line = plain(await handle(context(asked)))
    expect(asked).toEqual(["m1", "m2"])
    expect(line).toContain("lbl-m2")
  })
})

describe("the slot draws again on a target switch", () => {
  it("target.didSwitch is in refreshOn, so the footer does not wait for the next response", () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "manifest.json"), "utf8"))
    const slots: { refreshOn?: string[] }[] = manifest.ui.liveAreaSlots
    expect(slots.some((s) => (s.refreshOn ?? []).includes("target.didSwitch"))).toBe(true)
  })
})
