import { describe, expect, test } from "bun:test"

import { runAdapterContract } from "../engine/adapter-contract.ts"
import type { RunOutcome, SourceRef } from "../engine/types.ts"

import {
  decodeNative,
  discoverNative,
  encodeNative,
  nativeAdapter,
  nativeMatcher,
  parseNative,
} from "./adapter.ts"

runAdapterContract(() => ({
  adapter: nativeAdapter,
  fixtures: {
    validConfig: JSON.stringify({
      hooks: { "tool.willInvoke": [{ matcher: "Bash", hooks: [{ command: "true" }] }] },
    }),
    unsupportedEventConfig: JSON.stringify({
      hooks: { "no.suchChannel": [{ hooks: [{ command: "true" }] }] },
    }),
    unsupportedTypeConfig: JSON.stringify({
      hooks: { "tool.willInvoke": [{ hooks: [{ type: "prompt", prompt: "x" }] }] },
    }),
    sample: { channel: "tool.willInvoke", payload: { tool: "Bash", input: { command: "ls" } } },
    blockingChannel: "tool.willInvoke",
  },
}))

const src: SourceRef = { id: "user", path: "/h/hooks.json", scope: "user", precedence: 0 }
const run = (o: Partial<RunOutcome>): RunOutcome => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  durationMs: 1,
  ...o,
})

describe("native discovery", () => {
  test("order: user, project, project-local, then plugins", () => {
    const list = discoverNative({
      home: "/h",
      agentHome: "/h/.minimal-agent",
      projectRoot: "/p",
      plugins: [{ name: "a", root: "/pl/a", dataDir: "/d/a" }],
    })
    expect(list.map((s) => s.path)).toEqual([
      "/h/.minimal-agent/hooks.json",
      "/p/.minimal-agent/hooks.json",
      "/p/.minimal-agent/hooks.local.json",
      "/pl/a/hooks/hooks.json",
    ])
    expect(list.map((s) => s.scope)).toEqual(["user", "project", "project", "plugin"])
    expect(list[3]?.pluginData).toBe("/d/a")
  })
})

describe("native parse", () => {
  test("reads disableAllHooks and the disable list", () => {
    const r = parseNative(src, JSON.stringify({ disableAllHooks: true, disable: ["claude:x", 3] }))
    expect(r.disableAll).toBe(true)
    expect(r.disable).toEqual(["claude:x"])
  })

  test("timeout is seconds, exec form keeps args, trust key shape", () => {
    const r = parseNative(
      src,
      JSON.stringify({
        hooks: {
          "turn.willStart": [{ hooks: [{ command: "/bin/echo", args: ["a b"], timeout: 2 }] }],
        },
      }),
    )
    const h = r.hooks[0]
    expect(h?.timeoutMs).toBe(2000)
    expect(h?.handler).toEqual({ type: "command", command: "/bin/echo", args: ["a b"] })
    expect(h?.trustKey).toMatch(/^native:user:turn\.willStart:[0-9a-f]{8}$/)
  })

  test("new seams turn.willStop and session.willStart parse as supported", () => {
    const r = parseNative(
      src,
      JSON.stringify({
        hooks: {
          "turn.willStop": [{ hooks: [{ command: "true" }] }],
          "session.willStart": [{ matcher: "startup", hooks: [{ command: "true" }] }],
        },
      }),
    )
    expect(r.hooks.map((h) => h.support)).toEqual(["ok", "ok"])
  })

  test("JSONC comments are accepted", () => {
    const r = parseNative(
      src,
      '{ // c\n "hooks": { "tool.didInvoke": [{ "hooks": [{ "command": "true" }] }] } }',
    )
    expect(r.hooks.length).toBe(1)
  })
})

describe("native matcher", () => {
  test("regex on tool name, unanchored and case-sensitive", () => {
    const m = nativeMatcher("tool.willInvoke", "Edit|Write").fn
    expect(m({ channel: "tool.willInvoke", payload: { tool: "Write" } })).toBe(true)
    expect(m({ channel: "tool.willInvoke", payload: { tool: "MultiEdit" } })).toBe(true)
    expect(m({ channel: "tool.willInvoke", payload: { tool: "write" } })).toBe(false)
  })

  test("star, empty and omitted match all", () => {
    for (const x of ["*", "", undefined]) {
      expect(
        nativeMatcher("tool.willInvoke", x).fn({ channel: "tool.willInvoke", payload: {} }),
      ).toBe(true)
    }
  })

  test("source for session.willStart, reason for compact", () => {
    expect(
      nativeMatcher("session.willStart", "^resume$").fn({
        channel: "session.willStart",
        payload: { source: "resume" },
      }),
    ).toBe(true)
    expect(
      nativeMatcher("compact.willRun", "auto").fn({
        channel: "compact.willRun",
        payload: { reason: "manual" },
      }),
    ).toBe(false)
  })

  test("bad regex matches nothing and reports an error", () => {
    const m = nativeMatcher("tool.willInvoke", "(")
    expect(m.error).toBeDefined()
    expect(m.fn({ channel: "tool.willInvoke", payload: { tool: "(" } })).toBe(false)
  })
})

describe("native encode", () => {
  test("envelope maps agentMode to mode and sets MA_ env", () => {
    const h = parseNative(
      { ...src, scope: "plugin", pluginRoot: "/pl", pluginData: "/pd" },
      JSON.stringify({ hooks: { "tool.willInvoke": [{ hooks: [{ command: "true" }] }] } }),
    ).hooks[0]
    if (!h) throw new Error("no hook")
    const { stdin, env } = encodeNative(
      h,
      "tool.willInvoke",
      { tool: "Bash" },
      { sid: "s", cwd: "/c", projectDir: "/p", agentMode: "ask", agentId: "A1", leadSid: "L" },
    )
    expect(JSON.parse(stdin)).toEqual({
      channel: "tool.willInvoke",
      payload: { tool: "Bash" },
      sid: "s",
      cwd: "/c",
      projectDir: "/p",
      mode: "ask",
      agentId: "A1",
      leadSid: "L",
    })
    expect(env).toEqual({
      MA_PROJECT_DIR: "/p",
      MA_SESSION_ID: "s",
      MA_CHANNEL: "tool.willInvoke",
      MA_PLUGIN_ROOT: "/pl",
      MA_PLUGIN_DATA: "/pd",
    })
  })
})

describe("native decode", () => {
  const h = parseNative(
    src,
    JSON.stringify({ hooks: { "tool.willInvoke": [{ hooks: [{ command: "true" }] }] } }),
  ).hooks[0]
  if (!h) throw new Error("no hook")

  test("exit 2 denies on blocking channels with stderr reason", () => {
    const r = decodeNative(h, "tool.willInvoke", run({ exitCode: 2, stderr: "nope\n" }))
    expect(r).toEqual({ decision: "deny", reason: "nope", context: [] })
  })

  test("exit 2 on feedback-only channel gives context", () => {
    const r = decodeNative(h, "tool.didInvoke", run({ exitCode: 2, stderr: "lint failed" }))
    expect(r).toEqual({ decision: "none", context: ["lint failed"] })
  })

  test("other exit codes are non-blocking errors", () => {
    const r = decodeNative(h, "tool.willInvoke", run({ exitCode: 3, stderr: "boom" }))
    expect(r.decision).toBe("none")
    expect(r.error).toContain("exit 3")
  })

  test("exit 0 JSON result is taken as-is", () => {
    const r = decodeNative(
      h,
      "tool.willInvoke",
      run({
        stdout: JSON.stringify({
          decision: "allow",
          payload: { input: { command: "ls -la" } },
          context: ["c1"],
          message: "hi",
        }),
      }),
    )
    expect(r).toEqual({
      decision: "allow",
      payload: { input: { command: "ls -la" } },
      context: ["c1"],
      userMessage: "hi",
    })
  })

  test("plain text is context on turn.willStart and session.willStart only", () => {
    expect(decodeNative(h, "turn.willStart", run({ stdout: "ctx" })).context).toEqual(["ctx"])
    expect(decodeNative(h, "session.willStart", run({ stdout: "ctx" })).context).toEqual(["ctx"])
    expect(decodeNative(h, "tool.willInvoke", run({ stdout: "ctx" })).context).toEqual([])
  })

  test("turn.willStop: exit 2 denies (keeps the loop going) with reason", () => {
    const r = decodeNative(h, "turn.willStop", run({ exitCode: 2, stderr: "tests fail" }))
    expect(r).toEqual({ decision: "deny", reason: "tests fail", context: [] })
  })

  test("turn.willStop: JSON deny plus context", () => {
    const r = decodeNative(
      h,
      "turn.willStop",
      run({ stdout: JSON.stringify({ decision: "deny", reason: "go on", context: ["more"] }) }),
    )
    expect(r).toEqual({ decision: "deny", reason: "go on", context: ["more"] })
  })

  test("session.willStart: exit 2 cannot block, stderr becomes context", () => {
    const r = decodeNative(h, "session.willStart", run({ exitCode: 2, stderr: "warn" }))
    expect(r).toEqual({ decision: "none", context: ["warn"] })
  })

  test("continue:false becomes stopTurn", () => {
    const r = decodeNative(
      h,
      "tool.didBatch",
      run({ stdout: JSON.stringify({ continue: false, reason: "enough" }) }),
    )
    expect(r.stopTurn).toEqual({ reason: "enough" })
  })

  test("timeout is a non-blocking error", () => {
    const r = decodeNative(
      h,
      "tool.willInvoke",
      run({ exitCode: null, timedOut: true, error: "timed out" }),
    )
    expect(r.decision).toBe("none")
    expect(r.error).toBe("timed out")
  })
})
