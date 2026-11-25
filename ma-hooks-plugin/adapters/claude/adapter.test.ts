import { chmodSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { runAdapterContract } from "../../engine/adapter-contract.ts"
import { loadHooksConfig } from "../../engine/config.ts"
import { HooksEngine } from "../../engine/engine.ts"
import { hookIdentityHash } from "../../engine/hash.ts"
import { selectAdapters } from "../../engine/registry.ts"
import { makeSandbox, nativeConfig, type Sandbox } from "../../engine/test-support.ts"
import type { CanonicalHook, RunOutcome, SourceRef } from "../../engine/types.ts"

import { claudeAdapter, discoverClaude, encodeClaude, parseClaude } from "./adapter.ts"
import { decodeClaudeOutcome } from "./decode.ts"
import { claudePermissionMode } from "./events.ts"
import { bashIfMatches, compileClaudeMatcher, splitBashSubcommands } from "./matcher.ts"

const claudeConfig = (
  event: string,
  hooks: Array<Record<string, unknown>>,
  matcher?: string,
  extra: Record<string, unknown> = {},
) => JSON.stringify({ hooks: { [event]: [{ ...(matcher ? { matcher } : {}), hooks }] }, ...extra })

runAdapterContract(() => ({
  adapter: claudeAdapter,
  fixtures: {
    validConfig: claudeConfig("PreToolUse", [{ type: "command", command: "true" }], "Bash"),
    unsupportedEventConfig: claudeConfig("TeammateIdle", [{ type: "command", command: "true" }]),
    unsupportedTypeConfig: claudeConfig("PreToolUse", [{ type: "prompt", prompt: "x" }]),
    sample: {
      channel: "tool.willInvoke",
      payload: { tool: "Bash", toolUseId: "t1", input: { command: "ls" }, cwd: "/p" },
    },
    blockingChannel: "tool.willInvoke",
  },
}))

const src: SourceRef = {
  id: "user",
  path: "/h/.claude/settings.json",
  scope: "user",
  precedence: 0,
}
const run = (o: Partial<RunOutcome>): RunOutcome => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  durationMs: 1,
  ...o,
})
const one = (text: string): CanonicalHook => {
  const h = parseClaude(src, text).hooks[0]
  if (!h) throw new Error("no hook")
  return h
}
const tw = (tool: string, input: Record<string, unknown> = {}, cwd = "/p") => ({
  channel: "tool.willInvoke",
  payload: { tool, toolUseId: "t1", input, cwd },
})

describe("claude discovery and parse", () => {
  test("sources: user, project, project-local settings", () => {
    const list = discoverClaude({ home: "/h", agentHome: "/h/.ma", projectRoot: "/p", plugins: [] })
    expect(list.map((s) => s.path)).toEqual([
      "/h/.claude/settings.json",
      "/p/.claude/settings.json",
      "/p/.claude/settings.local.json",
    ])
    expect(list.map((s) => s.scope)).toEqual(["user", "project", "project"])
  })

  test("project root = home: the user settings file is not also a project source", () => {
    const list = discoverClaude({ home: "/h", agentHome: "/h/.ma", projectRoot: "/h", plugins: [] })
    expect(list.map((s) => `${s.id}:${s.path}`)).toEqual([
      "user:/h/.claude/settings.json",
      "project-local:/h/.claude/settings.local.json",
    ])
  })

  test("event map, onFailure block, timeout seconds, unsupported types", () => {
    const r = parseClaude(
      src,
      JSON.stringify({
        disableAllHooks: true,
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: "command", command: "a" }] }],
          PostToolUseFailure: [{ hooks: [{ type: "command", command: "b", onFailure: "block" }] }],
          Stop: [{ hooks: [{ type: "command", command: "c", timeout: 5 }] }],
          SessionStart: [{ hooks: [{ type: "agent", prompt: "x" }] }],
          PreToolUse: [{ hooks: [{ type: "mcp_tool", server: "s", tool: "t" }] }],
          Setup: [{ hooks: [{ type: "command", command: "d" }] }],
        },
      }),
    )
    expect(r.disableAll).toBe(true)
    const by = Object.fromEntries(r.hooks.map((h) => [h.dialectEvent, h]))
    expect(by.UserPromptSubmit?.channel).toBe("turn.willStart")
    expect(by.UserPromptSubmit?.timeoutMs).toBe(30_000)
    expect(by.PostToolUseFailure?.channel).toBe("tool.didInvoke")
    expect(by.PostToolUseFailure?.failClosed).toBe(true)
    expect(by.Stop?.channel).toBe("turn.willStop")
    expect(by.Stop?.timeoutMs).toBe(5000)
    expect(by.SessionStart?.support).toBe("unsupported-type")
    expect(by.PreToolUse?.support).toBe("unsupported-type")
    expect(by.Setup?.support).toBe("unsupported-event")
  })
})

describe("claude matchers", () => {
  test("exact, list, regex, all", () => {
    const m = compileClaudeMatcher
    expect(m("Bash").test("Bash")).toBe(true)
    expect(m("Bash").test("BashX")).toBe(false)
    expect(m("Edit|Write").test("Write")).toBe(true)
    expect(m("Edit, Write").test("Edit")).toBe(true)
    expect(m("Edit|Write").test("NotebookEdit")).toBe(false)
    expect(m("Edit.*").test("NotebookEdit")).toBe(true)
    expect(m("^Edit$").test("NotebookEdit")).toBe(false)
    expect(m("bash").test("Bash")).toBe(false)
    for (const all of [undefined, "", "*"]) expect(m(all).test("Anything")).toBe(true)
  })

  test("MCP names", () => {
    expect(compileClaudeMatcher("mcp__memory__.*").test("mcp__memory__create_entities")).toBe(true)
    expect(compileClaudeMatcher("mcp__memory").test("mcp__memory__create_entities")).toBe(false)
    expect(compileClaudeMatcher("mcp__.*__write.*").test("mcp__fs__write_file")).toBe(true)
  })

  test("matcher closure on tool events tests the tool name", () => {
    const h = one(claudeConfig("PreToolUse", [{ type: "command", command: "x" }], "Edit|Write"))
    expect(h.matches(tw("Edit", { file_path: "/p/a.ts" }))).toBe(true)
    expect(h.matches(tw("Bash", { command: "ls" }))).toBe(false)
  })

  test("PostToolUse vs PostToolUseFailure split on isError", () => {
    const ok = one(claudeConfig("PostToolUse", [{ type: "command", command: "x" }]))
    const fail = one(claudeConfig("PostToolUseFailure", [{ type: "command", command: "x" }]))
    const p = (isError: boolean) => ({
      channel: "tool.didInvoke",
      payload: { tool: "Bash", input: {}, cwd: "/p", ok: !isError, isError },
    })
    expect(ok.matches(p(false))).toBe(true)
    expect(ok.matches(p(true))).toBe(false)
    expect(fail.matches(p(true))).toBe(true)
    expect(fail.matches(p(false))).toBe(false)
  })

  test("Stop vs SubagentStop split on agentId", () => {
    const stop = one(claudeConfig("Stop", [{ type: "command", command: "x" }]))
    const sub = one(claudeConfig("SubagentStop", [{ type: "command", command: "x" }]))
    const lead = {
      channel: "turn.willStop",
      payload: { lastAssistantText: "", stopHookActive: false },
    }
    const worker = { channel: "turn.willStop", payload: { ...lead.payload, agentId: "A1" } }
    expect(stop.matches(lead)).toBe(true)
    expect(stop.matches(worker)).toBe(false)
    expect(sub.matches(worker)).toBe(true)
    expect(sub.matches(lead)).toBe(false)
  })

  test("if: Bash subcommands, assignments, $() and unsplittable input", () => {
    expect(bashIfMatches("git *", "FOO=bar git push")).toBe(true)
    expect(bashIfMatches("git *", "npm test && git push")).toBe(true)
    expect(bashIfMatches("rm *", "echo $(rm -rf /)")).toBe(true)
    expect(bashIfMatches("rm *", "echo $(date)")).toBe(false)
    expect(bashIfMatches("git push *", "echo $(date)")).toBe(true)
    expect(bashIfMatches("rm *", "npm test")).toBe(false)
    expect(bashIfMatches("rm *", "echo 'unterminated")).toBe(true)
    expect(splitBashSubcommands("a | b; c || d")).toEqual(["a", "b", "c", "d"])
  })

  test("if: Tool(glob) on hooks, file tools, and never on non-tool events", () => {
    const bash = one(
      claudeConfig("PreToolUse", [{ type: "command", command: "x", if: "Bash(rm *)" }], "Bash"),
    )
    expect(bash.matches(tw("Bash", { command: "rm -rf build" }))).toBe(true)
    expect(bash.matches(tw("Bash", { command: "npm test" }))).toBe(false)
    const ts = one(
      claudeConfig("PostToolUse", [{ type: "command", command: "x", if: "Edit(*.ts)" }]),
    )
    const did = (file: string) => ({
      channel: "tool.didInvoke",
      payload: { tool: "Edit", input: { file_path: file }, cwd: "/p", ok: true, isError: false },
    })
    expect(ts.matches(did("/p/src/a.ts"))).toBe(true)
    expect(ts.matches(did("/p/src/a.js"))).toBe(false)
    const src2 = one(
      claudeConfig("PreToolUse", [{ type: "command", command: "x", if: "Edit(src/**)" }]),
    )
    expect(src2.matches(tw("Edit", { file_path: "/p/src/deep/a.ts" }))).toBe(true)
    expect(src2.matches(tw("Edit", { file_path: "/p/lib/src/a.ts" }))).toBe(false)
    const toolOnly = one(
      claudeConfig("PreToolUse", [{ type: "command", command: "x", if: "Bash" }]),
    )
    expect(toolOnly.matches(tw("Bash", { command: "ls" }))).toBe(true)
    expect(toolOnly.matches(tw("Edit", {}))).toBe(false)
    const prompt = one(
      claudeConfig("UserPromptSubmit", [{ type: "command", command: "x", if: "Bash" }]),
    )
    expect(prompt.matches({ channel: "turn.willStart", payload: { text: "hi" } })).toBe(false)
  })
})

describe("claude decode", () => {
  const pre = "PreToolUse"
  test("exit 0 empty, exit 2 deny with stderr, other exit non-blocking", () => {
    expect(decodeClaudeOutcome(pre, run({}), false).decision).toBe("none")
    const d = decodeClaudeOutcome(pre, run({ exitCode: 2, stderr: "nope\n" }), false)
    expect(d).toMatchObject({ decision: "deny", reason: "nope" })
    const o = decodeClaudeOutcome(pre, run({ exitCode: 1, stderr: "boom\nmore" }), false)
    expect(o.decision).toBe("none")
    expect(o.error).toBe("exit 1: boom")
  })

  test("exit 2 on PostToolUse feeds stderr to the model, on SessionStart to the user", () => {
    const post = decodeClaudeOutcome(
      "PostToolUse",
      run({ exitCode: 2, stderr: "lint failed" }),
      false,
    )
    expect(post).toMatchObject({ decision: "none", context: ["lint failed"] })
    const ss = decodeClaudeOutcome("SessionStart", run({ exitCode: 2, stderr: "warn" }), false)
    expect(ss).toMatchObject({ decision: "none", context: [], userMessage: "warn" })
  })

  test("MINOR 9: exit 2 on Notification and InstructionsLoaded is ignored", () => {
    for (const ev of ["Notification", "InstructionsLoaded"]) {
      expect(decodeClaudeOutcome(ev, run({ exitCode: 2, stderr: "warn" }), false)).toEqual({
        decision: "none",
        context: [],
      })
    }
  })

  test("exit 2 JSON cannot override the block", () => {
    const stdout = JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } })
    expect(
      decodeClaudeOutcome(pre, run({ exitCode: 2, stdout, stderr: "x" }), false).decision,
    ).toBe("deny")
  })

  test("other exit with valid JSON: the fields decide, unless onFailure block", () => {
    const stdout = JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny" } })
    expect(decodeClaudeOutcome(pre, run({ exitCode: 1, stdout }), false).decision).toBe("deny")
    expect(decodeClaudeOutcome(pre, run({ exitCode: 1, stdout }), true).error).toContain("exit 1")
  })

  test("PreToolUse JSON: permissionDecision, reason, updatedInput, additionalContext", () => {
    const stdout = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: pre,
        permissionDecision: "allow",
        permissionDecisionReason: "ok",
        updatedInput: { command: "ls -la" },
        additionalContext: "prod",
      },
      suppressOutput: true,
    })
    expect(decodeClaudeOutcome(pre, run({ stdout }), false)).toEqual({
      decision: "allow",
      reason: "ok",
      payload: { input: { command: "ls -la" } },
      context: ["prod"],
    })
    const deny = JSON.stringify({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "bad" },
    })
    expect(decodeClaudeOutcome(pre, run({ stdout: deny }), false)).toMatchObject({
      decision: "deny",
      reason: "bad",
    })
    const defer = JSON.stringify({
      hookSpecificOutput: {
        permissionDecision: "defer",
        updatedInput: { command: "x" },
        additionalContext: "ignored",
      },
    })
    expect(decodeClaudeOutcome(pre, run({ stdout: defer }), false)).toEqual({
      decision: "ask",
      context: [],
    })
    const legacy = JSON.stringify({ decision: "block", reason: "old" })
    expect(decodeClaudeOutcome(pre, run({ stdout: legacy }), false)).toMatchObject({
      decision: "deny",
      reason: "old",
    })
  })

  test("universal fields: continue, stopReason, systemMessage", () => {
    const stdout = JSON.stringify({
      continue: false,
      stopReason: "build failed",
      systemMessage: "hi",
    })
    expect(decodeClaudeOutcome("UserPromptSubmit", run({ stdout }), false)).toMatchObject({
      stopTurn: { reason: "build failed" },
      userMessage: "hi",
    })
    expect(decodeClaudeOutcome("Notification", run({ stdout }), false).stopTurn).toBeUndefined()
  })

  test("decision block: blocks UserPromptSubmit, feeds back on PostToolUse", () => {
    const stdout = JSON.stringify({ decision: "block", reason: "why" })
    expect(decodeClaudeOutcome("UserPromptSubmit", run({ stdout }), false)).toMatchObject({
      decision: "deny",
      reason: "why",
    })
    expect(decodeClaudeOutcome("PostToolUse", run({ stdout }), false)).toMatchObject({
      decision: "none",
      context: ["why"],
    })
  })

  test("plain stdout: context on UserPromptSubmit and SessionStart only; bad JSON errors", () => {
    expect(
      decodeClaudeOutcome("UserPromptSubmit", run({ stdout: "ctx\n" }), false).context,
    ).toEqual(["ctx"])
    expect(decodeClaudeOutcome("SessionStart", run({ stdout: "ctx" }), false).context).toEqual([
      "ctx",
    ])
    expect(decodeClaudeOutcome(pre, run({ stdout: "ctx" }), false).context).toEqual([])
    expect(decodeClaudeOutcome(pre, run({ stdout: "[1]" }), false).error).toBeUndefined()
    expect(decodeClaudeOutcome(pre, run({ stdout: "{bad}" }), false).error).toContain("JSON")
  })

  test("turn.willStop (Stop/SubagentStop): block, exit 2, additionalContext continue", () => {
    const block = JSON.stringify({ decision: "block", reason: "run tests" })
    expect(decodeClaudeOutcome("Stop", run({ stdout: block }), false)).toMatchObject({
      decision: "deny",
      reason: "run tests",
    })
    expect(
      decodeClaudeOutcome("SubagentStop", run({ exitCode: 2, stderr: "keep going" }), false),
    ).toMatchObject({ decision: "deny", reason: "keep going" })
    const ctx = JSON.stringify({ hookSpecificOutput: { additionalContext: "lint first" } })
    expect(decodeClaudeOutcome("Stop", run({ stdout: ctx }), false)).toMatchObject({
      decision: "deny",
      reason: "lint first",
    })
    expect(decodeClaudeOutcome("Stop", run({}), false).decision).toBe("none")
  })

  test("session.willStart (SessionStart): additionalContext and plain text, never blocks", () => {
    const ctx = JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "branch main" },
    })
    expect(decodeClaudeOutcome("SessionStart", run({ stdout: ctx }), false)).toEqual({
      decision: "none",
      context: ["branch main"],
    })
    const block = JSON.stringify({ decision: "block", reason: "x" })
    expect(decodeClaudeOutcome("SessionStart", run({ stdout: block }), false).decision).toBe("none")
  })
})

describe("claude encode", () => {
  test("stdin field names and CLAUDE_PROJECT_DIR", () => {
    const h = one(claudeConfig("PreToolUse", [{ type: "command", command: "x" }]))
    const { stdin, env } = encodeClaude(
      h,
      "tool.willInvoke",
      { tool: "Bash", toolUseId: "tu1", input: { command: "ls" }, cwd: "/p/sub" },
      { sid: "s1", cwd: "/p/sub", projectDir: "/p", agentMode: "ask", transcriptPath: "/t.jsonl" },
    )
    expect(JSON.parse(stdin)).toEqual({
      session_id: "s1",
      transcript_path: "/t.jsonl",
      cwd: "/p/sub",
      permission_mode: "plan",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_use_id: "tu1",
    })
    expect(env).toEqual({ CLAUDE_PROJECT_DIR: "/p" })
  })

  test("permission_mode mapping", () => {
    expect(claudePermissionMode(undefined)).toBe("default")
    expect(claudePermissionMode("default")).toBe("default")
    expect(claudePermissionMode("ask")).toBe("plan")
    expect(claudePermissionMode("acceptEdits")).toBe("acceptEdits")
  })

  test("Stop, SessionStart and PreCompact fields", () => {
    const inv = { sid: "s", cwd: "/p", projectDir: "/p" }
    const stop = one(claudeConfig("Stop", [{ type: "command", command: "x" }]))
    const s = JSON.parse(
      encodeClaude(stop, "turn.willStop", { lastAssistantText: "done", stopHookActive: true }, inv)
        .stdin,
    )
    expect(s).toMatchObject({
      hook_event_name: "Stop",
      stop_hook_active: true,
      last_assistant_message: "done",
      permission_mode: "default",
    })
    const ss = one(claudeConfig("SessionStart", [{ type: "command", command: "x" }]))
    const p = { source: "startup", sid: "s", cwd: "/p", model: "m1" }
    const sj = JSON.parse(encodeClaude(ss, "session.willStart", p, inv).stdin)
    expect(sj).toMatchObject({ hook_event_name: "SessionStart", source: "startup", model: "m1" })
    expect(sj.permission_mode).toBeUndefined()
    const pc = one(claudeConfig("PreCompact", [{ type: "command", command: "x" }]))
    const pj = JSON.parse(encodeClaude(pc, "compact.willRun", { reason: "exceeded" }, inv).stdin)
    expect(pj.trigger).toBe("auto")
  })
})

describe("claude adapter in the engine (real files and scripts)", () => {
  let sb: Sandbox
  beforeEach(() => {
    sb = makeSandbox()
  })
  afterEach(() => {
    sb.cleanup()
  })
  const userSettings = () => join(sb.home, ".claude", "settings.json")
  const bashPayload = (command: string) => ({
    tool: "Bash",
    toolUseId: "t1",
    input: { command },
    cwd: sb.project,
    sid: "sid-1",
    agentMode: "default",
  })

  test("registry ships claude after native, and the engine loads it by default", () => {
    expect(selectAdapters(loadHooksConfig(sb.env)).map((a) => a.id)).toEqual(["native", "claude"])
    const e = new HooksEngine({ cwd: sb.project, env: sb.env })
    expect(e.sources.map((s) => `${s.adapter}:${s.source.id}`)).toContain("claude:project-local")
  })

  test("stdin capture and CLAUDE_PROJECT_DIR in a real run", async () => {
    const out = join(sb.root, "stdin.json")
    const envOut = join(sb.root, "env.txt")
    const script = sb.script("cap.sh", `cat > ${out}\necho "$CLAUDE_PROJECT_DIR" > ${envOut}`)
    sb.write(
      userSettings(),
      claudeConfig("PreToolUse", [{ type: "command", command: script }], "Bash"),
    )
    const e = new HooksEngine({ cwd: sb.project, env: sb.env })
    expect(await e.dispatch("tool.willInvoke", bashPayload("ls"))).toBeUndefined()
    const got = JSON.parse(readFileSync(out, "utf8"))
    expect(got).toMatchObject({
      session_id: "sid-1",
      cwd: sb.project,
      hook_event_name: "PreToolUse",
      permission_mode: "default",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_use_id: "t1",
    })
    expect(readFileSync(envOut, "utf8").trim()).toBe(sb.project)
  })

  test("exit 2 halts, JSON deny halts, updatedInput rewrites", async () => {
    const deny = sb.script("deny.sh", `echo "no rm" >&2\nexit 2`)
    const rewrite = sb.script(
      "rw.sh",
      `echo '{"hookSpecificOutput":{"permissionDecision":"allow","updatedInput":{"command":"ls -la"}}}'`,
    )
    sb.write(
      userSettings(),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: deny, if: "Bash(rm *)" }] },
            { matcher: "Bash", hooks: [{ type: "command", command: rewrite, if: "Bash(ls)" }] },
          ],
        },
      }),
    )
    const e = new HooksEngine({ cwd: sb.project, env: sb.env })
    expect(await e.dispatch("tool.willInvoke", bashPayload("rm -rf x"))).toMatchObject({
      halt: true,
      reason: "no rm",
    })
    const r = await e.dispatch("tool.willInvoke", bashPayload("ls"))
    expect(r).toMatchObject({ payload: { input: { command: "ls -la" } } })
  })

  test("permissionDecision precedence across hooks: deny, then defer/ask, then allow", async () => {
    const pd = (name: string, d: string) =>
      sb.script(
        name,
        `echo '{"hookSpecificOutput":{"permissionDecision":"${d}","permissionDecisionReason":"${d}"}}'`,
      )
    const cfg = (ds: string[]) =>
      claudeConfig(
        "PreToolUse",
        ds.map((d) => ({ type: "command", command: pd(`${d}.sh`, d) })),
        "Bash",
      )
    sb.write(userSettings(), cfg(["allow", "ask", "deny"]))
    let e = new HooksEngine({ cwd: sb.project, env: sb.env })
    expect(await e.dispatch("tool.willInvoke", bashPayload("ls"))).toMatchObject({
      halt: true,
      reason: "deny",
    })
    sb.write(userSettings(), cfg(["allow", "defer"]))
    e = new HooksEngine({ cwd: sb.project, env: sb.env })
    // defer maps to ask, and ask has no host prompt through the plugin API: halt.
    expect(await e.dispatch("tool.willInvoke", bashPayload("ls"))).toMatchObject({
      halt: true,
      reason: "defer",
    })
    sb.write(userSettings(), cfg(["allow"]))
    e = new HooksEngine({ cwd: sb.project, env: sb.env })
    expect(await e.dispatch("tool.willInvoke", bashPayload("ls"))).toBeUndefined()
  })

  test("hooks.adapters.claude=false: claude discovers nothing, native still runs", async () => {
    const log = join(sb.root, "ran.log")
    sb.write(
      join(sb.agentHome, "config.jsonc"),
      JSON.stringify({ plugins: { hooks: { adapters: { claude: false } } } }),
    )
    sb.write(
      join(sb.agentHome, "hooks.json"),
      nativeConfig("tool.willInvoke", [`echo n >> ${log}`]),
    )
    sb.write(
      userSettings(),
      claudeConfig("PreToolUse", [{ type: "command", command: `echo c >> ${log}` }]),
    )
    const e = new HooksEngine({ cwd: sb.project, env: sb.env, config: loadHooksConfig(sb.env) })
    expect(e.adapters.map((a) => a.id)).toEqual(["native"])
    expect(e.sources.some((s) => s.adapter === "claude")).toBe(false)
    await e.dispatch("tool.willInvoke", bashPayload("ls"))
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["n"])
  })

  test("dedup: an identical hook in native and claude config runs once, as native", async () => {
    const log = join(sb.root, "ran.log")
    const cmd = `echo "\${MA_CHANNEL:-claude}" >> ${log}`
    sb.write(join(sb.agentHome, "hooks.json"), nativeConfig("tool.willInvoke", [cmd], {}, "Bash"))
    sb.write(
      userSettings(),
      claudeConfig("PreToolUse", [{ type: "command", command: cmd }], "Bash"),
    )
    const e = new HooksEngine({ cwd: sb.project, env: sb.env })
    const both = e.all.filter((h) => h.support === "ok").map((h) => h.dialect)
    expect(both).toEqual(["native", "claude"])
    expect(e.active.map((h) => h.dialect)).toEqual(["native"])
    await e.dispatch("tool.willInvoke", bashPayload("ls"))
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["tool.willInvoke"])
  })

  const projectSettings = () => join(sb.project, ".claude", "settings.json")

  test("MAJOR 3: the Claude hash covers matcher, if, timeout and onFailure, not key order", () => {
    const src: SourceRef = {
      id: "project",
      path: projectSettings(),
      scope: "project",
      precedence: 1,
    }
    const hashOf = (text: string) => parseClaude(src, text).hooks[0]?.contentHash
    const base = { type: "command", command: "./g.sh", timeout: 5 }
    const h0 = hashOf(claudeConfig("PreToolUse", [base], "Bash"))
    expect(h0).toBeDefined()
    expect(hashOf(claudeConfig("PreToolUse", [base], "Edit"))).not.toBe(h0)
    expect(hashOf(claudeConfig("PreToolUse", [{ ...base, if: "Bash(git *)" }], "Bash"))).not.toBe(
      h0,
    )
    expect(hashOf(claudeConfig("PreToolUse", [{ ...base, timeout: 6 }], "Bash"))).not.toBe(h0)
    expect(hashOf(claudeConfig("PreToolUse", [{ ...base, onFailure: "block" }], "Bash"))).not.toBe(
      h0,
    )
    const reordered = { timeout: 5, command: "./g.sh", type: "command" }
    expect(hashOf(claudeConfig("PreToolUse", [reordered], "Bash"))).toBe(h0)
  })

  test("MINOR 3: an untrusted Claude project-scope hook does not run", async () => {
    const log = join(sb.root, "ran.log")
    sb.write(
      projectSettings(),
      claudeConfig("PreToolUse", [{ type: "command", command: `echo p >> ${log}; exit 2` }]),
    )
    sb.write(
      userSettings(),
      claudeConfig("PreToolUse", [{ type: "command", command: `echo u >> ${log}` }]),
    )
    const e = new HooksEngine({ cwd: sb.project, env: sb.env })
    expect(e.active.some((h) => h.trustKey.startsWith("claude:project:PreToolUse:"))).toBe(true)
    expect(await e.dispatch("tool.willInvoke", bashPayload("ls"))).toBeUndefined()
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["u"])
  })

  test("BLOCKER 1: project .claude disableAllHooks never turns off ~/.claude hooks", async () => {
    const log = join(sb.root, "ran.log")
    sb.write(
      userSettings(),
      claudeConfig("PreToolUse", [{ type: "command", command: `echo u >> ${log}` }]),
    )
    sb.write(projectSettings(), JSON.stringify({ disableAllHooks: true }))
    // Untrusted, then trusted: the user hook runs both times.
    await new HooksEngine({ cwd: sb.project, env: sb.env }).dispatch(
      "tool.willInvoke",
      bashPayload("ls"),
    )
    const trusted = { ...sb.env, MA_TRUST_HOOKS: "1" }
    await new HooksEngine({ cwd: sb.project, env: trusted }).dispatch(
      "tool.willInvoke",
      bashPayload("ls"),
    )
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["u", "u"])
  })

  test("MINOR 4: a native disable list silences a real Claude hook", async () => {
    const log = join(sb.root, "ran.log")
    sb.write(
      userSettings(),
      claudeConfig("PreToolUse", [
        { type: "command", command: `echo off >> ${log}; exit 2` },
        { type: "command", command: `echo on >> ${log}` },
      ]),
    )
    sb.write(
      join(sb.agentHome, "hooks.json"),
      JSON.stringify({
        disable: [
          `claude:user:PreToolUse:${hookIdentityHash({ handler: { type: "command", command: `echo off >> ${log}; exit 2` } })}`,
        ],
      }),
    )
    const e = new HooksEngine({ cwd: sb.project, env: sb.env })
    expect(e.all.filter((h) => h.dialect === "claude").length).toBe(2)
    expect(await e.dispatch("tool.willInvoke", bashPayload("ls"))).toBeUndefined()
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["on"])
  })

  test("MAJOR 5: exec form substitutes ${CLAUDE_PROJECT_DIR} in command and args", async () => {
    const cap = join(sb.root, "args.txt")
    sb.write(
      join(sb.project, ".claude", "hooks", "cap.sh"),
      `#!/bin/sh\nprintf '%s|' "$@" > ${cap}\n`,
    )
    chmodSync(join(sb.project, ".claude", "hooks", "cap.sh"), 0o755)
    sb.write(
      userSettings(),
      claudeConfig("PreToolUse", [
        {
          type: "command",
          command: "${CLAUDE_PROJECT_DIR}/.claude/hooks/cap.sh",
          args: ["${CLAUDE_PROJECT_DIR}/x", "${CLAUDE_PLUGIN_ROOT}", "$HOME"],
        },
      ]),
    )
    const e = new HooksEngine({ cwd: sb.project, env: sb.env })
    await e.dispatch("tool.willInvoke", bashPayload("ls"))
    // No plugin root for a settings source: that placeholder stays as written.
    expect(readFileSync(cap, "utf8")).toBe(`${sb.project}/x|\${CLAUDE_PLUGIN_ROOT}|$HOME|`)
  })

  test("claude disableAllHooks turns off claude only", async () => {
    const log = join(sb.root, "ran.log")
    sb.write(
      join(sb.agentHome, "hooks.json"),
      nativeConfig("tool.willInvoke", [`echo n >> ${log}`]),
    )
    sb.write(
      userSettings(),
      claudeConfig("PreToolUse", [{ type: "command", command: `echo c >> ${log}` }], undefined, {
        disableAllHooks: true,
      }),
    )
    const e = new HooksEngine({ cwd: sb.project, env: sb.env })
    await e.dispatch("tool.willInvoke", bashPayload("ls"))
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["n"])
  })
})

describe("parity fixture: REPORT.md 4.1 guard.py", () => {
  let sb: Sandbox
  beforeEach(() => {
    sb = makeSandbox()
  })
  afterEach(() => {
    sb.cleanup()
  })
  const fixtures = join(import.meta.dir, "fixtures")
  const guard = readFileSync(join(fixtures, "guard.py"), "utf8")
  const shim = readFileSync(join(fixtures, "native-to-claude.py"), "utf8")
  const bash = (command: string) => ({
    tool: "Bash",
    toolUseId: "t1",
    input: { command },
    cwd: sb.project,
    sid: "s",
  })
  const trusted = () => ({ ...sb.env, MA_TRUST_HOOKS: "1" })

  test.skipIf(!Bun.which("python3"))(
    "via .claude/settings.json: blocks rm -rf /, allows a safe command",
    async () => {
      sb.write(join(sb.project, ".claude", "hooks", "guard.py"), guard)
      // The REPORT.md 4.1 Claude config, unchanged.
      sb.write(
        join(sb.project, ".claude", "settings.json"),
        claudeConfig(
          "PreToolUse",
          [
            {
              type: "command",
              command: 'python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/guard.py"',
              timeout: 30,
            },
          ],
          "Bash",
        ),
      )
      const e = new HooksEngine({ cwd: sb.project, env: trusted() })
      expect(await e.dispatch("tool.willInvoke", bash("rm -rf /"))).toMatchObject({
        halt: true,
        reason: "Blocked: rm -rf / is not allowed.",
      })
      expect(await e.dispatch("tool.willInvoke", bash("ls -la"))).toBeUndefined()
    },
  )

  test.skipIf(!Bun.which("python3"))(
    "via native hooks.json: the same unchanged script blocks rm -rf /",
    async () => {
      const g = sb.write(join(sb.project, ".minimal-agent", "guard.py"), guard)
      const s = sb.write(join(sb.project, ".minimal-agent", "native-to-claude.py"), shim)
      sb.write(
        join(sb.project, ".minimal-agent", "hooks.json"),
        nativeConfig("tool.willInvoke", [`python3 "${s}" | python3 "${g}"`], {}, "Bash"),
      )
      const e = new HooksEngine({ cwd: sb.project, env: trusted() })
      expect(await e.dispatch("tool.willInvoke", bash("rm -rf /"))).toMatchObject({
        halt: true,
        reason: "Blocked: rm -rf / is not allowed.",
      })
      expect(await e.dispatch("tool.willInvoke", bash("ls -la"))).toBeUndefined()
    },
  )
})

describe("claude decode: missing script on exit 2 (MINOR 2, hooks-reference.md:824)", () => {
  const missing = run({ exitCode: 2, stderr: "/bin/sh: /x/hook.sh: No such file or directory\n" })

  test("Stop, SubagentStop: non-blocking error, no deny", () => {
    for (const ev of ["Stop", "SubagentStop"]) {
      const r = decodeClaudeOutcome(ev, missing, false)
      expect(r.decision).toBe("none")
      expect(r.error).toContain("No such file or directory")
    }
    // TaskCompleted is in the raw rule but has no channel here (unsupported).
    expect(decodeClaudeOutcome("TaskCompleted", missing, false).error).toContain("unsupported")
  })

  test("UserPromptSubmit: non-blocking only for a plugin source", () => {
    const plugin = decodeClaudeOutcome("UserPromptSubmit", missing, false, "plugin")
    expect(plugin.decision).toBe("none")
    expect(plugin.error).toContain("No such file")
    const user = decodeClaudeOutcome("UserPromptSubmit", missing, false, "user")
    expect(user.decision).toBe("deny")
  })

  test("stdout present or another stderr keeps the normal exit 2 block", () => {
    const withOut = run({ exitCode: 2, stdout: "x", stderr: "No such file or directory" })
    expect(decodeClaudeOutcome("Stop", withOut, false).decision).toBe("deny")
    const other = run({ exitCode: 2, stderr: "tests fail" })
    expect(decodeClaudeOutcome("Stop", other, false).decision).toBe("deny")
    expect(decodeClaudeOutcome("PreToolUse", missing, false).decision).toBe("deny")
  })
})
