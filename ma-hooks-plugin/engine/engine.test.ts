import { existsSync, readFileSync, symlinkSync } from "node:fs"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { nativeAdapter, parseNative } from "../native/adapter.ts"

import { defaultHooksConfig } from "./config.ts"
import { HooksEngine } from "./engine.ts"
import { hookIdentityHash } from "./hash.ts"
import { makeSandbox, nativeConfig, type Sandbox } from "./test-support.ts"
import type { HookDialectAdapter, SourceRef } from "./types.ts"

let sb: Sandbox

beforeEach(() => {
  sb = makeSandbox()
})

afterEach(() => {
  sb.cleanup()
})

const userHooks = () => join(sb.agentHome, "hooks.json")
const projectHooks = () => join(sb.project, ".minimal-agent", "hooks.json")
const localHooks = () => join(sb.project, ".minimal-agent", "hooks.local.json")

function engine(extra: Partial<ConstructorParameters<typeof HooksEngine>[0]> = {}): HooksEngine {
  return new HooksEngine({ cwd: sb.project, env: sb.env, adapters: [nativeAdapter], ...extra })
}

const bash = (command: string) => ({ tool: "Bash", toolUseId: "t1", input: { command }, cwd: "/" })

/** The identity hex of a plain command hook with no matcher. */
const cmdKey = (command: string) => hookIdentityHash({ handler: { type: "command", command } })

/** A stub second dialect that reads `<project>/.stub/hooks.json` in native format. */
function stubAdapter(): HookDialectAdapter {
  return {
    ...nativeAdapter,
    id: "stub",
    authoritative: false,
    discover: (env) => [
      {
        id: "project",
        path: join(env.projectRoot, ".stub", "hooks.json"),
        scope: "user",
        precedence: 10,
      },
    ],
    parse: (source: SourceRef, text: string) => parseNative(source, text, "stub"),
  }
}

describe("discovery and merge", () => {
  test("native sources come first, in order user, project, project-local", () => {
    const e = engine({ adapters: [nativeAdapter, stubAdapter()] })
    expect(e.sources.map((s) => `${s.adapter}:${s.source.id}`)).toEqual([
      "native:user",
      "native:project",
      "native:project-local",
      "stub:project",
    ])
  })

  test("cwd = home (also through a symlink): the user file loads once, no untrusted copy", () => {
    sb.write(userHooks(), nativeConfig("turn.willStart", ["echo ts"]))
    const link = join(sb.root, "home-link")
    symlinkSync(sb.home, link)
    for (const cwd of [sb.home, link]) {
      const e = engine({ cwd })
      expect(e.status().map((r) => `${r.hook.source.scope}:${r.trust}`)).toEqual([
        "user:implicit-user",
      ])
      expect(e.untrustedHooks()).toEqual([])
      expect(e.active.length).toBe(1)
    }
  })

  test("dedup keeps the native copy of an identical hook", async () => {
    const out = join(sb.root, "ran.log")
    const cmd = `echo "$MA_CHANNEL" >> ${out}`
    sb.write(userHooks(), nativeConfig("tool.willInvoke", [cmd]))
    sb.write(join(sb.project, ".stub", "hooks.json"), nativeConfig("tool.willInvoke", [cmd]))
    const e = engine({ adapters: [nativeAdapter, stubAdapter()] })
    expect(e.active.length).toBe(1)
    expect(e.active[0]?.dialect).toBe("native")
    await e.dispatch("tool.willInvoke", bash("ls"))
    expect(readFileSync(out, "utf8").trim().split("\n")).toEqual(["tool.willInvoke"])
  })

  test("deny wins over allow, context concatenates native first", async () => {
    sb.write(
      userHooks(),
      nativeConfig("tool.willInvoke", [`echo '{"decision":"allow","context":["native ctx"]}'`]),
    )
    sb.write(
      join(sb.project, ".stub", "hooks.json"),
      nativeConfig("tool.willInvoke", [
        `echo '{"decision":"deny","reason":"stub says no","context":["stub ctx"]}'`,
      ]),
    )
    const r = await engine({ adapters: [nativeAdapter, stubAdapter()] }).dispatch(
      "tool.willInvoke",
      bash("ls"),
    )
    expect(r).toMatchObject({
      halt: true,
      reason: "stub says no",
      additionalContext: [{ text: "native ctx" }, { text: "stub ctx" }],
    })
  })

  test("first payload rewrite in source order wins (native)", async () => {
    sb.write(
      userHooks(),
      nativeConfig("tool.willInvoke", [
        `echo '{"decision":"allow","payload":{"input":{"command":"native"}}}'`,
      ]),
    )
    sb.write(
      join(sb.project, ".stub", "hooks.json"),
      nativeConfig("tool.willInvoke", [
        `echo '{"decision":"allow","payload":{"input":{"command":"stub"}}}'`,
      ]),
    )
    const r = await engine({ adapters: [nativeAdapter, stubAdapter()] }).dispatch(
      "tool.willInvoke",
      bash("ls"),
    )
    expect(r).toEqual({ payload: { ...bash("ls"), input: { command: "native" } } })
  })

  test("matcher narrows hooks", async () => {
    sb.write(userHooks(), nativeConfig("tool.willInvoke", ["exit 2"], {}, "^Edit$"))
    const e = engine()
    expect(await e.dispatch("tool.willInvoke", bash("ls"))).toBeUndefined()
    expect(
      await e.dispatch("tool.willInvoke", { tool: "Edit", toolUseId: "t", input: {}, cwd: "/" }),
    ).toMatchObject({ halt: true })
  })
})

describe("exit codes and stdin", () => {
  test("exit 0 plain text is context on turn.willStart, with the writer label", async () => {
    sb.write(userHooks(), nativeConfig("turn.willStart", ["echo remember tests"]))
    expect(await engine().dispatch("turn.willStart", { text: "hi" })).toMatchObject({
      payload: { text: "hi" },
      additionalContext: [{ text: "remember tests" }],
    })
  })

  test("exit 2 denies with stderr reason", async () => {
    const s = sb.script("guard.sh", 'echo "rm is blocked" >&2\nexit 2')
    sb.write(userHooks(), nativeConfig("tool.willInvoke", [s]))
    expect(await engine().dispatch("tool.willInvoke", bash("rm -rf /"))).toEqual({
      halt: true,
      reason: "rm is blocked",
      payload: bash("rm -rf /"),
    })
  })

  test("other exit code fails open, failClosed blocks", async () => {
    sb.write(userHooks(), nativeConfig("tool.willInvoke", ["exit 7"]))
    expect(await engine().dispatch("tool.willInvoke", bash("ls"))).toBeUndefined()
    sb.write(
      userHooks(),
      nativeConfig("tool.willInvoke", [{ command: "exit 7", failClosed: true }]),
    )
    expect(await engine().dispatch("tool.willInvoke", bash("ls"))).toMatchObject({ halt: true })
  })

  test("stdin envelope, cwd = project dir, MA_ env, EOF after stdin", async () => {
    const cap = join(sb.root, "stdin.json")
    const s = sb.script(
      "cap.sh",
      `cat > ${cap}\npwd > ${cap}.pwd\necho "$MA_SESSION_ID" > ${cap}.env`,
    )
    sb.write(userHooks(), nativeConfig("tool.willInvoke", [s]))
    await engine().dispatch(
      "tool.willInvoke",
      { ...bash("ls"), sid: "sid-1", agentMode: "ask" },
      { sid: "ignored" },
    )
    const env = JSON.parse(readFileSync(cap, "utf8"))
    expect(env).toMatchObject({ channel: "tool.willInvoke", sid: "sid-1", mode: "ask" })
    expect(env.projectDir).toBe(sb.project)
    expect(readFileSync(`${cap}.pwd`, "utf8").trim()).toEndWith("/project")
    expect(readFileSync(`${cap}.env`, "utf8").trim()).toBe("sid-1")
  })

  test("exec form passes args without a shell", async () => {
    const cap = join(sb.root, "args.txt")
    const s = sb.script("args.sh", `printf '%s|' "$@" > ${cap}`)
    sb.write(userHooks(), nativeConfig("tool.didInvoke", [{ command: s, args: ["a b", "$HOME"] }]))
    await engine().dispatch("tool.didInvoke", { tool: "Bash", input: {}, ok: true })
    expect(readFileSync(cap, "utf8")).toBe("a b|$HOME|")
  })
})

describe("timeout", () => {
  test("SIGKILLs the whole process group", async () => {
    const pidFile = join(sb.root, "child.pid")
    const s = sb.script("hang.sh", `sleep 30 &\necho $! > ${pidFile}\nwait`)
    sb.write(userHooks(), nativeConfig("tool.willInvoke", [{ command: s, timeout: 2 }]))
    const e = engine()
    const t0 = Date.now()
    expect(await e.dispatch("tool.willInvoke", bash("ls"))).toBeUndefined()
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(e.runs[0]?.error).toContain("timed out")
    const pid = Number(readFileSync(pidFile, "utf8").trim())
    await Bun.sleep(100)
    let alive = true
    try {
      process.kill(pid, 0)
    } catch {
      alive = false
    }
    expect(alive).toBe(false)
  })
})

describe("trust", () => {
  test("untrusted project hook does not run, user hook does", async () => {
    const out = join(sb.root, "ran.log")
    sb.write(projectHooks(), nativeConfig("tool.didInvoke", [`echo project >> ${out}`]))
    sb.write(userHooks(), nativeConfig("tool.didInvoke", [`echo user >> ${out}`]))
    await engine().dispatch("tool.didInvoke", { tool: "Bash", input: {}, ok: true })
    expect(readFileSync(out, "utf8").trim()).toBe("user")
  })

  test("MA_TRUST_HOOKS=1 runs the project hook", async () => {
    const out = join(sb.root, "ran.log")
    sb.write(localHooks(), nativeConfig("tool.didInvoke", [`echo local >> ${out}`]))
    const e = engine({ env: { ...sb.env, MA_TRUST_HOOKS: "1" } })
    await e.dispatch("tool.didInvoke", { tool: "Bash", input: {}, ok: true })
    expect(readFileSync(out, "utf8").trim()).toBe("local")
  })

  test("hash trust: trusted hook runs, a changed hook is skipped again", async () => {
    const out = join(sb.root, "ran.log")
    sb.write(projectHooks(), nativeConfig("tool.didInvoke", [`echo v1 >> ${out}`]))
    const e = engine()
    const h = e.active[0]
    if (!h) throw new Error("no hook")
    expect(e.verdict(h)).toBe("untrusted-project")
    e.trust.trustHook(e.projectRoot, h)
    expect(existsSync(join(sb.agentHome, "hooks-state.json"))).toBe(true)
    await e.dispatch("tool.didInvoke", { tool: "Bash", input: {}, ok: true })
    sb.write(projectHooks(), nativeConfig("tool.didInvoke", [`echo v2 >> ${out}`]))
    const e2 = engine()
    const h2 = e2.active[0]
    if (!h2) throw new Error("no hook")
    expect(e2.verdict(h2)).toBe("untrusted-hash")
    await e2.dispatch("tool.didInvoke", { tool: "Bash", input: {}, ok: true })
    expect(readFileSync(out, "utf8").trim()).toBe("v1")
  })

  /** Trust the project hook of `before`, write `after`, and give the new verdict. */
  function verdictAfter(before: string, after: string): string {
    sb.write(projectHooks(), before)
    const e = engine()
    const h = e.active[0]
    if (!h) throw new Error("no hook")
    e.trust.trustHook(e.projectRoot, h)
    sb.write(projectHooks(), after)
    const e2 = engine()
    const h2 = e2.active[0]
    if (!h2) throw new Error("no hook after")
    return e2.verdict(h2)
  }

  test("MAJOR 3: a changed matcher makes a trusted hook untrusted", () => {
    const cmd = [{ type: "command", command: "echo hi" }]
    const v = verdictAfter(
      nativeConfig("tool.willInvoke", cmd, {}, "Bash"),
      nativeConfig("tool.willInvoke", cmd, {}, "Read"),
    )
    expect(v).toBe("untrusted-hash")
  })

  test("MAJOR 3: a changed timeout makes a trusted hook untrusted", () => {
    const v = verdictAfter(
      nativeConfig("tool.willInvoke", [{ type: "command", command: "echo hi", timeout: 5 }]),
      nativeConfig("tool.willInvoke", [{ type: "command", command: "echo hi", timeout: 6 }]),
    )
    expect(v).toBe("untrusted-hash")
  })

  test("MAJOR 3: a changed async or failClosed flag makes a trusted hook untrusted", () => {
    const base = { type: "command", command: "echo hi" }
    expect(
      verdictAfter(
        nativeConfig("tool.didInvoke", [base]),
        nativeConfig("tool.didInvoke", [{ ...base, async: true }]),
      ),
    ).toBe("untrusted-hash")
    expect(
      verdictAfter(
        nativeConfig("tool.willInvoke", [base]),
        nativeConfig("tool.willInvoke", [{ ...base, failClosed: true }]),
      ),
    ).toBe("untrusted-hash")
  })

  test("MAJOR 3: the same hook with keys in another order and explicit defaults stays trusted", () => {
    const a = JSON.stringify({
      hooks: {
        "tool.willInvoke": [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: "./x",
                args: ["a"],
                env: { B: "2", A: "1" },
                timeout: 600,
              },
            ],
          },
        ],
      },
    })
    const b = JSON.stringify({
      hooks: {
        "tool.willInvoke": [
          {
            hooks: [
              {
                env: { A: "1", B: "2" },
                args: ["a"],
                async: false,
                failClosed: false,
                command: "./x",
              },
            ],
          },
        ],
      },
    })
    expect(verdictAfter(a, b)).toBe("trusted")
  })

  test("a hook disabled in the state file does not run, even with MA_TRUST_HOOKS", async () => {
    sb.write(userHooks(), nativeConfig("tool.willInvoke", ["exit 2"]))
    const e = engine({ env: { ...sb.env, MA_TRUST_HOOKS: "1" } })
    const h = e.active[0]
    if (!h) throw new Error("no hook")
    e.trust.setEnabled(e.projectRoot, h.trustKey, false)
    expect(await e.dispatch("tool.willInvoke", bash("ls"))).toBeUndefined()
  })
})

describe("switches", () => {
  test("native disableAllHooks turns off every dialect", async () => {
    sb.write(userHooks(), JSON.stringify({ disableAllHooks: true }))
    sb.write(join(sb.project, ".stub", "hooks.json"), nativeConfig("tool.willInvoke", ["exit 2"]))
    const e = engine({ adapters: [nativeAdapter, stubAdapter()] })
    expect(e.allDisabled).toBe(true)
    expect(e.active).toEqual([])
    expect(e.channels()).toEqual([])
    expect(await e.dispatch("tool.willInvoke", bash("ls"))).toBeUndefined()
  })

  test("a non-native disableAllHooks turns off only that dialect", () => {
    sb.write(userHooks(), nativeConfig("tool.willInvoke", ["true"]))
    sb.write(
      join(sb.project, ".stub", "hooks.json"),
      nativeConfig("tool.willInvoke", ["exit 2"], { disableAllHooks: true }),
    )
    const e = engine({ adapters: [nativeAdapter, stubAdapter()] })
    expect(e.active.map((h) => h.dialect)).toEqual(["native"])
  })

  test("native disable list silences an adapter hook by trust key", async () => {
    sb.write(join(sb.project, ".stub", "hooks.json"), nativeConfig("tool.willInvoke", ["exit 2"]))
    sb.write(
      userHooks(),
      JSON.stringify({ disable: [`stub:project:tool.willInvoke:${cmdKey("exit 2")}`] }),
    )
    const e = engine({ adapters: [nativeAdapter, stubAdapter()] })
    expect(e.active).toEqual([])
    expect(e.all.length).toBe(1)
    expect(await e.dispatch("tool.willInvoke", bash("ls"))).toBeUndefined()
  })

  test("plugin config enabled:false makes dispatch a no-op", async () => {
    sb.write(userHooks(), nativeConfig("tool.willInvoke", ["exit 2"]))
    const e = engine({ config: { ...defaultHooksConfig(), enabled: false } })
    expect(await e.dispatch("tool.willInvoke", bash("ls"))).toBeUndefined()
  })
})

describe("async and output cap", () => {
  test("async queue runs at most maxAsync at once and injects at the next turn", async () => {
    const dir = join(sb.root, "conc")
    const s = sb.script(
      "slow.sh",
      `mkdir -p ${dir}\ntouch ${dir}/$$\nls ${dir} | wc -l | tr -d ' ' >> ${dir}.max\nsleep 0.3\nrm ${dir}/$$\necho async-done`,
    )
    const hooks = Array.from({ length: 5 }, (_, i) => ({ command: `${s} ${i}`, async: true }))
    sb.write(userHooks(), nativeConfig("turn.willStart", hooks))
    const e = engine({ config: { ...defaultHooksConfig(), maxAsync: 2 } })
    expect(await e.dispatch("turn.willStart", { text: "a" })).toBeUndefined()
    await e.asyncQueue.idle()
    expect(e.asyncQueue.peak).toBe(2)
    const counts = readFileSync(`${dir}.max`, "utf8").trim().split("\n").map(Number)
    expect(Math.max(...counts)).toBeLessThanOrEqual(2)
    // Next turn: no sync hooks run, queued context is injected.
    sb.write(userHooks(), JSON.stringify({ hooks: {} }))
    const r = await e.dispatch("turn.willStart", { text: "b" })
    const texts = ((r as { additionalContext?: unknown[] }).additionalContext ?? []).map((x) =>
      typeof x === "string" ? x : (x as { text: string }).text,
    )
    expect(texts).toEqual(Array(5).fill("async-done"))
  })

  test("context over the cap keeps a preview and saves the full text", async () => {
    sb.write(userHooks(), nativeConfig("turn.willStart", [`head -c 20000 /dev/zero | tr '\\0' x`]))
    const r = await engine().dispatch("turn.willStart", { text: "a" })
    const entry = ((r as { additionalContext?: unknown[] }).additionalContext ?? [])[0]
    const ctx = typeof entry === "string" ? entry : ((entry as { text?: string })?.text ?? "")
    expect(ctx.length).toBeLessThan(2200)
    expect(ctx).toContain("[hook output truncated: 20000 chars, full text at ")
    const path = /full text at (\S+)\]/.exec(ctx)?.[1] ?? ""
    expect(readFileSync(path, "utf8").length).toBe(20000)
  })
})

describe("reload", () => {
  test("a changed source reloads on the next dispatch", async () => {
    const e = engine()
    expect(e.active).toEqual([])
    sb.write(userHooks(), nativeConfig("tool.willInvoke", ["exit 2"]))
    expect(await e.dispatch("tool.willInvoke", bash("ls"))).toMatchObject({ halt: true })
  })
})

describe("review fixes", () => {
  const didInvoke = { tool: "Bash", input: {}, ok: true }

  test("BLOCKER 1: an untrusted project disableAllHooks or disable list is ignored", async () => {
    const out = join(sb.root, "ran.log")
    sb.write(userHooks(), nativeConfig("tool.didInvoke", [`echo user >> ${out}`]))
    sb.write(projectHooks(), JSON.stringify({ disableAllHooks: true }))
    sb.write(
      localHooks(),
      JSON.stringify({ disable: [`native:user:tool.didInvoke:${cmdKey(`echo user >> ${out}`)}`] }),
    )
    const e = engine()
    expect(e.allDisabled).toBe(false)
    expect(e.projectDisabled).toBe(false)
    expect(e.disabledKeys.size).toBe(0)
    await e.dispatch("tool.didInvoke", didInvoke)
    expect(readFileSync(out, "utf8").trim()).toBe("user")
  })

  test("BLOCKER 1: a trusted project switch turns off project hooks only, never user hooks", async () => {
    const out = join(sb.root, "ran.log")
    sb.write(userHooks(), nativeConfig("tool.didInvoke", [`echo user >> ${out}`]))
    sb.write(
      projectHooks(),
      nativeConfig("tool.didInvoke", [`echo project >> ${out}`], {
        disable: [`native:user:tool.didInvoke:${cmdKey(`echo user >> ${out}`)}`],
      }),
    )
    sb.write(localHooks(), JSON.stringify({ disableAllHooks: true }))
    const e = engine({ env: { ...sb.env, MA_TRUST_HOOKS: "1" } })
    expect(e.allDisabled).toBe(false)
    expect(e.projectDisabled).toBe(true)
    expect(e.active.map((h) => h.trustKey)).toEqual([
      `native:user:tool.didInvoke:${cmdKey(`echo user >> ${out}`)}`,
    ])
    await e.dispatch("tool.didInvoke", didInvoke)
    expect(readFileSync(out, "utf8").trim()).toBe("user")
  })

  test("MAJOR 4: two stores that share a state file keep both changes", () => {
    sb.write(projectHooks(), nativeConfig("tool.didInvoke", ["true", "false"]))
    const a = engine()
    const b = engine()
    const [h1, h2] = a.active
    if (!h1 || !h2) throw new Error("no hooks")
    a.trust.read()
    b.trust.read()
    a.trust.trustHook(a.projectRoot, h1)
    b.trust.trustHook(b.projectRoot, h2)
    const state = JSON.parse(readFileSync(join(sb.agentHome, "hooks-state.json"), "utf8"))
    expect(Object.keys(state.projects[a.projectRoot].hooks).sort()).toEqual(
      [h1.trustKey, h2.trustKey].sort(),
    )
  })

  test("MAJOR 6: on tool.* only payload.input may change, other keys are logged", async () => {
    const logs: string[] = []
    sb.write(
      userHooks(),
      nativeConfig("tool.willInvoke", [
        `echo '{"payload":{"tool":"Write","toolUseId":"x","sid":"evil","input":{"command":"ok"}}}'`,
      ]),
    )
    const r = await engine({ log: (m) => logs.push(m) }).dispatch("tool.willInvoke", bash("ls"))
    expect(r).toEqual({ payload: { ...bash("ls"), input: { command: "ok" } } })
    expect(logs.some((l) => l.includes("ignored payload keys tool, toolUseId, sid"))).toBe(true)
  })

  test("NIT 1: a continue:false halt keeps additionalContext", async () => {
    sb.write(
      userHooks(),
      nativeConfig("turn.willStart", [
        `echo '{"continue":false,"reason":"stop","context":["keep me"]}'`,
      ]),
    )
    expect(await engine().dispatch("turn.willStart", { text: "hi" })).toMatchObject({
      halt: true,
      reason: "stop",
      payload: { text: "hi" },
      additionalContext: [{ text: "keep me" }],
    })
  })

  test("MINOR 7: exit 0 while a background child holds stdout is not a timeout", async () => {
    const pidFile = join(sb.root, "bg.pid")
    const s = sb.script("bg.sh", `echo kept\nsleep 30 &\necho $! > ${pidFile}\nexit 0`)
    sb.write(
      userHooks(),
      nativeConfig("tool.willInvoke", [{ command: s, timeout: 10, failClosed: true }]),
    )
    const e = engine()
    const t0 = Date.now()
    expect(await e.dispatch("tool.willInvoke", bash("ls"))).toBeUndefined()
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(e.runs[0]).toMatchObject({ exitCode: 0, decision: "none" })
    expect(e.runs[0]?.error).toBeUndefined()
    await Bun.sleep(100)
    let alive = true
    try {
      process.kill(Number(readFileSync(pidFile, "utf8").trim()), 0)
    } catch {
      alive = false
    }
    expect(alive).toBe(false)
  })
})
