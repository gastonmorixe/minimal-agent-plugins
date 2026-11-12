/**
 * C47 proof: the plugin rebuilds, from the data fields, the same text that
 * core produces today (summary, preview, snippet, inputPreview, firstPrompt,
 * markdown dump, xml dump). Three synthetic fixture sessions.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import { createSessionsReadApi } from "@minimal-agent/core/host/sessions-read"

import { dumpMarkdown, dumpXml } from "./dump-from-data.ts"
import type { SessionRecordsView, ToolCallHit } from "./host-types.ts"
import {
  firstPromptOf,
  inputPreviewOf,
  previewOf,
  snippetOf,
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

describe.each(Object.keys(fixtures))("C47 equal text: %s", (sid) => {
  it("summary and preview equal for several preview budgets", async () => {
    for (const previewChars of [80, 600]) {
      const w = await api.window(sid, { anchor: "start", limit: 100, previewChars })
      if (!w) throw new Error("no window")
      for (const r of w.items) {
        expect(summaryOf(r as never)).toBe(r.summary)
        const p = previewOf(r as never)
        expect(p.text).toBe(r.preview)
        expect(p.clipped).toBe(r.clipped)
        expect(p.fullChars).toBe(r.fullChars)
      }
    }
  })

  it("search snippet equal", async () => {
    for (const query of [
      "needle-one",
      "think",
      "boom",
      "after",
      "e",
      "thinking",
      "tool_use",
      "user:",
    ]) {
      for (const previewChars of [80, 160]) {
        const r = await api.search({ sid, query, previewChars, limit: 200 })
        for (const h of r.hits) expect(snippetOf(h as never)).toBe(h.preview)
      }
    }
  })

  it("inputPreview and firstPrompt equal", async () => {
    const t = await api.toolCalls(sid, { limit: 200 })
    for (const h of t?.hits ?? []) expect(inputPreviewOf(h as never)).toBe(h.inputPreview)
    const m = await api.meta(sid)
    if (!m) throw new Error("no meta")
    expect(firstPromptOf(m as never)).toBe(m.firstPrompt)
  })

  it("markdown and xml dumps equal", async () => {
    const rec = await api.records(sid)
    if (!rec) throw new Error("no records")
    const v = rec as unknown as SessionRecordsView
    const md = await api.dump(sid)
    const xml = await api.dump(sid, { format: "xml" })
    expect(dumpMarkdown(v)).toBe(md?.text ?? "")
    expect(dumpXml(v)).toBe(xml?.text ?? "")
  })
})

describe("C47 edge cases", () => {
  it("unserializable input uses the placeholder", () => {
    const h: ToolCallHit = {
      index: 0,
      ts: null,
      tool: "T",
      toolUseId: null,
      inputPreview: "[unserializable]",
      inputJson: null,
      inputPreviewChars: 200,
    }
    expect(inputPreviewOf(h)).toBe("[unserializable]")
  })

  it("fixtures cover clip, data-uri scrub and a dump with an error result", async () => {
    const w = await api.window("fx-two", { anchor: "start", limit: 100, previewChars: 80 })
    expect(w?.items.some((r) => r.clipped)).toBe(true)
    const md1 = await api.dump("fx-one")
    expect(md1?.text).toContain("redacted-asset")
    expect(md1?.text).toContain("**[ERROR]**")
  })
})
