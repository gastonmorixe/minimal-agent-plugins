/**
 * Unit tests of the reflection checkpoint plugin: the round modulo, interval
 * 0, the cooldown results, the ack, the texts, the config and the manifest.
 *
 * @module reflection.test
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeEach, describe, expect, it } from "bun:test"

import reflectionAckHandler, { ackNotice, parseAck } from "./handlers/ack.ts"
import { COUNTDOWN_ID, onDidBatch } from "./handlers/did-batch.ts"
import loopSafetyFragment from "./handlers/fragment.ts"
import { DEFAULT_COOLDOWN_MS, DEFAULT_INTERVAL, loadConfig } from "./lib/config.ts"
import type {
  CountdownRequest,
  CountdownResult,
  HookContext,
  TUIContext,
} from "./lib/host-types.ts"
import { resetAllState } from "./lib/state.ts"
import { attachmentText, loopSafetyText } from "./lib/text.ts"
import manifest from "./manifest.json"

const tmp = mkdtempSync(join(tmpdir(), "ma-reflection-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

/** An env with no config file, a fixed session, and the given overrides. */
function envWith(extra: Record<string, string> = {}): Record<string, string> {
  return {
    MINIMAL_AGENT_CONFIG: join(tmp, "absent.jsonc"),
    MINIMAL_AGENT_SESSION_ID: "s-test",
    ...extra,
  }
}

/** A hook context with a fake countdown that records its calls. */
function hookCtx(
  env: Record<string, string>,
  result: CountdownResult = "elapsed",
): HookContext & { calls: CountdownRequest[] } {
  const calls: CountdownRequest[] = []
  return {
    env,
    abort: new AbortController().signal,
    calls,
    countdown: async (req) => {
      calls.push(req)
      return result
    },
  }
}

/** A trigger context for the ack tag. */
function ackCtx(env: Record<string, string>, attrs: Record<string, string>): TUIContext {
  return { env, trigger: { type: "inline_tag", name: "reflection-ack", attrs, body: "" } }
}

/** The attachment texts of rounds `from..to`. */
async function runRounds(ctx: HookContext, from: number, to: number): Promise<number[]> {
  const fired: number[] = []
  for (let round = from; round <= to; round++) {
    const r = await onDidBatch({ results: [], round }, ctx)
    if (r && r.additionalContext.length > 0) fired.push(round)
  }
  return fired
}

beforeEach(() => resetAllState())

describe("round modulo", () => {
  it("fires at each multiple of the default interval (50)", async () => {
    const ctx = hookCtx(envWith({ MINIMAL_AGENT_REFLECTION_COOLDOWN_MS: "0" }))
    expect(await runRounds(ctx, 1, 150)).toEqual([50, 100, 150])
  })

  it("obeys a configured interval", async () => {
    const ctx = hookCtx(envWith({ MINIMAL_AGENT_REFLECTION_INTERVAL: "3" }))
    expect(await runRounds(ctx, 1, 10)).toEqual([3, 6, 9])
    expect(ctx.calls.map((c) => c.ms)).toEqual([60_000, 60_000, 60_000])
  })

  it("ignores a payload with no valid round", async () => {
    const ctx = hookCtx(envWith({ MINIMAL_AGENT_REFLECTION_INTERVAL: "1" }))
    expect(await onDidBatch({ results: [] } as never, ctx)).toBeUndefined()
    expect(await onDidBatch({ results: [], round: 0 }, ctx)).toBeUndefined()
  })
})

describe("interval 0", () => {
  it("turns off the checkpoint, the prompt section and the ack", async () => {
    const env = envWith({ MINIMAL_AGENT_REFLECTION_INTERVAL: "0" })
    const ctx = hookCtx(env)
    expect(await runRounds(ctx, 1, 200)).toEqual([])
    expect(ctx.calls).toEqual([])
    expect(loopSafetyFragment({ env })).toBe("")
    const res = await reflectionAckHandler(ackCtx(env, { "silence-for": "2" }))
    expect(res.ansi).toBe("")
  })
})

describe("cooldown", () => {
  const env = envWith({ MINIMAL_AGENT_REFLECTION_INTERVAL: "2" })

  it("elapsed: waits the full cooldown and reports it", async () => {
    const ctx = hookCtx(env, "elapsed")
    const r = await onDidBatch({ results: [], round: 2 }, ctx)
    expect(ctx.calls).toHaveLength(1)
    expect(ctx.calls[0]).toMatchObject({ id: COUNTDOWN_ID, ms: 60_000, signal: ctx.abort })
    expect(ctx.calls[0]?.label).toBe("reflection @ round 2")
    expect(r?.additionalContext[0]).toContain('round="2" cooldown-applied-seconds="60"')
  })

  it("skipped: adds the attachment with the time that passed", async () => {
    const ctx = hookCtx(env, "skipped")
    let t = 1_000
    const now = () => {
      const v = t
      t += 7_000
      return v
    }
    const r = await onDidBatch({ results: [], round: 2 }, ctx, { now })
    expect(r?.additionalContext[0]).toContain('cooldown-applied-seconds="7"')
  })

  it("aborted: adds no attachment", async () => {
    const ctx = hookCtx(env, "aborted")
    expect(await onDidBatch({ results: [], round: 2 }, ctx)).toBeUndefined()
  })

  it("cooldown 0: no wait, attachment with 0 seconds", async () => {
    const ctx = hookCtx(
      envWith({
        MINIMAL_AGENT_REFLECTION_INTERVAL: "2",
        MINIMAL_AGENT_REFLECTION_COOLDOWN_MS: "0",
      }),
    )
    const r = await onDidBatch({ results: [], round: 2 }, ctx)
    expect(ctx.calls).toEqual([])
    expect(r?.additionalContext[0]).toContain('cooldown-applied-seconds="0"')
  })
})

describe("ack", () => {
  const env = envWith({ MINIMAL_AGENT_REFLECTION_INTERVAL: "2" })

  it("parses the attributes", () => {
    expect(parseAck({ "silence-for": "3", reason: " long refactor " })).toEqual({
      silenceFor: 3,
      reason: "long refactor",
    })
    expect(parseAck({})).toEqual({ silenceFor: 1, reason: "" })
    expect(parseAck({ "silence-for": "0" })).toBeNull()
    expect(parseAck({ "silence-for": "-1" })).toBeNull()
    expect(parseAck({ "silence-for": "x" })).toBeNull()
  })

  it("silences the next K checkpoints, then they fire again", async () => {
    const res = await reflectionAckHandler(
      ackCtx(env, { "silence-for": "2", reason: "audit of 40 files" }),
    )
    expect(res.ansi).toContain("skip the next 2 reflection checkpoints (audit of 40 files)")
    const ctx = hookCtx(env)
    expect(await runRounds(ctx, 1, 8)).toEqual([6, 8])
    expect(ctx.calls.map((c) => c.label)).toEqual(["reflection @ round 6", "reflection @ round 8"])
  })

  it("keeps the silence of each session apart", async () => {
    await reflectionAckHandler(ackCtx(env, { "silence-for": "5" }))
    const other = hookCtx({ ...env, MINIMAL_AGENT_SESSION_ID: "s-other" })
    expect(await runRounds(other, 1, 4)).toEqual([2, 4])
  })

  it("a new run clears an old count, but keeps an ack of the new run", async () => {
    await reflectionAckHandler(ackCtx(env, { "silence-for": "9" }))
    const ctx = hookCtx(env)
    expect(await runRounds(ctx, 1, 4)).toEqual([])
    // New run with no ack: round 1 again clears the count.
    expect(await runRounds(ctx, 1, 2)).toEqual([2])
    // New run that starts with an ack: the ack stays.
    await reflectionAckHandler(ackCtx(env, { "silence-for": "1" }))
    expect(await runRounds(ctx, 1, 4)).toEqual([4])
  })

  it("shows a reason-less notice", () => {
    expect(ackNotice({ silenceFor: 1, reason: "" })).toContain(
      "reflection ack: skip the next 1 reflection checkpoint\x1b",
    )
  })
})

describe("texts", () => {
  it("attachment has the tag and the reflection prompt", () => {
    const text = attachmentText(50, 60_000)
    expect(text.split("\n")[0]).toBe(
      '<ma::agent::reflection-checkpoint round="50" cooldown-applied-seconds="60" />',
    )
    expect(text).toContain("- Continue.\n- Change your method.\n- Stop and speak to the user.")
    expect(text).toContain('<ma::emit::reflection-ack silence-for="K" reason="..." />')
    expect(text).not.toContain("%%")
  })

  it("prompt section shows the configured interval and cooldown", () => {
    const text = loopSafetyText(25, 30_000)
    expect(text.startsWith("# Tool loop safety\n")).toBe(true)
    expect(text).toContain("after each 25 tool steps")
    expect(text).toContain("waits 30 seconds")
    expect(text).toContain('cooldown-applied-seconds="30"')
    expect(text).not.toContain("%%")
    const plain = loopSafetyText(25, 0)
    expect(plain).toContain('cooldown-applied-seconds="0"')
    expect(plain).not.toContain("Esc")
  })

  it("fragment uses the config", () => {
    expect(loopSafetyFragment({ env: envWith() })).toBe(loopSafetyText(50, 60_000))
  })
})

describe("config", () => {
  it("defaults", () => {
    expect(loadConfig(envWith())).toEqual({
      interval: DEFAULT_INTERVAL,
      cooldownMs: DEFAULT_COOLDOWN_MS,
    })
    expect(DEFAULT_INTERVAL).toBe(50)
    expect(DEFAULT_COOLDOWN_MS).toBe(60_000)
  })

  it("reads plugins.reflection-checkpoint from the config file; env wins", () => {
    const file = join(tmp, "config.jsonc")
    writeFileSync(
      file,
      '{ // c\n "plugins": { "reflection-checkpoint": { "enabled": true, "interval": 10, "cooldownMs": 5000 } } }',
    )
    expect(loadConfig({ MINIMAL_AGENT_CONFIG: file })).toEqual({ interval: 10, cooldownMs: 5000 })
    expect(
      loadConfig({ MINIMAL_AGENT_CONFIG: file, MINIMAL_AGENT_REFLECTION_INTERVAL: "7" }),
    ).toEqual({ interval: 7, cooldownMs: 5000 })
  })

  it("ignores bad values", () => {
    const env = envWith({
      MINIMAL_AGENT_REFLECTION_INTERVAL: "-3",
      MINIMAL_AGENT_REFLECTION_COOLDOWN_MS: "abc",
    })
    expect(loadConfig(env)).toEqual({ interval: 50, cooldownMs: 60_000 })
  })
})

describe("manifest", () => {
  it("is disabled by default", () => {
    expect(manifest.enabled).toBe(false)
  })

  it("declares the hook, the fragment and the inline tag", () => {
    expect(manifest.permissions).toContain("hooks:tool.didBatch")
    expect(manifest.headless.hooks[0]?.channel).toBe("tool.didBatch")
    expect(manifest.headless.promptFragments[0]?.placement).toBe("afterInstructions")
    expect(manifest.headless.tools[0]?.trigger).toEqual({
      type: "inline_tag",
      tag: "reflection-ack",
    })
  })
})
