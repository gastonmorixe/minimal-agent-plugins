import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { claudeAdapter, parseClaude } from "../adapters/claude/adapter.ts"
import { listLines } from "../handlers/hooks-command.ts"
import { debugValue, decodeNative, nativeAdapter, parseNative } from "../native/adapter.ts"

import { HooksEngine } from "./engine.ts"
import { hookContentHash } from "./hash.ts"
import { dedupHooks, dedupKey, mergeResults } from "./merge.ts"
import { makeSandbox, nativeConfig, type Sandbox } from "./test-support.ts"
import type { CanonicalHook, RunOutcome, SourceRef } from "./types.ts"

const src: SourceRef = { id: "user", path: "/h/hooks.json", scope: "user", precedence: 0 }
const run = (o: Partial<RunOutcome>): RunOutcome => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  durationMs: 1,
  ...o,
})

/** Parse one native turn.willStart hook with extra handler fields. */
function parseOne(extra: Record<string, unknown>): { hook: CanonicalHook; warnings: string[] } {
  const r = parseNative(src, nativeConfig("turn.willStart", [{ command: "echo x", ...extra }]))
  const hook = r.hooks[0]
  if (!hook) throw new Error("no hook")
  return { hook, warnings: r.warnings }
}

describe("position: native config", () => {
  test("config before, after and missing", () => {
    expect(parseOne({ position: "before" }).hook.position).toBe("before")
    expect(parseOne({ position: "after" }).hook.position).toBe("after")
    expect(parseOne({}).hook.position).toBe("after")
    expect(parseOne({ position: "before" }).warnings).toEqual([])
  })

  test("config invalid: a warning and fallback to after", () => {
    const { hook, warnings } = parseOne({ position: "top" })
    expect(hook.position).toBe("after")
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('bad position "top"')
  })
})

describe("position: native output", () => {
  const before = parseOne({ position: "before" }).hook
  const after = parseOne({}).hook

  test("JSON position beats the config", () => {
    const toAfter = decodeNative(
      before,
      "turn.willStart",
      run({ stdout: '{"context":"c","position":"after"}' }),
    )
    expect(toAfter).toEqual({ decision: "none", context: ["c"] })
    const toBefore = decodeNative(
      after,
      "turn.willStart",
      run({ stdout: '{"context":"c","position":"before"}' }),
    )
    expect(toBefore).toEqual({ decision: "none", context: ["c"], position: "before" })
  })

  test("plain text uses the config position", () => {
    expect(decodeNative(before, "turn.willStart", run({ stdout: "ctx" }))).toEqual({
      decision: "none",
      context: ["ctx"],
      position: "before",
    })
    expect(decodeNative(after, "turn.willStart", run({ stdout: "ctx" })).position).toBeUndefined()
  })

  test("invalid output position: config position, debug note", () => {
    const r = decodeNative(
      before,
      "turn.willStart",
      run({ stdout: '{"context":"c","position":9}' }),
    )
    expect(r.position).toBe("before")
    expect(r.debug).toContain("ignored output position 9")
    expect(r.error).toBeUndefined()
  })
})

describe("position: claude adapter", () => {
  test("Claude ignores position and logs it at debug", () => {
    const text = JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "x", position: "before" }] }],
      },
    })
    const r = parseClaude(src, text)
    expect(r.hooks[0]?.position).toBeUndefined()
    expect(r.warnings).toEqual([])
    expect(r.debug?.[0]).toContain('ignored "position"')
    const plain = parseClaude(src, text.replace(',"position":"before"', ""))
    expect(r.hooks[0]?.contentHash).toBe(plain.hooks[0]?.contentHash)
  })
})

describe("position: content hash", () => {
  const base = {
    dialect: "native",
    channel: "turn.willStart",
    event: "turn.willStart",
    handler: { type: "command" as const, command: "echo x" },
    timeoutMs: 1000,
    async: false,
    failClosed: false,
  }

  test("hash changes when position changes to before", () => {
    expect(hookContentHash({ ...base, position: "before" })).not.toBe(hookContentHash(base))
    expect(parseOne({ position: "before" }).hook.contentHash).not.toBe(
      parseOne({}).hook.contentHash,
    )
  })

  test("explicit after and missing give the same hash", () => {
    expect(hookContentHash({ ...base, position: "after" })).toBe(hookContentHash(base))
    expect(parseOne({ position: "after" }).hook.contentHash).toBe(parseOne({}).hook.contentHash)
  })
})

describe("position: merge", () => {
  test("merge keeps source order inside each position", () => {
    const m = mergeResults([
      { decision: "none", context: ["a1"] },
      { decision: "none", context: ["b1"], position: "before" },
      { decision: "none", context: ["a2", "a3"], position: "after" },
      { decision: "none", context: ["b2"], position: "before" },
    ])
    expect(m.contextBefore).toEqual(["b1", "b2"])
    expect(m.context).toEqual(["a1", "a2", "a3"])
  })

  test("dedup keeps copies that differ only in position", () => {
    const user = parseOne({ position: "before" }).hook
    const project: CanonicalHook = {
      ...parseOne({}).hook,
      source: { id: "project", path: "/p/hooks.json", scope: "project", precedence: 1 },
    }
    expect(dedupKey(user)).not.toBe(dedupKey(project))
    expect(dedupHooks([user, project]).kept).toHaveLength(2)
    const sameAsUser: CanonicalHook = { ...project, position: "before" }
    expect(dedupHooks([user, sameAsUser]).kept).toEqual([user])
  })
})

describe("position: debug value cap", () => {
  test("a long output position is capped to 80 characters with an ellipsis", () => {
    const after = parseOne({}).hook
    const long = "x".repeat(500)
    const stdout = JSON.stringify({ context: "c", position: long })
    const r = decodeNative(after, "turn.willStart", run({ stdout }))
    expect(debugValue(long)).toBe(`${JSON.stringify(long).slice(0, 80)}...`)
    expect(r.debug).toContain(debugValue(long))
    expect((r.debug ?? "").length).toBeLessThan(140)
    expect(debugValue(9)).toBe("9")
  })
})

describe("position: engine dispatch", () => {
  let sb: Sandbox
  beforeEach(() => {
    sb = makeSandbox()
  })
  afterEach(() => {
    sb.cleanup()
  })
  const userHooks = () => join(sb.agentHome, "hooks.json")
  const engine = (debug?: (m: string) => void) =>
    new HooksEngine({
      cwd: sb.project,
      env: sb.env,
      adapters: [nativeAdapter, claudeAdapter],
      ...(debug ? { debug } : {}),
    })
  const hooksFor = () => [
    { command: "echo after-1" },
    { command: "echo before-1", position: "before" },
    { command: "echo after-2", position: "after" },
    { command: `echo '{"context":"before-2","position":"before"}'` },
  ]

  test("turn.willStart and session.willStart: before objects first, after as strings", async () => {
    for (const channel of ["turn.willStart", "session.willStart"]) {
      sb.write(userHooks(), nativeConfig(channel, hooksFor()))
      const r = await engine().dispatch(channel, { text: "hi", source: "startup" })
      expect(r).toMatchObject({
        additionalContext: [
          { text: "before-1", position: "before" },
          { text: "before-2", position: "before" },
          "after-1",
          "after-2",
        ],
      })
    }
  })

  test("no before hooks: turn.willStart returns only strings (pre-P2 shape)", async () => {
    const cmds = ["echo a1", { command: "echo a2", position: "after" }]
    for (const channel of ["turn.willStart", "session.willStart"]) {
      sb.write(userHooks(), nativeConfig(channel, cmds))
      const r = await engine().dispatch(channel, { text: "hi", source: "startup" })
      expect(r).toEqual({
        payload: { text: "hi", source: "startup" },
        additionalContext: ["a1", "a2"],
      })
    }
  })

  test("async before hook: context kept across the queue, delivered at the next dispatch", async () => {
    const cmds = [
      { command: "echo async-before", async: true, position: "before" },
      { command: "echo async-after", async: true },
    ]
    sb.write(userHooks(), nativeConfig("turn.willStart", cmds))
    const e = engine()
    expect(await e.dispatch("turn.willStart", { text: "a" })).toBeUndefined()
    await e.asyncQueue.idle()
    sb.write(userHooks(), nativeConfig("turn.willStart", ["echo sync-after"]))
    const r = await e.dispatch("turn.willStart", { text: "b" })
    expect(r).toMatchObject({
      additionalContext: [
        { text: "async-before", position: "before" },
        "async-after",
        "sync-after",
      ],
    })
  })

  test("tool.willInvoke returns plain strings", async () => {
    const cmds = [
      `echo '{"context":"x1"}'`,
      { command: `echo '{"context":"x2"}'`, position: "before" },
    ]
    sb.write(userHooks(), nativeConfig("tool.willInvoke", cmds))
    const r = await engine().dispatch("tool.willInvoke", { tool: "Bash", input: {}, cwd: "/" })
    expect(r).toMatchObject({ additionalContext: ["x2", "x1"] })
  })

  test("Claude context is always after; the ignored key reaches the debug sink", async () => {
    const notes: string[] = []
    sb.write(
      join(sb.home, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: "command", command: "echo c", position: "before" }] },
          ],
        },
      }),
    )
    const r = await engine((m) => notes.push(m)).dispatch("turn.willStart", { text: "hi" })
    expect(r).toMatchObject({ additionalContext: ["c"] })
    expect(notes.some((n) => n.includes('ignored "position"'))).toBe(true)
  })

  test("/hooks list shows position only when it is before", () => {
    sb.write(userHooks(), nativeConfig("turn.willStart", hooksFor()))
    const lines = listLines(engine())
    expect(lines.filter((l) => l.includes("position before"))).toHaveLength(1)
    expect(lines.some((l) => l.includes("position after"))).toBe(false)
  })
})
