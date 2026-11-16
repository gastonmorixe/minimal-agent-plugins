/**
 * Review B3 regressions: dedup after trust (BLOCKER) and the per-channel
 * payload rewrite allow-list (MAJOR 2). Real files and real scripts in a
 * temp HOME.
 */

import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { claudeAdapter } from "../adapters/claude/adapter.ts"
import { nativeAdapter } from "../native/adapter.ts"

import { rewritableKeys } from "./channels.ts"
import { HooksEngine } from "./engine.ts"
import { dedupHooks, dedupKey, mergeResults } from "./merge.ts"
import { makeSandbox, nativeConfig, type Sandbox } from "./test-support.ts"
import type { CanonicalHook } from "./types.ts"

let sb: Sandbox
let logs: string[]

beforeEach(() => {
  sb = makeSandbox()
  logs = []
})

afterEach(() => {
  sb.cleanup()
})

const userClaude = () => join(sb.home, ".claude", "settings.json")
const userNative = () => join(sb.agentHome, "hooks.json")
const projectNative = () => join(sb.project, ".minimal-agent", "hooks.json")

const bash = (command: string) => ({
  tool: "Bash",
  toolUseId: "t1",
  input: { command },
  cwd: sb.project,
  sid: "sid-1",
  agentId: "a1",
})

function engine(): HooksEngine {
  return new HooksEngine({
    cwd: sb.project,
    env: sb.env,
    adapters: [nativeAdapter, claudeAdapter],
    log: (m) => logs.push(m),
  })
}

/** A real guard: reads the stdin JSON, exit 2 on `rm -rf`. */
function guardScript(): string {
  return sb.script(
    "guard.sh",
    `if grep -q 'rm -rf'; then echo "Blocked: rm -rf is not allowed." >&2; exit 2; fi\nexit 0`,
  )
}

describe("B3 BLOCKER: dedup runs after trust, user scope wins", () => {
  test("an untrusted project copy of a ~/.claude guard does not drop the user guard", async () => {
    const guard = guardScript()
    sb.write(
      userClaude(),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: guard }] }] },
      }),
    )
    // The attack: the untrusted project copies the exact hook in native form.
    sb.write(projectNative(), nativeConfig("tool.willInvoke", [guard], {}, "Bash"))
    const e = engine()
    const ok = e.all.filter((h) => h.support === "ok")
    expect(ok.map((h) => `${h.dialect}:${h.source.scope}`)).toEqual([
      "native:project",
      "claude:user",
    ])
    // Same dedup identity: the old order (dedup before trust) dropped the user copy.
    expect(dedupKey(ok[0] as CanonicalHook)).toBe(dedupKey(ok[1] as CanonicalHook))
    const r = await e.dispatch("tool.willInvoke", bash("rm -rf /"))
    expect(r).toMatchObject({ halt: true, reason: expect.stringContaining("Blocked: rm -rf") })
    expect(await e.dispatch("tool.willInvoke", bash("ls"))).toBeUndefined()
  })

  test("a trusted project copy still runs only once: the user copy wins", async () => {
    const guard = guardScript()
    sb.write(userNative(), nativeConfig("tool.willInvoke", [guard], {}, "Bash"))
    sb.write(projectNative(), nativeConfig("tool.willInvoke", [guard], {}, "Bash"))
    const e = new HooksEngine({
      cwd: sb.project,
      env: { ...sb.env, MA_TRUST_HOOKS: "1" },
      adapters: [nativeAdapter],
    })
    const scopes = e.active.map((h) => h.source.scope)
    expect(scopes).toEqual(["user"])
    expect(await e.dispatch("tool.willInvoke", bash("rm -rf /"))).toMatchObject({ halt: true })
  })

  test("dedupHooks: user beats an earlier project copy, plugin copies stay", () => {
    const mk = (scope: "user" | "project" | "plugin", i: number): CanonicalHook =>
      ({
        dialect: "native",
        channel: "tool.willInvoke",
        handler: { type: "command", command: "g" },
        timeoutMs: 1000,
        async: false,
        failClosed: false,
        source: { id: `s${i}`, path: `/p${i}`, scope, precedence: i },
      }) as unknown as CanonicalHook
    const [p, u, pl] = [mk("project", 0), mk("user", 1), mk("plugin", 2)]
    expect(dedupHooks([p, u, pl]).kept).toEqual([u, pl])
  })

  test("dedup key covers failClosed, async and the handler env", () => {
    const base = {
      channel: "tool.willInvoke",
      handler: { type: "command", command: "g" },
      timeoutMs: 1000,
      async: false,
      failClosed: false,
    } as unknown as CanonicalHook
    const k = dedupKey(base)
    expect(dedupKey({ ...base, failClosed: true })).not.toBe(k)
    expect(dedupKey({ ...base, async: true })).not.toBe(k)
    expect(
      dedupKey({ ...base, handler: { type: "command", command: "g", env: { A: "1" } } }),
    ).not.toBe(k)
  })
})

describe("B3 MAJOR 2: per-channel rewrite allow-list", () => {
  test("allow-list values", () => {
    expect(rewritableKeys("tool.willInvoke")).toEqual(["input"])
    expect(rewritableKeys("turn.willStart")).toEqual(["text"])
    expect(rewritableKeys("tool.didInvoke")).toEqual([])
    expect(rewritableKeys("toString")).toEqual([])
  })

  test("a native patch with sid, agentId, cwd and tool changes only input", async () => {
    const patch = {
      decision: "allow",
      payload: {
        sid: "evil",
        agentId: "evil",
        cwd: "/evil",
        tool: "Write",
        input: { command: "x" },
      },
    }
    sb.write(userNative(), nativeConfig("tool.willInvoke", [`echo '${JSON.stringify(patch)}'`]))
    const e = engine()
    const r = await e.dispatch("tool.willInvoke", bash("ls"))
    expect(r).toEqual({ payload: { ...bash("ls"), input: { command: "x" } } })
    await e.dispatch("tool.willInvoke", bash("ls"))
    const ignored = logs.filter((l) => l.includes("ignored payload keys"))
    expect(ignored.length).toBe(1)
    expect(ignored[0]).toContain("sid, agentId, cwd, tool")
  })

  test("a lower-rank rewrite is not applied when a higher-rank decision wins", async () => {
    sb.write(
      userNative(),
      nativeConfig("tool.willInvoke", [
        `echo '{"decision":"allow","payload":{"input":{"command":"low"}}}'`,
        `echo '{"decision":"ask","reason":"check","payload":{"input":{"command":"high"}}}'`,
      ]),
    )
    const r = await engine().dispatch("tool.willInvoke", bash("ls"))
    expect(r).toMatchObject({ halt: true, payload: { input: { command: "high" } } })
    const m = mergeResults([
      { decision: "allow", context: [], payload: { input: 1 } },
      { decision: "ask", context: [] },
    ])
    expect(m.payload).toBeUndefined()
  })

  test("turn.willStart text rewrite works, other keys are ignored", async () => {
    sb.write(
      userNative(),
      nativeConfig("turn.willStart", [`echo '{"payload":{"text":"new","sid":"evil"}}'`]),
    )
    const r = await engine().dispatch("turn.willStart", { text: "old", sid: "sid-1" })
    expect(r).toEqual({ payload: { text: "new", sid: "sid-1" } })
  })

  test("a channel with an empty allow-list ignores patches", async () => {
    sb.write(userNative(), nativeConfig("tool.didInvoke", [`echo '{"payload":{"output":"x"}}'`]))
    const payload = { tool: "Bash", toolUseId: "t1", output: "real", cwd: sb.project }
    expect(await engine().dispatch("tool.didInvoke", payload)).toBeUndefined()
    expect(logs.some((l) => l.includes("ignored payload keys output (context only)"))).toBe(true)
  })

  test("Claude updatedInput goes through the same allow-list", async () => {
    const out = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { command: "safe" },
      },
    }
    sb.write(
      userClaude(),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: `echo '${JSON.stringify(out)}'` }],
            },
          ],
        },
      }),
    )
    const r = await engine().dispatch("tool.willInvoke", bash("ls"))
    expect(r).toEqual({ payload: { ...bash("ls"), input: { command: "safe" } } })
  })
})
