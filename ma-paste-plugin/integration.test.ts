/**
 * I1 and the load test: the real `PluginLoader` loads this plugin (with the
 * codec plugin), and an `AgentCore` with a stub send runs one turn. The wire
 * has the paste content. The core messages, the session JSONL and the
 * `user_message` event have the ref only. A 1 MB paste on a model whose
 * output shares the context window gets a smaller `maxTokens` (core B5).
 *
 * @module ma-paste-plugin/integration.test
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { createAgentContext } from "@minimal-agent/core/host/agent-context"
import { getSessionId } from "@minimal-agent/core/host/session-id"
import { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"
import { SessionStore } from "@minimal-agent/core/host-kit/session-store"
import { registerTestProvider } from "@minimal-agent/core/testing/provider-fixture"
import { buildTestCore } from "@minimal-agent/core/testing/test-core"

const PLUGINS = resolve(import.meta.dir, "..")
const MODEL = "paste-share-model"
const PROVIDER = "paste-share-prov"
const ONE_MB = 1_000_000

/**
 * The core host accepts only a sid that the process owns: the process sid
 * (the CLI gives the same value to `ctx.agent.sessionId`).
 */
const SID = getSessionId()

let root: string
let sessionsDir: string
let loader: PluginLoader
let store: SessionStore

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "paste-integ-"))
  sessionsDir = join(root, "sessions")
  // Load only two plugins: put links to them in a temp embedded root.
  const embedded = join(root, "plugins")
  mkdirSync(embedded)
  for (const dir of ["ma-sideband-plugin", "ma-paste-plugin"]) {
    symlinkSync(join(PLUGINS, dir), join(embedded, dir))
  }
  const none = join(root, "none")
  loader = await PluginLoader.load({
    roots: { embedded: [embedded], user: [none], project: [none] },
    logger: () => {},
    agent: createAgentContext({ sessionId: SID, pid: process.pid, model: MODEL, version: "0" }),
    hostOptions: { sessionsDir },
  })
  store = SessionStore.open({
    sid: SID,
    dir: sessionsDir,
    model: MODEL,
    cwd: root,
    systemHash: "h",
    toolsHash: "h",
    agentVersion: "test",
  })
  registerTestProvider({
    id: PROVIDER,
    models: [
      {
        id: MODEL,
        capabilities: {
          contextWindow: 2_000_000,
          maxOutputTokens: 1_500_000,
          outputTokensShareContextWindow: true,
        },
      },
    ],
  })
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

/** The capability host of this plugin (the same one the hook gets). */
function files() {
  const api = loader.capabilityHostFor("paste")?.sessionFiles
  if (!api) throw new Error("no sessionFiles for paste")
  return api
}

/** The ref of a saved paste, rendered by the loader codec. */
function ref(id: string): string {
  return loader.sideband().render("paste", { attrs: { id, bytes: 1, lines: 1 } })
}

interface Sent {
  messages: Array<{ role: string; content: unknown }>
  maxTokens?: number
}

/** Run one turn with a stub send. Give the captured requests and events. */
async function runTurn(text: string, store?: SessionStore) {
  const sent: Sent[] = []
  const events: Array<{ type: string; text?: string }> = []
  const sendFn = async function* (opts: Sent): AsyncGenerator<string, unknown, undefined> {
    sent.push(JSON.parse(JSON.stringify({ messages: opts.messages, maxTokens: opts.maxTokens })))
    return {
      blocks: [{ type: "text", text: "ok" }],
      text: "ok",
      stopReason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  }
  const core = await buildTestCore({
    auth: { type: "api-key", token: "t" },
    sendFn: sendFn as never,
    loader,
    model: MODEL,
    providerId: PROVIDER,
    ...(store ? { store } : {}),
    eventSink: { emit: (e: { type: string; text?: string }) => events.push(e) },
  } as never)
  const gen = core.run(text)
  while (!(await gen.next()).done) {
    // drain
  }
  return { sent, events, core }
}

/** The text of the last user message of a request. */
function lastUserText(messages: Sent["messages"]): string {
  const m = [...messages].reverse().find((x) => x.role === "user")
  if (!m) return ""
  if (typeof m.content === "string") return m.content
  return (m.content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
}

describe("ma-paste-plugin load", () => {
  test("the loader registers the paste kind with owner paste", () => {
    const k = loader
      .sideband()
      .kinds()
      .find((x) => x.kind === "paste")
    expect(k?.owner).toBe("paste")
    expect(k?.direction).toBe("to-model")
    expect(k?.placement).toBe("inline")
    expect(k?.body).toBe("text")
    expect(k?.layout).toBe("block")
    expect(k?.trust).toBe("untrusted")
    expect(Object.keys(k?.attrs ?? {})).toEqual(["id", "bytes", "lines"])
    expect(k?.attrs.id?.required).toBe(true)
  })

  test("the plugin host has sessions:files and models:read only", () => {
    const host = loader.capabilityHostFor("paste")
    expect(host?.capabilities).toEqual(["sessions:files", "models:read"])
    expect(host?.sessionFiles).toBeDefined()
    expect(host?.models).toBeDefined()
  })

  test("loadedPackages gives the validated capabilities and the owned paste kind", () => {
    const pkg = loader.loadedPackages().find((p) => p.id === "paste")
    expect(pkg?.capabilities).toEqual(["sessions:files", "models:read"])
    expect(pkg?.sidebandKinds).toEqual(["paste"])
  })

  test("the manifest asks for ui:paste (the CLI gives ctx.paste only then)", () => {
    const raw = JSON.parse(readFileSync(join(import.meta.dir, "manifest.json"), "utf8")) as {
      permissions: string[]
    }
    expect(raw.permissions).toContain("ui:paste")
  })

  test("the files go under <sid>.files/paste/", () => {
    expect(files().create(SID, "load1.txt", "hello")).toBe("ok")
    expect(readFileSync(join(sessionsDir, `${SID}.files`, "paste", "load1.txt"), "utf8")).toBe(
      "hello",
    )
  })
})

describe("I1: the wire has the content, the stored forms have the ref", () => {
  test("one turn: wire expanded; messages, JSONL and user_message hold the ref", async () => {
    const content = "pasted line 1\npasted line 2\n"
    expect(files().create(SID, "int01.txt", content)).toBe("ok")
    const text = `look at this: ${ref("int01")}`
    const { sent, events, core } = await runTurn(text, store)
    expect(sent.length).toBe(1)
    const sb = loader.sideband()
    const wire = lastUserText(sent[0]?.messages ?? [])
    expect(wire).toContain(content)
    expect(wire).not.toContain(ref("int01"))
    const node = sb.find(wire, { kinds: ["paste"] })[0]
    expect(node?.selfClosing).toBe(false)
    expect(node?.attrs).toEqual({ id: "int01", bytes: "28", lines: "2" })
    // Core messages hold the ref.
    const stored = lastUserText(core.history())
    expect(stored).toContain(ref("int01"))
    expect(stored).not.toContain("pasted line 1")
    // The JSONL holds the ref only.
    const jsonl = readFileSync(join(sessionsDir, `${SID}.jsonl`), "utf8")
    expect(jsonl).toContain(JSON.stringify(ref("int01")).slice(1, -1))
    expect(jsonl).not.toContain("pasted line 1")
    // The user_message event holds the ref only.
    const um = events.filter((e) => e.type === "user_message")
    expect(um.length).toBeGreaterThan(0)
    for (const e of um) {
      expect(e.text).toContain(ref("int01"))
      expect(e.text).not.toContain("pasted line 1")
    }
  })

  test("an unknown ref goes as the literal ref (no halt)", async () => {
    const { sent } = await runTurn(`x ${ref("nofil")}`)
    expect(lastUserText(sent[0]?.messages ?? [])).toContain(ref("nofil"))
  })

  test("1 MB paste on a shared-window model: the wire has it and maxTokens is smaller", async () => {
    const big = `${"y".repeat(ONE_MB - 1)}\n`
    expect(files().create(SID, "big01.txt", big)).toBe("ok")
    const small = await runTurn("hello")
    const large = await runTurn(`hello ${ref("big01")}`)
    const wire = lastUserText(large.sent[0]?.messages ?? [])
    expect(wire.length).toBeGreaterThan(ONE_MB)
    expect(wire).toContain(big)
    const before = small.sent[0]?.maxTokens
    const after = large.sent[0]?.maxTokens
    expect(typeof before).toBe("number")
    expect(typeof after).toBe("number")
    expect(after as number).toBeLessThan((before as number) - ONE_MB / 2)
    // The stored message holds only the ref.
    expect(lastUserText(large.core.history()).length).toBeLessThan(200)
  })
})
