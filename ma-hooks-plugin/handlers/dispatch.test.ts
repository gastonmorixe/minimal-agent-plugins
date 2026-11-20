import { readFileSync } from "node:fs"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import type { HookHandlerContext } from "@minimal-agent/core/plugin-api/types/plugin"

import { makeSandbox, nativeConfig, type Sandbox } from "../engine/test-support.ts"
import manifest from "../manifest.json"

import dispatch, { engineFor, resetEngine } from "./dispatch.ts"

let sb: Sandbox | undefined
const saved = { HOME: process.env.HOME, MINIMAL_AGENT_HOME: process.env.MINIMAL_AGENT_HOME }

afterEach(() => {
  sb?.cleanup()
  sb = undefined
  resetEngine()
  process.env.HOME = saved.HOME
  if (saved.MINIMAL_AGENT_HOME === undefined) delete process.env.MINIMAL_AGENT_HOME
  else process.env.MINIMAL_AGENT_HOME = saved.MINIMAL_AGENT_HOME
})

function ctx(
  channel: string,
  cwd: string,
  sessionId?: string,
  emitted?: Array<{ channel: string; payload: unknown }>,
): HookHandlerContext {
  const noop = () => {}
  const emit = emitted
    ? (c: string, p?: unknown) => {
        emitted.push({ channel: c, payload: p })
      }
    : noop
  return {
    ...(sessionId ? { agent: { sessionId, pid: 1, model: "m", version: "0" } } : {}),
    channel,
    packageDir: "/pkg",
    cwd,
    env: {},
    abort: new AbortController().signal,
    priority: 50,
    countdown: async () => "elapsed",
    emit,
    log: {
      emergency: noop,
      alert: noop,
      critical: noop,
      error: noop,
      warn: noop,
      notice: noop,
      info: noop,
      debug: noop,
    },
  }
}

describe("manifest", () => {
  const phase1 = [
    "turn.willStart",
    "tool.willInvoke",
    "tool.didInvoke",
    "tool.didBatch",
    "compact.willRun",
    "compact.didRun",
    "subagent.willSpawn",
    "agent.willStop",
    "cwd.didChange",
    "instructions.didLoad",
    "notification.emit",
    "turn.willStop",
    "session.willStart",
  ]

  test("id hooks, on by default, every channel with a matching permission", () => {
    expect(manifest.id).toBe("hooks")
    expect("enabled" in manifest).toBe(false)
    // startup.rows uses its own handler (handlers/startup-rows.test.ts).
    const all = [...phase1, "startup.rows"]
    expect(manifest.headless.hooks.map((h) => h.channel)).toEqual(all)
    expect(manifest.permissions).toEqual(all.map((c) => `hooks:${c}`))
    for (const h of manifest.headless.hooks.filter((x) => x.channel !== "startup.rows")) {
      expect(h.handler).toEqual({
        type: "module",
        path: "./handlers/dispatch.ts",
        export: "default",
      })
      expect(h.id).toMatch(/^[a-z0-9][a-z0-9_-]*$/)
    }
  })

  test("the new core seams turn.willStop and session.willStart are registered", () => {
    const chans = manifest.headless.hooks.map((h) => h.channel)
    expect(chans).toContain("turn.willStop")
    expect(chans).toContain("session.willStart")
    expect(manifest.permissions).toContain("hooks:turn.willStop")
    expect(manifest.permissions).toContain("hooks:session.willStart")
  })
})

/** Temp HOME with no MINIMAL_AGENT_HOME override. */
function homeSandbox(): Sandbox {
  const s = makeSandbox()
  process.env.HOME = s.home
  delete process.env.MINIMAL_AGENT_HOME
  delete process.env.MA_TRUST_HOOKS
  return s
}

/** `~/.claude/settings.json` text with one command hook on one event. */
function claudeSettings(event: string, command: string): string {
  return JSON.stringify({ hooks: { [event]: [{ hooks: [{ type: "command", command }] }] } })
}

function readJsonLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

describe("turn.willStop end to end", () => {
  const stop = (stopHookActive: boolean) => ({
    lastAssistantText: "done",
    stopHookActive,
    sid: "S1",
  })

  test("Claude Stop block halts with the reason, stop_hook_active reaches stdin", async () => {
    sb = homeSandbox()
    const log = join(sb.root, "stop-stdin.jsonl")
    const script = sb.script(
      "stop.sh",
      `cat >> ${log}; echo >> ${log}; echo '{"decision":"block","reason":"run the tests"}'`,
    )
    sb.write(join(sb.home, ".claude", "settings.json"), claudeSettings("Stop", script))
    const r1 = await dispatch(stop(false), ctx("turn.willStop", sb.project, "S1"))
    expect(r1).toEqual({ halt: true, reason: "run the tests", payload: stop(false) })
    const r2 = await dispatch(stop(true), ctx("turn.willStop", sb.project, "S1"))
    expect(r2).toMatchObject({ halt: true, reason: "run the tests" })
    const seen = readJsonLines(log)
    expect(seen.map((s) => s.stop_hook_active)).toEqual([false, true])
    expect(seen[0]?.hook_event_name).toBe("Stop")
    expect(seen[0]?.last_assistant_message).toBe("done")
  })

  test("native turn.willStop deny halts, stopHookActive reaches stdin", async () => {
    sb = homeSandbox()
    const log = join(sb.root, "native-stop.jsonl")
    sb.write(
      join(sb.agentHome, "hooks.json"),
      nativeConfig("turn.willStop", [
        `cat >> ${log}; echo >> ${log}; echo '{"decision":"deny","reason":"keep going"}'`,
      ]),
    )
    const r1 = await dispatch(stop(false), ctx("turn.willStop", sb.project, "S1"))
    expect(r1).toEqual({ halt: true, reason: "keep going", payload: stop(false) })
    await dispatch(stop(true), ctx("turn.willStop", sb.project, "S1"))
    const seen = readJsonLines(log)
    expect(seen.map((s) => (s.payload as { stopHookActive: boolean }).stopHookActive)).toEqual([
      false,
      true,
    ])
    expect(seen[0]?.channel).toBe("turn.willStop")
  })
})

describe("session.willStart end to end", () => {
  const start = { source: "startup", sid: "S1", cwd: "", model: "m" }

  test("Claude SessionStart additionalContext reaches the result", async () => {
    sb = homeSandbox()
    const out = JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "repo facts" },
    })
    const script = sb.script("start.sh", `cat > /dev/null; echo '${out}'`)
    sb.write(join(sb.home, ".claude", "settings.json"), claudeSettings("SessionStart", script))
    const p = { ...start, cwd: sb.project }
    const r = await dispatch(p, ctx("session.willStart", sb.project, "S1"))
    expect(r).toEqual({ payload: p, additionalContext: ["repo facts"] })
  })

  test("Claude SessionStart cannot block: exit 2 and decision block do not halt", async () => {
    sb = homeSandbox()
    const exit2 = sb.script("exit2.sh", "cat > /dev/null; echo no >&2; exit 2")
    const block = sb.script(
      "block.sh",
      `cat > /dev/null; echo '{"decision":"block","reason":"no"}'`,
    )
    const p = { ...start, cwd: sb.project }
    for (const script of [exit2, block]) {
      resetEngine()
      sb.write(join(sb.home, ".claude", "settings.json"), claudeSettings("SessionStart", script))
      const r = await dispatch(p, ctx("session.willStart", sb.project, "S1"))
      expect(r === undefined || !("halt" in r)).toBe(true)
    }
  })

  test("native session.willStart: plain stdout is context, deny and exit 2 do not halt", async () => {
    sb = homeSandbox()
    const p = { ...start, cwd: sb.project }
    sb.write(join(sb.agentHome, "hooks.json"), nativeConfig("session.willStart", ["echo ctx-1"]))
    expect(await dispatch(p, ctx("session.willStart", sb.project, "S1"))).toEqual({
      payload: p,
      additionalContext: ["ctx-1"],
    })
    for (const cmd of [`echo '{"decision":"deny","reason":"no"}'`, "echo no >&2; exit 2"]) {
      resetEngine()
      sb.write(join(sb.agentHome, "hooks.json"), nativeConfig("session.willStart", [cmd]))
      const r = await dispatch(p, ctx("session.willStart", sb.project, "S1"))
      expect(r === undefined || !("halt" in r)).toBe(true)
    }
  })
})

describe("transcript_path", () => {
  test("Claude stdin carries <agent home>/sessions/<sid>.jsonl from a temp HOME", async () => {
    sb = homeSandbox()
    const log = join(sb.root, "tp.jsonl")
    const script = sb.script("tp.sh", `cat >> ${log}; echo >> ${log}`)
    sb.write(join(sb.home, ".claude", "settings.json"), claudeSettings("UserPromptSubmit", script))
    await dispatch({ text: "hi" }, ctx("turn.willStart", sb.project, "S9"))
    const want = join(sb.home, ".minimal-agent", "sessions", "S9.jsonl")
    expect(readJsonLines(log)[0]?.transcript_path).toBe(want)
  })

  test("MINIMAL_AGENT_HOME moves the transcript path", async () => {
    sb = homeSandbox()
    const alt = join(sb.root, "alt-home")
    process.env.MINIMAL_AGENT_HOME = alt
    const log = join(sb.root, "tp2.jsonl")
    const script = sb.script("tp2.sh", `cat >> ${log}; echo >> ${log}`)
    sb.write(join(sb.home, ".claude", "settings.json"), claudeSettings("SessionEnd", script))
    await dispatch({ reason: "other" }, ctx("agent.willStop", sb.project, "S7"))
    expect(readJsonLines(log)[0]?.transcript_path).toBe(join(alt, "sessions", "S7.jsonl"))
  })
})

describe("dispatch handler", () => {
  test("runs a user hook from a temp HOME through the default export", async () => {
    sb = makeSandbox()
    process.env.HOME = sb.home
    delete process.env.MINIMAL_AGENT_HOME
    const out = join(sb.root, "seen.json")
    sb.write(
      join(sb.agentHome, "hooks.json"),
      nativeConfig("tool.willInvoke", [`cat > ${out}; echo blocked >&2; exit 2`], {}, "Bash"),
    )
    const payload = { tool: "Bash", toolUseId: "t", input: { command: "ls" }, cwd: sb.project }
    const r = await dispatch(payload, ctx("tool.willInvoke", sb.project))
    expect(r).toEqual({ halt: true, reason: "blocked", payload })
    expect(JSON.parse(readFileSync(out, "utf8")).channel).toBe("tool.willInvoke")
  })

  test("MAJOR 1: async output is keyed by session and survives a cwd change", async () => {
    sb = makeSandbox()
    process.env.HOME = sb.home
    delete process.env.MINIMAL_AGENT_HOME
    sb.write(
      join(sb.agentHome, "hooks.json"),
      nativeConfig("turn.willStart", [
        { command: `test "$MA_SESSION_ID" = A && echo for-A`, async: true },
      ]),
    )
    const other = join(sb.root, "other")
    sb.write(join(other, ".git", "HEAD"), "x")
    // Session A starts the async hook. Session B shares the cwd.
    expect(await dispatch({ text: "a" }, ctx("turn.willStart", sb.project, "A"))).toBeUndefined()
    await engineFor(sb.project).asyncQueue.idle()
    const b = await dispatch({ text: "b" }, ctx("turn.willStart", sb.project, "B"))
    expect(b).toBeUndefined()
    // A moves to another cwd: a new engine, but the queued output stays.
    sb.write(join(sb.agentHome, "hooks.json"), JSON.stringify({ hooks: {} }))
    const a2 = await dispatch({ text: "a2" }, ctx("turn.willStart", other, "A"))
    expect(a2).toEqual({ payload: { text: "a2" }, additionalContext: ["for-A"] })
  })
})

describe("untrusted hook notice", () => {
  function setup(): Sandbox {
    const s = makeSandbox()
    process.env.HOME = s.home
    delete process.env.MINIMAL_AGENT_HOME
    delete process.env.MA_TRUST_HOOKS
    s.write(
      join(s.project, ".minimal-agent", "hooks.json"),
      nativeConfig("tool.didInvoke", ["echo project-hook"]),
    )
    return s
  }
  const payload = { tool: "Bash", input: {}, ok: true }

  test("MAJOR 2: one notice per session, and again for a new session", async () => {
    sb = setup()
    const seen: Array<{ channel: string; payload: unknown }> = []
    await dispatch(payload, ctx("tool.didInvoke", sb.project, "S1", seen))
    await dispatch(payload, ctx("tool.didInvoke", sb.project, "S1", seen))
    expect(seen.length).toBe(1)
    const n = seen[0]?.payload as { source: string; text: string; block: { body: string[] } }
    expect(seen[0]?.channel).toBe("notification.emit")
    expect(n.source).toBe("hooks")
    expect(n.text).toContain("native tool.didInvoke")
    expect(n.text).toContain(join(sb.project, ".minimal-agent", "hooks.json"))
    expect(n.text).toContain("echo project-hook")
    expect(n.text).toContain("MA_TRUST_HOOKS=1")
    expect(n.block.body.length).toBeGreaterThan(0)
    await dispatch(payload, ctx("tool.didInvoke", sb.project, "S2", seen))
    expect(seen.length).toBe(2)
  })

  test("MAJOR 2: no notice when MA_TRUST_HOOKS=1 trusts all hooks", async () => {
    sb = setup()
    process.env.MA_TRUST_HOOKS = "1"
    try {
      const seen: Array<{ channel: string; payload: unknown }> = []
      await dispatch(payload, ctx("tool.didInvoke", sb.project, "S1", seen))
      expect(seen).toEqual([])
    } finally {
      delete process.env.MA_TRUST_HOOKS
    }
  })
})
