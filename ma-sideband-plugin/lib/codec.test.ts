import { describe, expect, test } from "bun:test"

import createCodec from "./codec.ts"
import { TEST_KINDS as K, makeRegistry } from "./testing.ts"
import type { SidebandKind, SidebandMessage } from "./types.ts"

const codec = createCodec(makeRegistry())

// Mirrors of the core emitters. Each cites the source (core worktree, same commit).
// escapeAttr: tools/binary-guard.ts:296, tools/embedded-payload-scrub.ts:200 (E3, no ">").
const e3 = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
// escapeTagAttr: plugins/loader/helpers.ts:148 (E4).
const e4 = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

interface Row {
  name: string
  kind: SidebandKind
  msg: SidebandMessage
  expected: string
}

const SP = 'a&b "q" <t> >'
const rows: Row[] = [
  // modes/PROMPTS.ts:13 activeModeStamp (raw)
  {
    name: "1 mode-active",
    kind: K.modeActive!,
    msg: { kind: "mode-active", attrs: { id: "ask", since: "2026-01-02T03:04:05.000Z" } },
    expected: '<ma::agent::mode-active id="ask" since="2026-01-02T03:04:05.000Z" />',
  },
  {
    name: "1 special",
    kind: K.modeActive!,
    msg: { kind: "mode-active", attrs: { id: SP, since: "s" } },
    expected: `<ma::agent::mode-active id="${SP}" since="s" />`,
  },
  // modes/PROMPTS.ts:18 modeChangeAttachment (raw)
  {
    name: "2 mode-change",
    kind: K.modeChange!,
    msg: { kind: "mode-change", attrs: { from: "default", to: "ask", at: "t" } },
    expected: '<ma::agent::mode-change from="default" to="ask" at="t" />',
  },
  {
    name: "2 special",
    kind: K.modeChange!,
    msg: { kind: "mode-change", attrs: { from: SP, to: "b", at: "t" } },
    expected: `<ma::agent::mode-change from="${SP}" to="b" at="t" />`,
  },
  // session/blob-store.ts:512 formatRawOutputFooter (raw)
  {
    name: "3 raw-output",
    kind: K.rawOutput!,
    msg: {
      kind: "raw-output",
      attrs: { path: "/w/a.blobs/t1.raw", size: "1.5kB", sha256: "ab12cd34ef567890" },
    },
    expected:
      '<ma::agent::raw-output path="/w/a.blobs/t1.raw" size="1.5kB" sha256="ab12cd34ef567890" />',
  },
  {
    name: "3 special",
    kind: K.rawOutput!,
    msg: { kind: "raw-output", attrs: { path: SP, size: "1B", sha256: "x" } },
    expected: `<ma::agent::raw-output path="${SP}" size="1B" sha256="x" />`,
  },
  // tools/binary-guard.ts:252 tag line (E3)
  {
    name: "4 binary-result",
    kind: K.binaryResult!,
    msg: {
      kind: "binary-result",
      attrs: {
        mime: "application/pdf",
        size: "4.97MB",
        path: "/w/f.pdf",
        sha256: "ab12",
        tool: "Fetch",
      },
    },
    expected:
      '<ma::agent::binary-result mime="application/pdf" size="4.97MB" path="/w/f.pdf" sha256="ab12" tool="Fetch" />',
  },
  {
    name: "4 optional omitted",
    kind: K.binaryResult!,
    msg: { kind: "binary-result", attrs: { mime: "text/x", size: "3B" } },
    expected: '<ma::agent::binary-result mime="text/x" size="3B" />',
  },
  {
    name: "4 special",
    kind: K.binaryResult!,
    msg: { kind: "binary-result", attrs: { mime: SP, size: "3B", tool: SP } },
    expected: `<ma::agent::binary-result mime="${e3(SP)}" size="3B" tool="${e3(SP)}" />`,
  },
  // tools/binary-guard.ts:300 formatBinaryOptInContent (E3, raw body, block)
  {
    name: "5 binary body",
    kind: K.binaryBody!,
    msg: {
      kind: "binary-result",
      attrs: { mime: "image/png", size: "3B", encoding: "base64" },
      body: "AQID",
    },
    expected:
      '<ma::agent::binary-result mime="image/png" size="3B" encoding="base64">\nAQID\n</ma::agent::binary-result>',
  },
  {
    name: "5 special",
    kind: K.binaryBody!,
    msg: {
      kind: "binary-result",
      attrs: { mime: SP, size: "3B", encoding: "base64", path: SP },
      body: "A<&>",
    },
    expected: `<ma::agent::binary-result mime="${e3(SP)}" size="3B" encoding="base64" path="${e3(SP)}">\nA<&>\n</ma::agent::binary-result>`,
  },
  // tools/embedded-payload-scrub.ts:188 formatRedactedAssetStub (E3)
  {
    name: "6 redacted-asset",
    kind: K.redactedAsset!,
    msg: {
      kind: "redacted-asset",
      attrs: {
        kind: "data_uri",
        mime: "image/png",
        size: "1.5kB",
        chars_removed: 2048,
        tool: "Fetch",
      },
    },
    expected:
      '<ma::agent::redacted-asset kind="data_uri" mime="image/png" size="1.5kB" chars_removed="2048" tool="Fetch" />',
  },
  {
    name: "6 special",
    kind: K.redactedAsset!,
    msg: {
      kind: "redacted-asset",
      attrs: { kind: "data_uri", mime: SP, size: "1B", chars_removed: 1 },
    },
    expected: `<ma::agent::redacted-asset kind="data_uri" mime="${e3(SP)}" size="1B" chars_removed="1" />`,
  },
  // tools/embedded-payload-scrub.ts:198 formatSanitizerFooter (E3)
  {
    name: "7 context-sanitizer",
    kind: K.sanitizer!,
    msg: {
      kind: "context-sanitizer",
      attrs: { removed: 2, kinds: "data_uri", chars_removed: 4096, saved: "3.0kB" },
    },
    expected:
      '<ma::agent::context-sanitizer removed="2" kinds="data_uri" chars_removed="4096" saved="3.0kB" />',
  },
  {
    name: "7 special",
    kind: K.sanitizer!,
    msg: {
      kind: "context-sanitizer",
      attrs: { removed: 1, kinds: "data_uri", chars_removed: 1, saved: SP },
    },
    expected: `<ma::agent::context-sanitizer removed="1" kinds="data_uri" chars_removed="1" saved="${e3(SP)}" />`,
  },
  // agent/tool-preview-budget.ts:92 formatDiagnosticsAnnotation without the leading "\n\n" (count raw)
  {
    name: "8 diagnostics",
    kind: K.diagnostics!,
    msg: { kind: "diagnostics", attrs: { count: 2, scope: "ad-hoc" }, body: "note one\nnote two" },
    expected:
      '<ma::agent::diagnostics count="2" scope="ad-hoc">\nnote one\nnote two\n</ma::agent::diagnostics>',
  },
  {
    name: "8 no scope, special body",
    kind: K.diagnostics!,
    msg: { kind: "diagnostics", attrs: { count: 1 }, body: SP },
    expected: `<ma::agent::diagnostics count="1">\n${SP}\n</ma::agent::diagnostics>`,
  },
  // loops/tool-round.ts:522 inline policy tag (raw body)
  {
    name: "9 policy",
    kind: K.policy!,
    msg: { kind: "policy", body: "input rewritten by policy: path" },
    expected: "<ma::agent::policy>input rewritten by policy: path</ma::agent::policy>",
  },
  {
    name: "9 special",
    kind: K.policy!,
    msg: { kind: "policy", body: SP },
    expected: `<ma::agent::policy>${SP}</ma::agent::policy>`,
  },
  // plugins/loader.ts:1161 buildBlock (E4 name, raw body, block)
  {
    name: "10 sys tool",
    kind: K.sysTool!,
    msg: { kind: "tool", attrs: { name: "WebSearch" }, body: "Body text." },
    expected: '<ma::sys::tool name="WebSearch">\nBody text.\n</ma::sys::tool>',
  },
  {
    name: "10 special",
    kind: K.sysTool!,
    msg: { kind: "tool", attrs: { name: SP }, body: SP },
    expected: `<ma::sys::tool name="${e4(SP)}">\n${SP}\n</ma::sys::tool>`,
  },
  // agent/context-compact.ts:105,264 (kind enum, literal)
  {
    name: "11 compaction tail",
    kind: K.compaction!,
    msg: { kind: "compaction", attrs: { kind: "tail" } },
    expected: '<ma::context::compaction kind="tail" />',
  },
  {
    name: "11 compaction local",
    kind: K.compaction!,
    msg: { kind: "compaction", attrs: { kind: "local" } },
    expected: '<ma::context::compaction kind="local" />',
  },
]

describe("render table (v1 bytes)", () => {
  for (const r of rows) {
    test(r.name, () => {
      expect(codec.render(r.kind, r.msg)).toBe(r.expected)
    })
  }
  test("e3 leaves > raw, e4 escapes it", () => {
    expect(e3(">")).toBe(">")
    expect(e4(">")).toBe("&gt;")
  })
  test("row 12 system-instruction passes through", () => {
    const text = "<system-instruction>\nYou are X.\n</system-instruction>"
    expect(codec.parse(text)).toEqual([])
    expect(codec.neutralize(text)).toBe(text)
  })
})

describe("parse round trip", () => {
  const trip = rows.filter((r) => !r.name.includes("special"))
  for (const r of trip) {
    test(r.name, () => {
      const nodes = createCodec(makeRegistry([r.kind])).parse(codec.render(r.kind, r.msg))
      expect(nodes.length).toBe(1)
      const n = nodes[0]!
      expect(n.kind).toBe(r.msg.kind)
      expect(n.form).toBe("v1")
      expect(n.body).toBe(r.msg.body)
      const want = Object.fromEntries(
        Object.entries(r.msg.attrs ?? {}).map(([k, v]) => [k, String(v)]),
      )
      expect(n.attrs).toEqual(want)
      expect(n.span).toEqual({ start: 0, end: r.expected.length })
    })
  }
})
