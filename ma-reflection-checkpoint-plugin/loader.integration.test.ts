/**
 * Integration: load this plugin through the real core PluginLoader.
 *
 * - With no opt-in, the manifest `enabled: false` keeps it off: no prompt
 *   section and no `tool.didBatch` listener.
 * - With `enabledPluginIds`, the fragment gives the "Tool loop safety"
 *   section, the real `PluginStream` removes the ack tag from the visible
 *   output and gives the handler the attributes, and the real hook bus
 *   gives `round`, `ctx.abort` and `ctx.countdown` to the listener, which
 *   returns the attachment as `additionalContext`.
 * - An ack tag split across two stream chunks still sets the count, and
 *   `turn.didEnd` clears the count at the end of a run.
 *
 * @module reflection-checkpoint/loader.integration.test
 */

import { cpSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"
import { PluginStream } from "@minimal-agent/core/host-kit/plugin-stream"

import { pluginSideband } from "../tests/support/sideband.ts"

/** The real codec: the tests write the ack tag and read the checkpoint tag with it. */
const SB = await pluginSideband()
/** The ack tag as the model writes it. */
const ack = (attrs: Record<string, string | number>): string =>
  SB.render("reflection-ack", { attrs })

const tmp = mkdtempSync(join(tmpdir(), "ma-reflection-int-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const ID = "reflection-checkpoint"

/**
 * A root with only this plugin and the sideband codec plugin (it renders the
 * checkpoint tag line), so discovery does not load the whole fleet.
 */
function isolatedRoot(name: string): string {
  for (const dir of ["ma-reflection-checkpoint-plugin", "ma-sideband-plugin"]) {
    cpSync(join(import.meta.dir, "..", dir), join(tmp, name, dir), {
      recursive: true,
      filter: (src) => !src.endsWith(".test.ts") && !src.includes("node_modules"),
    })
  }
  return join(tmp, name)
}

/** Set the env that the handlers read, for the time of `fn`. `undefined` removes a var. */
async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const old: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(vars)) {
    old[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

const ENV = {
  MINIMAL_AGENT_CONFIG: join(tmp, "absent.jsonc"),
  MINIMAL_AGENT_REFLECTION_INTERVAL: "2",
  MINIMAL_AGENT_REFLECTION_COOLDOWN_MS: "1000",
  // A run in a sub-agent worker has these vars. Core then sets `ctx.run` to
  // `subagent` with `interactive: false`, and the handler does no countdown.
  MINIMAL_AGENT_SUBAGENT_ID: undefined,
  MINIMAL_AGENT_SUBAGENT_SID: undefined,
}

describe("reflection-checkpoint via the real PluginLoader", () => {
  it("is off by default (manifest enabled: false)", async () => {
    await withEnv(ENV, async () => {
      const loader = await PluginLoader.load({
        roots: { user: [isolatedRoot("off")] },
        logger: () => {},
      })
      try {
        const blocks = await loader.getPromptBlocksAsync()
        expect(blocks.afterInstructions ?? "").not.toContain("Tool loop safety")
        expect(loader.hooks().hookBus.listenerCount("tool.didBatch")).toBe(0)
      } finally {
        loader.hooks().dispose()
      }
    })
  })

  it("opt-in: prompt section, ack tag, checkpoint with countdown", async () => {
    await withEnv(ENV, async () => {
      const countdowns: { id: string; label: string; ms: number; signal?: AbortSignal }[] = []
      const loader = await PluginLoader.load({
        roots: { user: [isolatedRoot("on")] },
        logger: () => {},
        enabledPluginIds: new Set([ID]),
        sessionId: "s-int",
        runMode: () => ({ mode: "repl", interactive: true }),
        countdown: async (req) => {
          countdowns.push(req)
          return "skipped"
        },
      })
      try {
        const blocks = await loader.getPromptBlocksAsync()
        expect(blocks.afterInstructions).toContain("# Tool loop safety")
        expect(blocks.afterInstructions).toContain("after each 2 tool steps")

        // The ack: the scanner removes the tag; the user sees the notice.
        let out = ""
        const stream = new PluginStream((c) => (out += c), loader, tmp)
        const text = `Work. ${ack({ "silence-for": 1, reason: "long audit" })} More.`
        const p = stream.feed(text)
        if (p) await p
        await stream.end()
        expect(SB.find(out, { kinds: ["reflection-ack"] })).toEqual([])
        expect(out).not.toContain("reflection-ack")
        expect(out).toContain("skip the next 1 reflection checkpoint (long audit)")
        expect(out).toContain("Work. ")
        expect(out).toContain(" More.")

        const bus = loader.hooks()
        const signal = new AbortController().signal
        const emit = (round: number) =>
          bus.emitChain("tool.didBatch", { results: [], round }, { signal })
        // Round 1: not due. Round 2: due but silenced by the ack. Round 4: fires.
        for (const round of [1, 2, 3]) {
          expect((await emit(round)).additionalContext).toEqual([])
        }
        expect(countdowns).toEqual([])
        const r4 = await emit(4)
        expect(countdowns).toHaveLength(1)
        expect(countdowns[0]?.label).toBe("reflection @ round 4")
        expect(countdowns[0]?.ms).toBe(1000)
        const ctx = r4.additionalContext.map((e) => (typeof e === "string" ? e : e.text))
        expect(ctx).toHaveLength(1)
        const tag = SB.find(ctx[0] ?? "", { kinds: ["reflection-checkpoint"] })
        expect(tag).toHaveLength(1)
        expect(SB.attrs(tag[0]!)).toEqual({ round: 4, "cooldown-applied-seconds": 0 })
      } finally {
        loader.hooks().dispose()
      }
    })
  })

  it("ack tag split across stream chunks; turn.didEnd ends the run", async () => {
    await withEnv(ENV, async () => {
      const countdowns: string[] = []
      const loader = await PluginLoader.load({
        roots: { user: [isolatedRoot("split")] },
        logger: () => {},
        enabledPluginIds: new Set([ID]),
        sessionId: "s-split",
        runMode: () => ({ mode: "repl", interactive: true }),
        countdown: async (req) => {
          countdowns.push(req.label)
          return "elapsed"
        },
      })
      try {
        const bus = loader.hooks()
        const signal = new AbortController().signal
        const fired = async (from: number, to: number): Promise<number[]> => {
          const out: number[] = []
          for (let round = from; round <= to; round++) {
            const r = await bus.emitChain("tool.didBatch", { results: [], round }, { signal })
            if (r.additionalContext.length > 0) out.push(round)
          }
          return out
        }

        let out = ""
        const stream = new PluginStream((c) => (out += c), loader, tmp)
        const split = `Go. ${ack({ "silence-for": 2, reason: "x" })} Done.`
        const cut = split.indexOf("reflection-ack") + "reflec".length
        for (const chunk of [split.slice(0, cut), split.slice(cut)]) {
          const p = stream.feed(chunk)
          if (p) await p
        }
        await stream.end()
        expect(SB.find(out, { kinds: ["reflection-ack"] })).toEqual([])
        expect(out).not.toContain("reflection-ack")
        expect(out).toContain("skip the next 2 reflection checkpoints (x)")
        expect(out).toContain("Go. ")
        expect(out).toContain(" Done.")

        // The count is 2: rounds 2 and 4 are silenced, round 6 fires.
        expect(await fired(1, 6)).toEqual([6])
        expect(countdowns).toEqual(["reflection @ round 6"])

        // An ack in the last response of the run, then the run ends.
        const p = stream.feed(ack({ "silence-for": 5 }))
        if (p) await p
        await stream.end()
        bus.emitAsync("turn.didEnd", { ok: true })
        await new Promise((r) => setTimeout(r, 0))
        // The next run: the old ack does not silence the checkpoints.
        expect(await fired(1, 4)).toEqual([2, 4])
      } finally {
        loader.hooks().dispose()
      }
    })
  })
})
