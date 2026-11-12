/**
 * Recorder for the OLD attachments session fixture (S1.3 restore test).
 * Run: bun tests/request-golden/fixtures/record-old-attachments.ts [outPath] (from minimal-agent-plugins).
 * Default outPath: CORE_FIXTURE below (one file in the core repo, core stays unmodified).
 * It drives the harness (fixed clock, fixed sid, real SessionStore, real ModeManager,
 * real turnAttachments seam) through three turns:
 *   1. mode switch to ask, then "hello old session" (mode-change stamp block + text)
 *   2. a turn with a runtime attachment block + text
 *   3. a turn whose send throws before any assistant output (trailing user row, no reply)
 * It copies the session JSONL out. Only ts, id and the temp root are normalized.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { SessionStore } from "@minimal-agent/core/host-kit/session-store"

import { runScenario, type Scenario } from "../harness.ts"

const SID = "golden-sid"
/** Default output: the fixtures folder of the core repo (sibling checkout). */
const CORE_FIXTURE = resolve(
  import.meta.dir,
  "../../../../minimal-agent-core/src/session/fixtures/old-session-attachments.jsonl",
)
const OUT = process.argv[2] ? resolve(process.argv[2]) : CORE_FIXTURE

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
      if (typeof row.ts === "string") {
        row.ts = new Date(Date.UTC(2026, 0, 2, 3, 4, 5, n)).toISOString()
      }
      if (typeof row.id === "string") row.id = `id-${String(n).padStart(3, "0")}`
      return JSON.stringify(row)
    })
  writeFileSync(out, `${rows.join("\n")}\n`)
}

let attach = false
let sends = 0

const scenario: Scenario = {
  name: "record-old-attachments",
  script: [],
  coreDeps: ({ root, cwd }) => ({
    store: openStore(root, cwd),
    turnAttachments: [
      {
        toAttachment: () =>
          attach ? { type: "text", text: '<ma::agent::tasks total="1" done="0" />' } : null,
      },
    ],
    sendFn: async function* () {
      sends += 1
      if (sends === 3) throw new Error("recorder: send fails before any assistant output")
      const text = sends === 1 ? "hi there" : "second reply"
      yield text
      return {
        blocks: [{ type: "text", text }],
        text,
        stopReason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 3 },
      }
    },
  }),
  run: async ({ turn, modes, root }) => {
    modes.setMode("ask")
    await turn("hello old session")
    attach = true
    await turn("second question")
    await turn("unsent draft").catch((e: unknown) => {
      if (!(e as Error).message.includes("recorder: send fails")) throw e
    })
    save(root, OUT)
  },
}

await runScenario(scenario)
