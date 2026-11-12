/**
 * Extra scenarios for the request golden harness: media, resume, kill-resume,
 * stream salvage and compaction. Split from scenarios.ts to keep files small.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import {
  NetworkClient,
  NetworkResponse,
  type NetworkTransport,
} from "@minimal-agent/core/host/network"
import { loadSession } from "@minimal-agent/core/host/session-restore"
import { FileTrackingStore } from "@minimal-agent/core/host-kit/file-tracking-store"
import { SessionStore } from "@minimal-agent/core/host-kit/session-store"
import {
  registerTestProvider,
  sseBodyFromEvents,
} from "@minimal-agent/core/testing/provider-fixture"

import type { CoreExtra, Scenario, ScenarioCtx } from "./harness.ts"

const bash = (command: string) => ({ name: "Bash", input: { command } })
const SID = "golden-sid"
const FIXTURES = join(import.meta.dir, "fixtures")

/** Fixed 24 byte PNG header (16x16), enough for the media probe. */
function pngBytes(): Uint8Array {
  const b = new Uint8Array(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8)
  b[19] = 16
  b[23] = 16
  return b
}

const openStore = (dir: string, cwd: string) =>
  SessionStore.open({
    sid: SID,
    dir,
    model: "test-model",
    cwd,
    systemHash: "h",
    toolsHash: "h",
    agentVersion: "test",
    now: () => new Date(Date.UTC(2026, 0, 2, 3, 4, 5)),
  })

const sessionDir = (root: string) => join(root, "sessions")

/** Core with a session store in the scenario root. */
const storeDeps = ({ root, cwd }: { root: string; cwd: string }): CoreExtra => ({
  store: openStore(sessionDir(root), cwd),
})

/** Load the saved transcript and make a new core that starts from it. */
async function resumeCore(ctx: ScenarioCtx): Promise<ScenarioCtx["core"]> {
  const loaded = loadSession(SID, sessionDir(ctx.root))
  const next = await ctx.newCore({
    store: SessionStore.open({
      sid: SID,
      dir: sessionDir(ctx.root),
      model: "test-model",
      cwd: ctx.cwd,
      systemHash: "h",
      toolsHash: "h",
      agentVersion: "test",
      existsOk: true,
    }),
  })
  next.replaceMessages(loaded.messages)
  next.noteSessionResumed()
  return next
}

const summaryEvents = (text: string) => [
  {
    type: "message_start",
    messageId: "msg_golden_summary",
    modelId: "golden-compact-model",
    initialUsage: { inputTokens: 1, outputTokens: 0 },
  },
  { type: "text_start", index: 0 },
  { type: "text_delta", index: 0, text },
  { type: "text_stop", index: 0 },
  { type: "message_delta", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
  { type: "message_stop" },
]

function compactDeps(): CoreExtra {
  registerTestProvider({
    id: "golden-compact-prov",
    models: [{ id: "golden-compact-model" }],
  })
  const transport: NetworkTransport = {
    id: "fake",
    request: async () =>
      new NetworkResponse({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        transport: { id: "fake", protocol: "h2" },
        body: sseBodyFromEvents(summaryEvents("GOLDEN-SUMMARY-TEXT") as never),
      }),
  }
  return {
    model: "golden-compact-model",
    providerId: "golden-compact-prov",
    networkClient: new NetworkClient({ primary: transport }),
  }
}

const editA = {
  name: "Edit",
  input: { file_path: "a.txt", old_string: "hello", new_string: "bye" },
}

/** Edit-after-state scenario: core gets a file tracking store so the precondition runs. */
const staleFile = (
  name: string,
  script: Scenario["script"],
  shell?: (file: string) => string,
): Scenario => ({
  name,
  script,
  setup: (cwd) => {
    writeFileSync(join(cwd, "a.txt"), "hello\n")
    // Bash keeps its own cwd from process start, so it needs the absolute path.
    if (shell) {
      const call = script.flatMap((r) => r.tools ?? []).find((t) => t.name === "Bash")
      if (call) call.input = { command: shell(join(cwd, "a.txt")) }
    }
  },
  coreDeps: ({ root, cwd }) => ({
    fileTrackingStore: new FileTrackingStore({ sid: SID, dir: join(root, "ft"), cwd }),
  }),
  run: async ({ turn }) => turn("edit a.txt"),
  keep: [-1],
})

export const EXTRA_SCENARIOS: Scenario[] = [
  {
    name: "binary-read",
    script: [{ tools: [{ name: "Read", input: { file_path: "blob.bin" } }] }],
    setup: (cwd) => {
      const bytes = new Uint8Array(512)
      for (let i = 0; i < bytes.length; i++) bytes[i] = i % 7 === 0 ? 0 : (i * 31) % 256
      writeFileSync(join(cwd, "blob.bin"), bytes)
    },
    run: async ({ turn }) => turn("read the binary file"),
  },
  {
    name: "data-uri",
    script: [
      {
        tools: [
          bash(`printf 'data:text/plain;base64,%s\\n' "$(head -c 600 /dev/zero | tr '\\0' 'A')"`),
        ],
      },
    ],
    run: async ({ turn }) => turn("print a data uri"),
  },
  {
    name: "image-read",
    script: [{ tools: [{ name: "Read", input: { file_path: "shot.png" } }] }],
    setup: (cwd) => writeFileSync(join(cwd, "shot.png"), pngBytes()),
    coreDeps: () => {
      registerTestProvider({
        id: "golden-img-prov",
        models: [{ id: "golden-img-model", capabilities: { modalities: { image: true } } }],
      })
      return { model: "golden-img-model", providerId: "golden-img-prov" }
    },
    run: async ({ turn }) => turn("look at the image"),
  },
  {
    name: "resume",
    script: [{ text: "first answer" }, { text: "second answer" }],
    coreDeps: storeDeps,
    run: async (ctx) => {
      await ctx.turn("turn one")
      const next = await resumeCore(ctx)
      await ctx.turnOn(next, "turn two after resume")
    },
  },
  {
    name: "kill-resume",
    script: [{ text: "earlier answer" }, { tools: [bash("echo hi")] }, { text: "after resume" }],
    keep: [-1],
    coreDeps: storeDeps,
    run: async (ctx) => {
      await ctx.turn("earlier work")
      await ctx.turn("start work")
      // Simulate a kill: cut the transcript right after the tool_use record.
      const path = join(sessionDir(ctx.root), `${SID}.jsonl`)
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean)
      const at = lines.findLastIndex(
        (l) => l.includes('"kind":"assistant"') && l.includes("tool_use"),
      )
      writeFileSync(path, `${lines.slice(0, at + 1).join("\n")}\n`)
      const next = await resumeCore(ctx)
      await ctx.turnOn(next, "continue after kill")
    },
  },
  {
    name: "stream-salvage",
    script: [
      {
        tools: [bash("echo salvaged")],
        stopReason: "end_turn",
        stopDetails: { type: "stream_closed_without_terminal" },
      },
    ],
    run: async ({ turn }) => turn("run a command, stream will drop"),
  },
  {
    name: "tail-compaction",
    script: [{ text: "a1" }, { text: "a2" }, { text: "a3" }, { text: "after compact" }],
    run: async ({ turn, core }) => {
      await turn("question one")
      await turn("question two")
      await turn("question three")
      await core.compact({ mode: "tail", keepTail: 2, reason: "manual" })
      await turn("question four")
    },
    keep: [-1],
  },
  {
    name: "local-compaction",
    script: [{ text: "a1" }, { text: "a2" }, { text: "after compact" }],
    coreDeps: () => compactDeps(),
    run: async ({ turn, core }) => {
      await turn("question one")
      await turn("question two")
      await core.compact({ mode: "local", keepTail: 2, reason: "manual" })
      await turn("question three")
    },
    keep: [-1],
  },
  {
    name: "unknown-tool",
    script: [{ tools: [{ name: "NoSuchTool", input: {} }] }],
    run: async ({ turn }) => turn("call a tool that does not exist"),
    keep: [-1],
  },
  {
    name: "grep-bad-regex",
    needsRg: true,
    script: [{ tools: [{ name: "Grep", input: { pattern: "(" } }] }],
    run: async ({ turn }) => turn("grep with a broken regex"),
    keep: [-1],
  },
  staleFile("stale-file-never-read", [{ tools: [editA] }]),
  staleFile(
    "stale-file-changed",
    [
      { tools: [{ name: "Read", input: { file_path: "a.txt" } }] },
      { tools: [bash("")] },
      { tools: [editA] },
    ],
    (f) => `echo x >> '${f}'`,
  ),
  staleFile(
    "stale-file-missing",
    [
      { tools: [{ name: "Read", input: { file_path: "a.txt" } }] },
      { tools: [bash("")] },
      { tools: [editA] },
    ],
    (f) => `rm '${f}'`,
  ),
  {
    name: "invalid-input-missing",
    script: [{ tools: [{ name: "Read", input: {} }] }],
    run: async ({ turn }) => turn("read with no path"),
    keep: [-1],
  },
  {
    name: "invalid-input-type",
    script: [{ tools: [{ name: "Bash", input: { command: 5 } }] }],
    run: async ({ turn }) => turn("run bash with a number"),
    keep: [-1],
  },
  {
    name: "plugin-handler-throws",
    script: [{ tools: [{ name: "FixtureThrow", input: {} }] }],
    pluginRoots: () => [join(FIXTURES, "throw")],
    run: async ({ turn }) => turn("call the throwing fixture tool"),
    keep: [-1],
  },
  {
    name: "policy-deny-default",
    script: [{ tools: [bash("echo hi")] }],
    pluginRoots: () => [join(FIXTURES, "deny")],
    run: async ({ turn }) => turn("run bash under a deny hook"),
    keep: [-1],
  },
  {
    // Pins the stream-interrupted continue text (text with no tool calls).
    name: "stream-interrupted-text-continue",
    script: [
      { text: "partial", stopDetails: { type: "stream_closed_without_terminal" } },
      { text: "rest" },
    ],
    run: async ({ turn }) => turn("write, the stream will drop"),
    keep: [-1],
  },
  {
    // Pins the placeholder core inserts for an empty assistant reply that
    // hit the output-token limit, plus the output-truncated continue text.
    name: "empty-response-placeholder",
    script: [{ stopReason: "max_tokens" }, { text: "rest" }],
    run: async ({ turn }) => turn("answer, the reply will be empty"),
    keep: [-1],
  },
]
