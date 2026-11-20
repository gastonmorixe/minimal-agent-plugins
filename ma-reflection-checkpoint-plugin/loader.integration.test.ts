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

const tmp = mkdtempSync(join(tmpdir(), "ma-reflection-int-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const ID = "reflection-checkpoint"

/** A root with only this plugin, so discovery does not load the whole fleet. */
function isolatedRoot(name: string): string {
  const dest = join(tmp, name, "ma-reflection-checkpoint-plugin")
  cpSync(import.meta.dir, dest, {
    recursive: true,
    filter: (src) => !src.endsWith(".test.ts") && !src.includes("node_modules"),
  })
  return join(tmp, name)
}

/** Set the env that the handlers read, for the time of `fn`. */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const old: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(vars)) {
    old[k] = process.env[k]
    process.env[k] = v
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
        const text = 'Work. <ma::emit::reflection-ack silence-for="1" reason="long audit" /> More.'
        const p = stream.feed(text)
        if (p) await p
        await stream.end()
        expect(out).not.toContain("<ma::emit::reflection-ack")
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
        expect(ctx[0]).toContain('<ma::agent::reflection-checkpoint round="4"')
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
        for (const chunk of [
          "Go. <ma::emit::reflec",
          'tion-ack silence-for="2" reason="x" /> Done.',
        ]) {
          const p = stream.feed(chunk)
          if (p) await p
        }
        await stream.end()
        expect(out).not.toContain("<ma::emit::")
        expect(out).not.toContain("reflection-ack silence-for")
        expect(out).toContain("skip the next 2 reflection checkpoints (x)")
        expect(out).toContain("Go. ")
        expect(out).toContain(" Done.")

        // The count is 2: rounds 2 and 4 are silenced, round 6 fires.
        expect(await fired(1, 6)).toEqual([6])
        expect(countdowns).toEqual(["reflection @ round 6"])

        // An ack in the last response of the run, then the run ends.
        const p = stream.feed('<ma::emit::reflection-ack silence-for="5" />')
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
