/**
 * Recorder for the NEW compacted session fixtures (rows written with the S7.1 `meta` key).
 * Run: bun tests/request-golden/fixtures/record-new-compacted.ts (from minimal-agent-plugins).
 * It drives the harness (fixed clock, fixed sid, stub send, real SessionStore) through
 * a short session, one compaction (tail, then local), and one more user turn.
 * It copies the session JSONL out, replaces the temp root with /w/proj. No row is edited.
 * Remote compaction is not recorded: it needs a provider adapter with `compact`.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import {
  NetworkClient,
  NetworkResponse,
  type NetworkTransport,
} from "@minimal-agent/core/host/network"
import { SessionStore } from "@minimal-agent/core/host-kit/session-store"
import {
  registerTestProvider,
  sseBodyFromEvents,
} from "@minimal-agent/core/testing/provider-fixture"

import { runScenario, type Scenario } from "../harness.ts"

const SID = "golden-sid"
const OUT = import.meta.dir

const openStore = (root: string, cwd: string) =>
  SessionStore.open({
    sid: SID,
    dir: join(root, "sessions"),
    model: "test-model",
    cwd,
    systemHash: "h",
    toolsHash: "h",
    agentVersion: "test",
    now: () => new Date(Date.UTC(2026, 0, 2, 3, 4, 5)),
  })

const summaryEvents = [
  {
    type: "message_start",
    messageId: "msg_golden_summary",
    modelId: "golden-compact-model",
    initialUsage: { inputTokens: 1, outputTokens: 0 },
  },
  { type: "text_start", index: 0 },
  { type: "text_delta", index: 0, text: "GOLDEN-SUMMARY-TEXT" },
  { type: "text_stop", index: 0 },
  { type: "message_delta", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
  { type: "message_stop" },
]

function localDeps() {
  registerTestProvider({ id: "golden-compact-prov", models: [{ id: "golden-compact-model" }] })
  const transport: NetworkTransport = {
    id: "fake",
    request: async () =>
      new NetworkResponse({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        transport: { id: "fake", protocol: "h2" },
        body: sseBodyFromEvents(summaryEvents as never),
      }),
  }
  return {
    model: "golden-compact-model",
    providerId: "golden-compact-prov",
    networkClient: new NetworkClient({ primary: transport }),
  }
}

/** Copy the session file to the fixture path with the temp root replaced. */
function save(root: string, out: string): void {
  const raw = readFileSync(join(root, "sessions", `${SID}.jsonl`), "utf8")
  let n = 0
  const rows = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const row = JSON.parse(line.split(root).join("/w/proj")) as Record<string, unknown>
      n += 1
      // Normalize only live values: ts and id. Keys and structure stay as written.
      const meta = row.meta as Record<string, unknown> | undefined
      if (meta && meta.at !== row.ts) throw new Error(`meta.at differs from ts in row ${n}`)
      if (typeof row.ts === "string") {
        row.ts = new Date(Date.UTC(2026, 0, 2, 3, 4, 5, n)).toISOString()
        // meta.at is the same live clock value as ts. Normalize both the same way.
        if (meta) meta.at = row.ts
      }
      if (typeof row.id === "string") row.id = `id-${String(n).padStart(3, "0")}`
      return JSON.stringify(row)
    })
  writeFileSync(join(OUT, out), `${rows.join("\n")}\n`)
}

function scenario(name: string, mode: "tail" | "local", out: string): Scenario {
  return {
    name,
    script: [{ text: "a1" }, { text: "a2" }, { text: "a3" }, { text: "after compact" }],
    coreDeps: ({ root, cwd }) => ({
      store: openStore(root, cwd),
      ...(mode === "local" ? localDeps() : {}),
    }),
    run: async ({ turn, core, root }) => {
      await turn("question one")
      await turn("question two")
      await turn("question three")
      await core.compact({ mode, keepTail: 2, reason: "manual" })
      await turn("question four")
      save(root, out)
    },
  }
}

await runScenario(scenario("record-new-tail", "tail", "new-compacted-tail.jsonl"))
await runScenario(scenario("record-new-local", "local", "new-compacted-local.jsonl"))
