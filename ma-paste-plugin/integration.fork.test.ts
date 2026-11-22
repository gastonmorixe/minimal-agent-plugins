/**
 * M1: the sid of the hook is the sid of the store that the turn writes to,
 * also after a fork as `--resume` does it.
 *
 * The CLI makes the store with the process sid (`getSessionId()`): a fork
 * on resume writes `SessionStore.fork({ srcSid, dstSid: getSessionId() })`,
 * and the loader agent gets the same `getSessionId()`. This test does the
 * same steps with the real `PluginLoader` and a real `AgentCore`. A probe
 * plugin records `ctx.agent.sessionId` inside its `message.willSend` hook.
 *
 * @module ma-paste-plugin/integration.fork.test
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { createAgentContext } from "@minimal-agent/core/host/agent-context"
import { createSessionFilesApi } from "@minimal-agent/core/host/session-files"
import { getSessionId } from "@minimal-agent/core/host/session-id"
import { PluginLoader } from "@minimal-agent/core/host-kit/plugin-loader"
import { SessionStore } from "@minimal-agent/core/host-kit/session-store"
import { registerTestProvider } from "@minimal-agent/core/testing/provider-fixture"
import { buildTestCore } from "@minimal-agent/core/testing/test-core"

const PLUGINS = resolve(import.meta.dir, "..")
const MODEL = "paste-fork-model"
const PROVIDER = "paste-fork-prov"
/** The global that the probe hook writes. */
const PROBE = "__pasteForkProbe"
/** The sid of the earlier process (the resume source). */
const SRC_SID = "0b6c7f6e-1d2a-4c3b-9e8f-7a6b5c4d3e2f"

interface ProbeHit {
  sid: string | undefined
  wire: string
}

let root: string
let sessionsDir: string
let loader: PluginLoader
let store: SessionStore

/** The probe plugin: a `message.willSend` hook after the paste hook. */
function writeProbePlugin(dir: string): void {
  mkdirSync(dir)
  const manifest = {
    id: "paste-fork-probe",
    name: "Paste fork probe",
    version: "0.0.0",
    description: "Test probe.",
    permissions: ["hooks:message.willSend"],
    headless: {
      hooks: [
        {
          id: "probe",
          channel: "message.willSend",
          handler: { type: "module", path: "./probe.ts", export: "default" },
          priority: 10,
        },
      ],
    },
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest))
  writeFileSync(
    join(dir, "probe.ts"),
    [
      "export default function probe(snap, ctx) {",
      `  const hits = (globalThis.${PROBE} ??= [])`,
      "  hits.push({ sid: ctx.agent?.sessionId, wire: JSON.stringify(snap.messages) })",
      "  return undefined",
      "}",
      "",
    ].join("\n"),
  )
}

function probeHits(): ProbeHit[] {
  return ((globalThis as Record<string, unknown>)[PROBE] as ProbeHit[] | undefined) ?? []
}

const BASE = { model: MODEL, systemHash: "h", toolsHash: "h", agentVersion: "test" }

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "paste-fork-"))
  sessionsDir = join(root, "sessions")
  // The earlier process: its session file and one paste file under its sid.
  SessionStore.open({ sid: SRC_SID, dir: sessionsDir, cwd: root, ...BASE })
  const earlier = createSessionFilesApi({ sessionsDir, pluginId: "paste" })
  expect(earlier.create(SRC_SID, "fork1.txt", "text from the first run\n")).toBe("ok")
  // This process: `--resume SRC_SID` forks onto the process sid (CLI session-store-boot).
  store = SessionStore.fork({
    srcSid: SRC_SID,
    dstSid: getSessionId(),
    dir: sessionsDir,
    cwd: root,
    ...BASE,
  })
  const embedded = join(root, "plugins")
  mkdirSync(embedded)
  for (const dir of ["ma-sideband-plugin", "ma-paste-plugin"]) {
    symlinkSync(join(PLUGINS, dir), join(embedded, dir))
  }
  writeProbePlugin(join(embedded, "ma-paste-fork-probe-plugin"))
  const none = join(root, "none")
  loader = await PluginLoader.load({
    roots: { embedded: [embedded], user: [none], project: [none] },
    logger: () => {},
    agent: createAgentContext({
      sessionId: getSessionId(),
      pid: process.pid,
      model: MODEL,
      version: "0",
    }),
    hostOptions: { sessionsDir },
  })
  registerTestProvider({
    id: PROVIDER,
    models: [{ id: MODEL, capabilities: { contextWindow: 200_000, maxOutputTokens: 8_000 } }],
  })
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  delete (globalThis as Record<string, unknown>)[PROBE]
})

/** Run one turn on `store` with a stub send. Give the sent messages. */
async function runTurn(text: string): Promise<string[]> {
  const sent: string[] = []
  const sendFn = async function* (opts: { messages: unknown }) {
    sent.push(JSON.stringify(opts.messages))
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
    store,
  } as never)
  const gen = core.run(text)
  while (!(await gen.next()).done) {
    // drain
  }
  return sent
}

describe("M1: the hook sid is the sid of the store of the turn (fork as --resume)", () => {
  test("ctx.agent.sessionId === store.sid, and a ref saved before the fork expands", async () => {
    const sb = loader.sideband()
    const ref = sb.render("paste", { attrs: { id: "fork1", bytes: 1, lines: 1 } })
    const sent = await runTurn(`again: ${ref}`)
    // The turn wrote to the forked store.
    expect(store.sid).toBe(getSessionId())
    expect(store.sid).not.toBe(SRC_SID)
    const jsonl = readFileSync(join(sessionsDir, `${store.sid}.jsonl`), "utf8")
    expect(jsonl).toContain(JSON.stringify(ref).slice(1, -1))
    // Inside the hook chain: the sid is the store sid, and the paste hook (priority 100) ran first.
    const hits = probeHits()
    expect(hits.length).toBeGreaterThan(0)
    for (const h of hits) expect(h.sid).toBe(store.sid)
    expect(hits.at(-1)?.wire).toContain("text from the first run")
    // The wire has the content of the file that the fork linked.
    expect(sent.length).toBe(1)
    expect(sent[0]).toContain("text from the first run")
    expect(sent[0]).not.toContain(JSON.stringify(ref).slice(1, -1))
  })
})
