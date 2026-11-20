import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import type {
  CommandContext,
  CommandResult,
  HookHandlerContext,
} from "@minimal-agent/core/plugin-api/types/plugin"

import { hookIdentityHash } from "../engine/hash.ts"
import { untrustedNotice } from "../engine/notice.ts"
import { makeSandbox, nativeConfig, type Sandbox } from "../engine/test-support.ts"
import manifest from "../manifest.json"

import dispatch, { engineFor, resetEngine } from "./dispatch.ts"
import hooksCommand from "./hooks-command.ts"

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

const noop = () => {}
const log = {
  emergency: noop,
  alert: noop,
  critical: noop,
  error: noop,
  warn: noop,
  notice: noop,
  info: noop,
  debug: noop,
}

function cmd(argv: string, cwd: string): CommandContext {
  return {
    name: "hooks",
    argv,
    rawLine: `/hooks ${argv}`,
    cwd,
    env: {},
    abort: new AbortController().signal,
    log,
    emit: noop,
  }
}

function hookCtx(channel: string, cwd: string): HookHandlerContext {
  return {
    agent: { sessionId: "S1", pid: 1, model: "m", version: "0" },
    channel,
    packageDir: "/pkg",
    cwd,
    env: {},
    abort: new AbortController().signal,
    priority: 50,
    countdown: async () => "elapsed",
    emit: noop,
    log,
  }
}

function setup(): Sandbox {
  const s = makeSandbox()
  process.env.HOME = s.home
  delete process.env.MINIMAL_AGENT_HOME
  delete process.env.MA_TRUST_HOOKS
  return s
}

function text(r: CommandResult): string {
  if (r.kind === "error") return r.message
  if (r.kind === "notice")
    return [r.block?.info ?? "", ...(r.block?.body ?? []), ...(r.lines ?? [])].join("\n")
  return ""
}

const projectFile = (s: Sandbox) => join(s.project, ".minimal-agent", "hooks.json")
const keyOf = (command: string, channel = "tool.didInvoke", src = "project") =>
  `native:${src}:${channel}:${hookIdentityHash({ handler: { type: "command", command } })}`
const didInvoke = { tool: "Bash", input: {}, ok: true }

describe("/hooks manifest", () => {
  test("headless.commands has /hooks with a module handler", () => {
    expect(manifest.headless.commands).toEqual([
      expect.objectContaining({
        name: "hooks",
        handler: { type: "module", path: "./handlers/hooks-command.ts", export: "default" },
      }),
    ])
  })

  // Core parseManifest is not in the plugin-api exports, so it is loaded by
  // path from the resolved core package (core src/plugins/manifest.ts:167).
  const corePkg = (() => {
    try {
      return dirname(Bun.resolveSync("@minimal-agent/core/package.json", import.meta.dir))
    } catch {
      return ""
    }
  })()
  const manifestTs = corePkg ? join(corePkg, "src", "plugins", "manifest.ts") : ""
  test.skipIf(!manifestTs || !existsSync(manifestTs))(
    "core parseManifest accepts the manifest with the /hooks command",
    async () => {
      const mod = (await import(manifestTs)) as {
        parseManifest: (
          raw: unknown,
          path: string,
          o?: object,
        ) => { commands: Array<{ name: string }> }
      }
      const raw: unknown = JSON.parse(
        readFileSync(join(import.meta.dir, "..", "manifest.json"), "utf8"),
      )
      const parsed = mod.parseManifest(raw, "/x/manifest.json", { warn: noop })
      expect(parsed.commands.map((c) => c.name)).toEqual(["hooks"])
    },
  )
})

describe("/hooks list", () => {
  test("lists hooks by channel with dialect, matcher, source, trust, enabled, support, last", async () => {
    sb = setup()
    sb.write(
      join(sb.agentHome, "hooks.json"),
      nativeConfig("tool.didInvoke", ["echo u"], {}, "Bash"),
    )
    sb.write(projectFile(sb), nativeConfig("tool.didInvoke", ["echo p"]))
    sb.write(
      join(sb.project, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "true", if: "Bash(git *)" }] },
          ],
          TeammateIdle: [{ hooks: [{ type: "command", command: "true" }] }],
          Stop: [{ hooks: [{ type: "prompt", prompt: "x" }] }],
        },
      }),
    )
    await dispatch(didInvoke, hookCtx("tool.didInvoke", sb.project))
    const out = text(hooksCommand(cmd("", sb.project)))
    expect(out).toContain("tool.didInvoke:")
    expect(out).toContain("tool.willInvoke:")
    expect(out).toContain("(unsupported event TeammateIdle):")
    expect(out).toContain("native tool.didInvoke, matcher Bash: echo u")
    expect(out).toContain("claude PreToolUse, matcher Bash, if Bash(git *): true")
    expect(out).toContain(`${projectFile(sb)} (project)`)
    expect(out).toMatch(/implicit-user, enabled, supported, last: none at \d{4}-/)
    expect(out).toContain("untrusted, enabled, supported, last: never")
    expect(out).toContain("unsupported-event")
    expect(out).toContain("unsupported-type")
    const rows = engineFor(sb.project).status()
    const user = rows.find((r) => r.hook.source.scope === "user" && r.hook.dialect === "native")
    expect(user?.last?.outcome).toBe("none")
  })

  test("MA_TRUST_HOOKS=1 shows env trust", () => {
    sb = setup()
    sb.write(projectFile(sb), nativeConfig("tool.didInvoke", ["echo p"]))
    process.env.MA_TRUST_HOOKS = "1"
    try {
      expect(text(hooksCommand(cmd("list", sb.project)))).toContain("env, enabled, supported")
    } finally {
      delete process.env.MA_TRUST_HOOKS
    }
  })
})

describe("/hooks trust, untrust, enable, disable, trust-all", () => {
  test("trust makes the next dispatch run the project hook, untrust stops it", async () => {
    sb = setup()
    const out = join(sb.root, "ran.log")
    const c = `echo p >> ${out}`
    sb.write(projectFile(sb), nativeConfig("tool.didInvoke", [c]))
    await dispatch(didInvoke, hookCtx("tool.didInvoke", sb.project))
    expect(existsSync(out)).toBe(false)
    const r = hooksCommand(cmd(`trust ${keyOf(c)}`, sb.project))
    expect(r.kind).toBe("notice")
    // B3 MINOR 4: the output says the project is trusted now.
    expect(text(r)).toContain(`project ${sb.project} is now trusted; its disable switches apply`)
    expect(text(hooksCommand(cmd("list", sb.project)))).toContain("trusted, enabled")
    await dispatch(didInvoke, hookCtx("tool.didInvoke", sb.project))
    expect(readFileSync(out, "utf8").trim()).toBe("p")
    hooksCommand(cmd(`untrust ${keyOf(c)}`, sb.project))
    await dispatch(didInvoke, hookCtx("tool.didInvoke", sb.project))
    expect(readFileSync(out, "utf8").trim()).toBe("p")
    expect(text(hooksCommand(cmd("list", sb.project)))).toContain("untrusted-hash, enabled")
  })

  test("disable stops a user hook at the next dispatch, enable brings it back", async () => {
    sb = setup()
    const out = join(sb.root, "ran.log")
    const c = `echo u >> ${out}`
    sb.write(join(sb.agentHome, "hooks.json"), nativeConfig("tool.didInvoke", [c]))
    const key = keyOf(c, "tool.didInvoke", "user")
    await dispatch(didInvoke, hookCtx("tool.didInvoke", sb.project))
    expect(hooksCommand(cmd(`disable ${key}`, sb.project)).kind).toBe("notice")
    await dispatch(didInvoke, hookCtx("tool.didInvoke", sb.project))
    expect(text(hooksCommand(cmd("list", sb.project)))).toContain("implicit-user, disabled")
    hooksCommand(cmd(`enable ${key}`, sb.project))
    await dispatch(didInvoke, hookCtx("tool.didInvoke", sb.project))
    expect(readFileSync(out, "utf8").trim().split("\n")).toEqual(["u", "u"])
  })

  test("trust-all trusts every hook of one file, relative or absolute", async () => {
    sb = setup()
    const out = join(sb.root, "ran.log")
    sb.write(
      projectFile(sb),
      nativeConfig("tool.didInvoke", [`echo a >> ${out}`, `echo b >> ${out}`]),
    )
    const r = hooksCommand(cmd("trust-all .minimal-agent/hooks.json", sb.project))
    expect(text(r)).toContain("trusted 2 hook(s)")
    expect(text(r)).toContain(`project ${sb.project} is now trusted; its disable switches apply`)
    await dispatch(didInvoke, hookCtx("tool.didInvoke", sb.project))
    expect(readFileSync(out, "utf8").trim().split("\n").sort()).toEqual(["a", "b"])
    expect(hooksCommand(cmd(`trust-all ${projectFile(sb)}`, sb.project)).kind).toBe("notice")
  })

  test("a change from another engine is seen at the next dispatch (state file reload)", async () => {
    sb = setup()
    const out = join(sb.root, "ran.log")
    const c = `echo p >> ${out}`
    sb.write(projectFile(sb), nativeConfig("tool.didInvoke", [c]))
    const eng = engineFor(sb.project)
    await eng.dispatch("tool.didInvoke", didInvoke)
    resetEngine()
    // A fresh engine (another cwd cache or session) writes the trust.
    hooksCommand(cmd(`trust ${keyOf(c)}`, sb.project))
    await Bun.sleep(5)
    await eng.dispatch("tool.didInvoke", didInvoke)
    expect(readFileSync(out, "utf8").trim()).toBe("p")
  })

  test("unknown key, unknown file, missing argument and bad sub-command give errors, not throws", () => {
    sb = setup()
    sb.write(projectFile(sb), nativeConfig("tool.didInvoke", ["echo p"]))
    for (const argv of [
      "trust native:project:nope:00000000",
      "disable",
      "trust-all no/such/file.json",
      "trust-all",
      "frobnicate",
      "list extra",
    ]) {
      const r = hooksCommand(cmd(argv, sb.project))
      expect(r.kind).toBe("error")
      expect(text(r)).toStartWith("hooks: ")
    }
    expect(text(hooksCommand(cmd("trust nope", sb.project)))).toContain("unknown trust key nope")
    expect(text(hooksCommand(cmd("trust-all x.json", sb.project)))).toContain(
      "no hooks from file x.json",
    )
  })

  test("no hooks configured", () => {
    sb = setup()
    expect(text(hooksCommand(cmd("", sb.project)))).toContain("No hooks configured.")
  })
})

describe("stable trust keys (MINOR 6)", () => {
  test("a hook inserted before an existing one keeps the existing key and its trust", async () => {
    sb = setup()
    const out = join(sb.root, "ran.log")
    const old = `echo old >> ${out}`
    sb.write(projectFile(sb), nativeConfig("tool.didInvoke", [old]))
    const key = keyOf(old)
    expect(engineFor(sb.project).all.map((h) => h.trustKey)).toEqual([key])
    hooksCommand(cmd(`trust ${key}`, sb.project))
    // Insert a new hook in front, in a new group in front.
    sb.write(
      projectFile(sb),
      JSON.stringify({
        hooks: {
          "tool.didInvoke": [
            { hooks: [{ type: "command", command: `echo new >> ${out}` }] },
            {
              hooks: [
                { type: "command", command: `echo new2 >> ${out}` },
                { type: "command", command: old },
              ],
            },
          ],
        },
      }),
    )
    await Bun.sleep(5)
    const eng = engineFor(sb.project)
    eng.reloadIfChanged()
    expect(eng.all.map((h) => h.trustKey)).toContain(key)
    const h = eng.all.find((x) => x.trustKey === key)
    expect(h && eng.verdict(h)).toBe("trusted")
    await dispatch(didInvoke, hookCtx("tool.didInvoke", sb.project))
    expect(readFileSync(out, "utf8").trim().split("\n")).toEqual(["old"])
  })

  test("two hooks with the same identity in one file get an ordinal only for the repeat", () => {
    sb = setup()
    sb.write(
      projectFile(sb),
      nativeConfig("tool.didInvoke", [
        "echo same",
        { command: "echo same", timeout: 3 },
        "echo other",
      ]),
    )
    const keys = engineFor(sb.project).all.map((h) => h.trustKey)
    expect(keys).toEqual([keyOf("echo same"), `${keyOf("echo same")}-2`, keyOf("echo other")])
  })
})

describe("untrusted notice text", () => {
  test("names /hooks trust <key>, --trust-hooks and MA_TRUST_HOOKS=1", () => {
    sb = setup()
    sb.write(projectFile(sb), nativeConfig("tool.didInvoke", ["echo p"]))
    const n = untrustedNotice(engineFor(sb.project).untrustedHooks())
    expect(n?.text).toContain(keyOf("echo p"))
    expect(n?.text).toContain("/hooks trust <key>")
    expect(n?.text).toContain("--trust-hooks")
    expect(n?.text).toContain("MA_TRUST_HOOKS=1")
    expect(n?.text).not.toContain("comes later")
  })
})
