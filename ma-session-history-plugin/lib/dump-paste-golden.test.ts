/**
 * The plugin twin of the cli paste parity test (cli
 * `src/commands/session-dump-parity.test.ts`, `fx-paste`). The fixture here
 * is a copy of the cli `pasteFixture`: a found paste, a missing paste, a bad
 * id, two refs in one text, a CRLF body, and a compaction block whose ref
 * stays raw. It adds one turn: a ref inside a user backtick fence, which
 * gets a tilde fence (the core fence rule).
 *
 * This golden is NOT the cli golden. The SessionHistory dump goes to the
 * model, so it neutralizes each display label and text, and it caps each
 * display text at 8192 bytes (`MODEL_DUMP_PASTE_MAX_BYTES`). The cli dump
 * does neither. So the text can differ, and this test has its own golden
 * file. `UPDATE_DUMP_GOLDEN=1` writes it again.
 *
 * @module plugins/session-history/lib/dump-paste-golden.test
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { createSessionsReadApi } from "@minimal-agent/core/host/sessions-read"
import { loadSidebandOnly, type SidebandApi } from "@minimal-agent/core/host/sideband"

import { MODEL_DUMP_PASTE_MAX_BYTES } from "../handlers/session_history.ts"

import { dumpMarkdown, dumpXml } from "./dump-from-data.ts"
import type { SessionRecordsView } from "./host-types.ts"

const PLUGINS = resolve(import.meta.dir, "../..")
const SID = "fx-paste"
const T = "2026-01-01T00:00:00.000Z"
const GOLDEN = join(import.meta.dir, "__golden__", "dump-fx-paste.json")

const root = mkdtempSync(join(tmpdir(), "sh-dump-paste-golden-"))
const dir = join(root, "sessions")
const pasteDir = join(dir, `${SID}.files`, "paste")
mkdirSync(pasteDir, { recursive: true })
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** The paste files: `<id>.txt` to its text (the same as the cli `pasteFiles`). */
const pasteFiles: Record<string, string> = {
  abc12: "first line\nhas ``` fence\n",
  crlf1: "one\r\ntwo\r\n",
}
for (const [id, text] of Object.entries(pasteFiles)) {
  writeFileSync(join(pasteDir, `${id}.txt`), text)
}

const noop = (): void => {}
const sb: SidebandApi = await loadSidebandOnly({
  roots: { embedded: [PLUGINS], user: [join(root, "none")], project: [join(root, "none")] },
  enabledPluginIds: new Set(["sideband", "paste", "session-history"]),
  display: { hostOptions: { sessionsDir: dir } },
  diagnostics: {
    sessionId: undefined,
    emit: noop,
    emergency: noop,
    alert: noop,
    critical: noop,
    error: noop,
    warn: noop,
    notice: noop,
    info: noop,
    debug: noop,
  },
})

const ref = (id: string): string => sb.render("paste", { attrs: { id, bytes: 1, lines: 1 } })

/** The records of the fixture session (a copy of the cli `pasteFixture`). */
const records: unknown[] = [
  {
    kind: "meta",
    formatVersion: 1,
    sid: SID,
    createdAt: T,
    model: "model-x",
    cwd: "/proj/demo",
    systemHash: "s",
    toolsHash: "t",
    agentVersion: "0.0.0",
  },
  { kind: "user", ts: T, id: "u0", content: "old turn" },
  { kind: "assistant", ts: T, stopReason: "end_turn", content: [{ type: "text", text: "a0" }] },
  {
    kind: "compact",
    ts: T,
    reason: "manual",
    compactKind: "local",
    messagesBefore: 2,
    messagesAfter: 2,
    replacementMessages: [
      {
        role: "user",
        content: [
          { type: "text", text: `summary ${ref("abc12")}`, sideband: { kind: "compaction" } },
        ],
      },
      { role: "assistant", content: "ack" },
    ],
  },
  { kind: "user", ts: T, id: "u1", content: `found ${ref("abc12")} end` },
  { kind: "assistant", ts: T, stopReason: "end_turn", content: [{ type: "text", text: "a1" }] },
  {
    kind: "user",
    ts: T,
    id: "u2",
    content: [
      { type: "text", text: `missing ${ref("zzz99")} bad ${ref("BAD!")}` },
      { type: "text", text: `${ref("abc12")}\n${ref("crlf1")}` },
    ],
  },
  { kind: "assistant", ts: T, stopReason: "end_turn", content: [{ type: "text", text: "a2" }] },
  { kind: "user", ts: T, id: "u3", content: `\`\`\`\n${ref("abc12")}\n\`\`\`\nafter fence` },
  { kind: "assistant", ts: T, stopReason: "end_turn", content: [{ type: "text", text: "a3" }] },
]
writeFileSync(join(dir, `${SID}.jsonl`), `${records.map((r) => JSON.stringify(r)).join("\n")}\n`)

const api = createSessionsReadApi({ dir })

/** The dump with the same options as the SessionHistory tool. */
async function render(format: "markdown" | "xml"): Promise<string> {
  const v = (await api.records(SID)) as unknown as SessionRecordsView
  const opts = { sid: SID, maxBytes: MODEL_DUMP_PASTE_MAX_BYTES }
  return format === "xml" ? dumpXml(v, sb, opts) : dumpMarkdown(v, sb, opts)
}

if (process.env.UPDATE_DUMP_GOLDEN === "1") {
  const g = { markdown: await render("markdown"), xml: await render("xml") }
  writeFileSync(GOLDEN, `${JSON.stringify(g, null, 2)}\n`)
}

describe(`SessionHistory dump golden: ${SID}`, () => {
  test("the boot has the paste display", () => {
    expect(sb.hasDisplay("paste")).toBe(true)
  })

  for (const format of ["markdown", "xml"] as const) {
    test(`${format} is byte-equal to the golden file`, async () => {
      const g = JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, string>
      expect(await render(format)).toBe(g[format] ?? "")
    })
  }

  test("only the compaction ref stays raw", async () => {
    const md = await render("markdown")
    expect(sb.find(md, { kinds: ["paste"] }).length).toBe(1)
    expect(md).toContain("summary <")
  })
})
