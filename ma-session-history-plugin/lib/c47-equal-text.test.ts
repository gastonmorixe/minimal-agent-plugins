/**
 * C47 proof: the plugin rebuilds, from the data fields alone, the text that
 * core produced before S13.3 (summary, preview, snippet, inputPreview,
 * firstPrompt, markdown dump, xml dump). The frozen golden files in
 * `__golden__/` hold that text. Three synthetic fixture sessions.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import { createSessionsReadApi } from "@minimal-agent/core/host/sessions-read"

import { dumpMarkdown, dumpXml } from "./dump-from-data.ts"
import type {
  RecordView,
  SearchHit,
  SessionMetaView,
  SessionRecordsView,
  ToolCallHit,
} from "./host-types.ts"
import {
  bodyFromParts,
  firstPromptOf,
  inputPreviewOf,
  previewOf,
  snippetOf,
  summaryFromFacts,
  summaryOf,
} from "./render-from-data.ts"

const dir = join(import.meta.dir, ".c47-fixtures")
mkdirSync(dir, { recursive: true })
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const T = "2026-01-01T00:00:00.000Z"
const meta = (sid: string) => ({
  kind: "meta",
  formatVersion: 1,
  sid,
  createdAt: T,
  model: "model-x",
  cwd: "/proj/demo",
  systemHash: "s",
  toolsHash: "t",
  agentVersion: "0.0.0",
})
const LONG = `${"alpha beta  gamma\n".repeat(80)}NEEDLE-ONE ${"delta ".repeat(120)}`
const B64 = "A".repeat(400)

const fixtures: Record<string, unknown[]> = {
  "fx-one": [
    meta("fx-one"),
    {
      kind: "user",
      ts: T,
      id: "u1",
      content: `  first   prompt\nwith   spaces ${"w".repeat(200)} `,
    },
    {
      kind: "assistant",
      ts: T,
      stopReason: "tool_use",
      content: [
        {
          type: "thinking",
          thinking: 'think <a> & "b"\nline2',
          signature: "sig-abcdefghijklmnopqrstu",
        },
        { type: "thinking", thinking: "", signature: "sig-redacted-abcdefghijklmnop" },
        { type: "redacted_thinking", data: "ENC123456" },
        { type: "text", text: "I will run it" },
        {
          type: "tool_use",
          id: "tu-1",
          name: "Bash",
          input: { cmd: "echo 'hi' > \"x\"", n: [1, 2] },
        },
      ],
    },
    {
      kind: "tool_result",
      ts: T,
      tool_use_id: "tu-1",
      isError: true,
      content: "boom <err>\nline2",
    },
    {
      kind: "user",
      ts: T,
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu-1",
          is_error: true,
          content: `boom <err>\nline2 data:image/png;base64,${B64} z`,
        },
        { type: "text", text: "next" },
      ],
    },
    { kind: "assistant", ts: T, stopReason: "", content: [] },
  ],
  "fx-two": [
    meta("fx-two"),
    {
      kind: "user",
      ts: T,
      id: "u1",
      content: [
        { type: "text", text: "Question one" },
        { type: "text", text: "more" },
      ],
    },
    { kind: "assistant", ts: T, stopReason: "end_turn", content: [{ type: "text", text: LONG }] },
    { kind: "note", ts: T, text: "a note NEEDLE-ONE inside" },
    {
      kind: "compact",
      ts: T,
      reason: "manual",
      compactKind: "local",
      messagesBefore: 9,
      messagesAfter: 2,
      replacementMessages: [
        { role: "user", content: "summary of the past NEEDLE-ONE" },
        { role: "assistant", content: "ack" },
      ],
    },
    { kind: "user", ts: T, id: "u2", content: "after compact" },
    { kind: "assistant", ts: T, stopReason: "end_turn", content: [{ type: "text", text: "done" }] },
  ],
  "fx-three": [
    meta("fx-three"),
    { kind: "user", ts: T, id: "u1", content: "one" },
    { kind: "assistant", ts: T, stopReason: "end_turn", content: [{ type: "text", text: "two" }] },
    { kind: "rewind", ts: T, to: "u1", droppedCount: 2 },
    { kind: "user", ts: T, id: "u3", content: "redo" },
    {
      kind: "assistant",
      ts: T,
      stopReason: "tool_use",
      content: [
        { type: "tool_use", id: "tu-9", name: "Read", input: { path: "a/b.txt" } },
        { type: "tool_use", id: "tu-10", name: "Bash", input: { cmd: "ls" } },
      ],
    },
    {
      kind: "tool_result",
      ts: T,
      tool_use_id: "tu-9",
      isError: false,
      content: `data:image/png;base64,${B64} tail`,
    },
    {
      kind: "user",
      ts: T,
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu-9",
          content: [
            { type: "text", text: `x data:image/png;base64,${B64} y` },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "zz" } },
          ],
        },
        { type: "tool_result", tool_use_id: "tu-10", content: "" },
        { type: "document", source: { type: "url", url: "https://example.test/d.pdf" } },
      ],
    },
    { kind: "assistant", ts: T, stopReason: "end_turn", content: [{ type: "text", text: "end" }] },
  ],
}
for (const [sid, recs] of Object.entries(fixtures)) {
  writeFileSync(join(dir, `${sid}.jsonl`), `${recs.map((r) => JSON.stringify(r)).join("\n")}\n`)
}

const api = createSessionsReadApi({ dir })

describe("C47 edge cases", () => {
  it("unserializable input uses the placeholder", () => {
    const h: ToolCallHit = {
      index: 0,
      ts: null,
      tool: "T",
      toolUseId: null,
      inputJson: null,
      inputPreviewChars: 200,
    }
    expect(inputPreviewOf(h)).toBe("[unserializable]")
  })

  it("fixtures cover clip, data-uri scrub and a dump with an error result", async () => {
    const w = await api.window("fx-two", { anchor: "start", limit: 100, previewChars: 80 })
    const p = (w?.items ?? []).map((r) => previewOf(r as unknown as RecordView))
    expect(p.some((x) => x.clipped)).toBe(true)
    const rec = (await api.records("fx-one")) as unknown as SessionRecordsView
    const md1 = dumpMarkdown(rec)
    expect(md1).toContain("redacted-asset")
    expect(md1).toContain("**[ERROR]**")
  })
})

// ---------------------------------------------------------------------------
// Data path alone, frozen golden text, edge cases
// ---------------------------------------------------------------------------

const goldenDir = join(import.meta.dir, "__golden__")
const goldenPath = (sid: string) => join(goldenDir, `c47-${sid}.json`)
const BUDGETS = [80, 600]
const SEARCH_BUDGETS = [80, 160]
const QUERIES = ["needle-one", "think", "boom", "after", "e", "thinking", "tool_use", "user:"]

interface Golden {
  windows: Record<
    string,
    { summary: string; preview: string; clipped: boolean; fullChars: number }[]
  >
  snippets: Record<string, string[]>
  inputPreviews: string[]
  firstPrompt: string | null
  dumpMarkdown: string
  dumpXml: string
}

/** Text kinds from the data fields alone. */
async function dataText(sid: string): Promise<Golden> {
  const g: Golden = {
    windows: {},
    snippets: {},
    inputPreviews: [],
    firstPrompt: null,
    dumpMarkdown: "",
    dumpXml: "",
  }
  for (const pc of BUDGETS) {
    const w = await api.window(sid, { anchor: "start", limit: 100, previewChars: pc })
    g.windows[String(pc)] = (w?.items ?? []).map((raw) => {
      const r = raw as unknown as RecordView
      const p = previewOf(r)
      return { summary: summaryOf(r), preview: p.text, clipped: p.clipped, fullChars: p.fullChars }
    })
  }
  for (const q of QUERIES) {
    for (const pc of SEARCH_BUDGETS) {
      const r = await api.search({
        sid,
        query: q,
        previewChars: pc,
        limit: 200,
        renderBody: bodyFromParts,
      })
      g.snippets[`${q}|${pc}`] = r.hits.map((h) => snippetOf(h as unknown as SearchHit))
    }
  }
  g.inputPreviews = ((await api.toolCalls(sid, { limit: 200 }))?.hits ?? []).map((h) =>
    inputPreviewOf(h as unknown as ToolCallHit),
  )
  const m = await api.meta(sid)
  g.firstPrompt = m ? firstPromptOf(m as unknown as SessionMetaView) : null
  const rec = (await api.records(sid)) as unknown as SessionRecordsView
  g.dumpMarkdown = dumpMarkdown(rec)
  g.dumpXml = dumpXml(rec)
  return g
}

describe("C47 data fields are present", () => {
  it("every view the test uses carries data fields", async () => {
    for (const sid of Object.keys(fixtures)) {
      const w = await api.window(sid, { anchor: "start", limit: 100, previewChars: 80 })
      expect(w?.items.length).toBeGreaterThan(0)
      for (const r of w?.items ?? []) {
        expect(Array.isArray(r.parts)).toBe(true)
        expect(r.facts).toBeDefined()
        expect(typeof r.previewChars).toBe("number")
      }
      let hits = 0
      for (const query of QUERIES) {
        const s = await api.search({ sid, query, previewChars: 80, limit: 200 })
        for (const h of s.hits) {
          hits++
          expect(Array.isArray(h.parts)).toBe(true)
          expect(typeof h.matchAt).toBe("number")
          expect(typeof h.matchLength).toBe("number")
          expect(typeof h.previewChars).toBe("number")
        }
      }
      expect(hits).toBeGreaterThan(0)
      for (const h of (await api.toolCalls(sid, { limit: 200 }))?.hits ?? []) {
        expect(h.inputJson !== undefined).toBe(true)
        expect(typeof h.inputPreviewChars).toBe("number")
      }
      const m = await api.meta(sid)
      expect(m?.firstPromptParts !== undefined).toBe(true)
      expect(typeof m?.firstPromptChars).toBe("number")
      const rec = await api.records(sid)
      expect(rec).not.toBeNull()
      expect(rec?.records.length).toBeGreaterThan(0)
      expect(rec?.messages.length).toBeGreaterThan(0)
    }
  })

  it("tool call hits exist in at least one fixture", async () => {
    const t = await api.toolCalls("fx-one", { limit: 200 })
    expect(t?.hits.length).toBeGreaterThan(0)
  })
})

describe.each(Object.keys(fixtures))("C47 data path equals the golden file: %s", (sid) => {
  it("data-only text equals the frozen golden file", async () => {
    expect(existsSync(goldenPath(sid))).toBe(true)
    const golden = JSON.parse(readFileSync(goldenPath(sid), "utf8")) as Golden
    expect(await dataText(sid)).toEqual(golden)
  })
})

describe("C47 unknown kind and image source edge", () => {
  const zeroFacts = {
    contentIsString: null,
    toolResultCount: 0,
    textBlockCount: 0,
    blockCount: 0,
    toolNames: [],
    hasText: false,
    stopReason: null,
    isError: null,
    toolUseId: null,
    model: null,
    cwd: null,
    compactKind: null,
    reason: null,
    messagesBefore: null,
    messagesAfter: null,
    rewindTo: null,
    droppedCount: null,
    backupSid: null,
    droppedRecordCount: null,
    pid: null,
    hostname: null,
    round: null,
  }

  it("summaryFromFacts for an unknown kind prints the raw JSON of the record", () => {
    const rec = { kind: "zzz", ts: "t" }
    const raw = JSON.stringify(rec)
    expect(summaryFromFacts("zzz", zeroFacts, [{ kind: "raw", text: raw, toolName: null }])).toBe(
      `unknown · ${raw}`,
    )
  })

  it("image and document with a missing source detail print undefined like core", () => {
    const mk = (block: Record<string, unknown>): SessionRecordsView =>
      ({
        sid: "x",
        meta: null,
        records: [],
        messages: [{ role: "user", content: [block] }],
      }) as unknown as SessionRecordsView
    expect(dumpMarkdown(mk({ type: "image", source: { type: "file" } }))).toContain(
      "**Image**: (file undefined)",
    )
    expect(dumpMarkdown(mk({ type: "image", source: { type: "url" } }))).toContain(
      "**Image**: (url undefined)",
    )
    expect(dumpMarkdown(mk({ type: "document", source: { type: "base64" } }))).toContain(
      "**Document**: (base64 undefined)",
    )
  })
})
