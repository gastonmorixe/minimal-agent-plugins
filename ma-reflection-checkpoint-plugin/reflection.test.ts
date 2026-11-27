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

import { expandTemplate } from "../ma-template-kit/src/index.ts"
import { pluginSideband } from "../tests/support/sideband.ts"

import reflectionAckHandler, { ackNotice, parseAck } from "./handlers/ack.ts"
import { COUNTDOWN_ID, onDidBatch } from "./handlers/did-batch.ts"
import onRunEnd from "./handlers/run-end.ts"
import {
  DEFAULT_COOLDOWN_MS,
  DEFAULT_INTERVAL,
  loadConfig,
  pluginConfig,
  resetConfigCache,
} from "./lib/config.ts"
import type {
  CountdownRequest,
  CountdownResult,
  HookContext,
  HookTemplateEntry,
  RunModeFact,
  TUIContext,
} from "./lib/host-types.ts"
import {
  hasState,
  MAX_SESSIONS,
  resetAllState,
  sessionCount,
  sessionKey,
  stateFor,
} from "./lib/state.ts"
import { attachmentEntry } from "./lib/text.ts"
import manifest from "./manifest.json"

/** The real codec: the attachment tag line renders with it (design 40 step 10). */
const SB = await pluginSideband()

/** Render a returned entry as core does: a template with the real codec, a string as is. */
function render(x: HookTemplateEntry | string | undefined): string {
  if (x === undefined || typeof x === "string") return x ?? ""
  return expandTemplate(x.text, { vars: x.vars ?? {}, sideband: SB })
}

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

/** The run fact of an interactive REPL. */
const REPL: RunModeFact = { mode: "repl", interactive: true }

/**
 * A hook context with a fake countdown that records its calls. The default
 * run is an interactive REPL; pass `null` for a host with no run fact.
 */
function hookCtx(
  env: Record<string, string>,
  result: CountdownResult = "elapsed",
  run: RunModeFact | null = REPL,
): HookContext & { calls: CountdownRequest[] } {
  const calls: CountdownRequest[] = []
  return {
    env,
    abort: new AbortController().signal,
    ...(run ? { run } : {}),
    sideband: SB,
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

beforeEach(() => {
  resetAllState()
  resetConfigCache()
})

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
  it("turns off the checkpoint and the ack", async () => {
    const env = envWith({ MINIMAL_AGENT_REFLECTION_INTERVAL: "0" })
    const ctx = hookCtx(env)
    expect(await runRounds(ctx, 1, 200)).toEqual([])
    expect(ctx.calls).toEqual([])
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
    expect(render(r?.additionalContext[0])).toContain('round="2" cooldown-applied-seconds="60"')
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
    expect(render(r?.additionalContext[0])).toContain('cooldown-applied-seconds="7"')
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
    expect(render(r?.additionalContext[0])).toContain('cooldown-applied-seconds="0"')
  })
})

describe("run that is not interactive", () => {
  const env = envWith({ MINIMAL_AGENT_REFLECTION_INTERVAL: "2" })

  for (const [name, run] of [
    ["one-shot", { mode: "one-shot", interactive: false }],
    ["stream-json", { mode: "stream-json", interactive: false }],
    ["sub-agent", { mode: "subagent", interactive: false }],
    ["no run fact", null],
  ] as const) {
    it(`${name}: no wait, attachment with 0 seconds`, async () => {
      const ctx = hookCtx(env, "elapsed", run)
      const r = await onDidBatch({ results: [], round: 2 }, ctx)
      expect(ctx.calls).toEqual([])
      expect(render(r?.additionalContext[0])).toContain('round="2" cooldown-applied-seconds="0"')
    })
  }

  it("interactive REPL: waits through the countdown", async () => {
    const ctx = hookCtx(env, "elapsed", REPL)
    const r = await onDidBatch({ results: [], round: 2 }, ctx)
    expect(ctx.calls).toHaveLength(1)
    expect(render(r?.additionalContext[0])).toContain('cooldown-applied-seconds="60"')
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

  it("run end: an ack in the last response of run N does not go into run N+1", async () => {
    const ctx = hookCtx(env)
    expect(await runRounds(ctx, 1, 3)).toEqual([2])
    // The last response of run N is text only and has an ack.
    await reflectionAckHandler(ackCtx(env, { "silence-for": "3" }))
    onRunEnd(undefined, ctx)
    // Run N+1: the checkpoints fire.
    expect(await runRounds(ctx, 1, 4)).toEqual([2, 4])
  })

  it("run end: an ack in the first response of run N+1 stays", async () => {
    const ctx = hookCtx(env)
    expect(await runRounds(ctx, 1, 3)).toEqual([2])
    onRunEnd(undefined, ctx)
    await reflectionAckHandler(ackCtx(env, { "silence-for": "1" }))
    expect(await runRounds(ctx, 1, 4)).toEqual([4])
  })

  it("run end deletes the state of the session only", async () => {
    const other = { ...env, MINIMAL_AGENT_SESSION_ID: "s-other" }
    await reflectionAckHandler(ackCtx(env, { "silence-for": "2" }))
    await reflectionAckHandler(ackCtx(other, { "silence-for": "2" }))
    onRunEnd(undefined, { env })
    expect(hasState(sessionKey(undefined, env))).toBe(false)
    expect(stateFor(sessionKey(undefined, other)).silenceRemaining).toBe(2)
  })

  it("shows a reason-less notice", () => {
    expect(ackNotice({ silenceFor: 1, reason: "" })).toContain(
      "reflection ack: skip the next 1 reflection checkpoint\x1b",
    )
  })
})

describe("session map", () => {
  it("keeps at most MAX_SESSIONS entries and drops the oldest (LRU)", () => {
    stateFor("first").silenceRemaining = 4
    for (let i = 0; i < MAX_SESSIONS - 1; i++) stateFor(`s-${i}`)
    // A read makes "first" the newest, so "s-0" is now the oldest.
    expect(stateFor("first").silenceRemaining).toBe(4)
    stateFor("new")
    expect(sessionCount()).toBe(MAX_SESSIONS)
    expect(hasState("first")).toBe(true)
    expect(hasState("s-0")).toBe(false)
    expect(hasState("s-1")).toBe(true)
  })
})

describe("texts", () => {
  it("attachment has the tag and the reflection prompt", () => {
    const text = render(attachmentEntry(50, 60_000, SB))
    const first = text.split("\n")[0] ?? ""
    expect(SB.startsWith(first, { kinds: ["reflection-checkpoint"] })).toBe(true)
    expect(SB.attrs(SB.find(first)[0]!)).toEqual({ round: 50, "cooldown-applied-seconds": 60 })
    expect(text).toContain("- Continue.\n- Change your method.\n- Stop and speak to the user.")
    // The prompt names the ack tag in a code span (prose of the prompt file).
    expect(text).toContain("reflection-ack silence-for=")
    expect(text).not.toContain("%%")
  })

  it("no sideband API: the prompt only, with no tag line and no leading line feed", () => {
    for (const text of [
      render(attachmentEntry(50, 60_000)),
      render(attachmentEntry(50, 60_000, { render: () => "" })),
    ]) {
      expect(text).toStartWith("This checkpoint is soft.")
      expect(text).toBe(
        render(attachmentEntry(50, 60_000, SB))
          .split("\n")
          .slice(1)
          .join("\n"),
      )
    }
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

  it("pluginConfig reads one time for each process", async () => {
    const first = envWith({ MINIMAL_AGENT_REFLECTION_INTERVAL: "3" })
    const later = envWith({ MINIMAL_AGENT_REFLECTION_INTERVAL: "5" })
    expect(pluginConfig(first).interval).toBe(3)
    expect(pluginConfig(later).interval).toBe(3)
    const ctx = hookCtx(later)
    expect(await runRounds(ctx, 1, 6)).toEqual([3, 6])
    resetConfigCache()
    expect(pluginConfig(later).interval).toBe(5)
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

  it("declares the hooks and the inline tag, and no prompt fragment", () => {
    expect(manifest.permissions).toContain("hooks:tool.didBatch")
    expect(manifest.headless.hooks[0]?.channel).toBe("tool.didBatch")
    expect(manifest.permissions).toContain("hooks:turn.didEnd")
    expect(manifest.permissions).toContain("hooks:turn.aborted")
    expect(manifest.headless.hooks.map((h) => h.channel)).toEqual([
      "tool.didBatch",
      "turn.didEnd",
      "turn.aborted",
    ])
    expect("promptFragments" in manifest.headless).toBe(false)
    expect(manifest.headless.tools[0]?.trigger).toEqual({
      type: "inline_tag",
      tag: "reflection-ack",
    })
  })
})
