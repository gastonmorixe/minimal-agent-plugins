import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { beforeAll, describe, expect, test } from "bun:test"

import { createCoreToolsSyntheticProvider } from "../../ma-core-tools-plugin/synthetic-text.ts"
import {
  formatBytes as fetchBytes,
  formatBinaryOptedIn,
  formatBinaryWithheld,
} from "../../ma-fetch-plugin/lib/binary.ts"
import { stripDataUris } from "../../ma-fetch-plugin/lib/data-uri.ts"
import { assetStub } from "../../ma-fetch-plugin/lib/html-cleanup.ts"
import { formatPeerMentionXml } from "../../ma-intercom-plugin/lib/mention/PROMPTS.ts"
import { compactOutputToMessages } from "../../ma-llm-openai-plugin/responses/compact.ts"
import { renderEcho } from "../../ma-memory-plugin/lib/save-echo.ts"
import { attachmentText } from "../../ma-reflection-checkpoint-plugin/lib/text.ts"
import { scrubDumpText } from "../../ma-session-history-plugin/lib/dump-from-data.ts"
import {
  renderTasksAgentBlock,
  renderTasksColumnar,
} from "../../ma-tasks-plugin/lib/model-render.ts"
import type { Task } from "../../ma-tasks-plugin/lib/parse.ts"
import { createTurnRecoveryProvider } from "../../ma-turn-recovery-plugin/provider.ts"
import { pluginSideband } from "../../tests/support/sideband.ts"

import createCodec from "./codec.ts"
import { TEST_KINDS as K, makeRegistry } from "./testing.ts"
import type { SidebandKind, SidebandMessage } from "./types.ts"

const codec = createCodec(makeRegistry())
const S = { type: "string" } as const
const SP = 'a&b "q" <t> >'
const E3 = "a&amp;b &quot;q&quot; &lt;t> >"

function k(kind: string, attrs: SidebandKind["attrs"], extra: Partial<SidebandKind> = {}) {
  return { ...K.policy!, kind, attrs, body: "none", ...extra } as SidebandKind
}

describe("parity: wire forms built by hand today", () => {
  test("drift literals 3 raw-output (raw path pinned)", () => {
    expect(
      codec.render(K.rawOutput!, {
        kind: "raw-output",
        attrs: { path: SP, size: "1B", sha256: "x" },
      }),
    ).toBe(`<ma::agent::raw-output path="${SP}" size="1B" sha256="x" />`)
  })
  test("drift 4 binary-result E3", () => {
    expect(
      codec.render(K.binaryResult!, {
        kind: "binary-result",
        attrs: { mime: SP, size: "3B", tool: SP },
      }),
    ).toBe(`<ma::agent::binary-result mime="${E3}" size="3B" tool="${E3}" />`)
  })
  test("wrap-up row keeps core bytes (sdk/wrap-up.ts:116)", () => {
    const kind = k("wrap-up", {}, { body: "text", placement: "turn" })
    expect(codec.render(kind, { kind: "wrap-up", body: "N" })).toBe(
      "<ma::agent::wrap-up>N</ma::agent::wrap-up>",
    )
  })
  test("budget row keeps golden bytes", () => {
    const kind = k(
      "budget",
      { elapsed: S, remaining: S, "turns-left": S, level: S },
      { body: "text" },
    )
    expect(
      codec.render(kind, {
        kind: "budget",
        attrs: { elapsed: 0, remaining: 1800, "turns-left": 2, level: "warn" },
        body: "B",
      }),
    ).toBe(
      '<ma::agent::budget elapsed="0" remaining="1800" turns-left="2" level="warn">B</ma::agent::budget>',
    )
  })
  test("name gives the v1 qname", () => {
    expect(codec.name?.(K.sysTool!)).toBe("ma::sys::tool")
    expect(codec.name?.(k("memory", {}))).toBe("ma::emit::memory")
  })
})

describe("parse spans and options", () => {
  test("open and close spans", () => {
    const t = "x<ma::agent::policy>b</ma::agent::policy>"
    const n = codec.parse(t)[0]!
    expect(t.slice(n.open!.start, n.open!.end)).toBe("<ma::agent::policy>")
    expect(t.slice(n.close!.start, n.close!.end)).toBe("</ma::agent::policy>")
  })
  test("nested and kinds", () => {
    const t = "<ma:x>a<ma:y />b</ma:x>"
    expect(codec.parse(t).length).toBe(1)
    expect(codec.parse(t, { nested: true }).map((n) => n.kind)).toEqual(["x", "y"])
    expect(codec.parse(t, { nested: true, kinds: ["y"] })[0]!.span.start).toBe(7)
  })
  test("legacyText reads bracket notices after 2 line feeds only", () => {
    expect(codec.parse("a [note: x]")).toEqual([])
    const n = codec.parse("a\n\n[note: x]", { legacyText: true })
    expect(n.map((x) => [x.kind, x.form])).toEqual([["output-streak", "v1-text"]])
  })
})

describe("trailingStart", () => {
  const five = [
    "\n\n[truncated:",
    "\n\n[note:",
    "\n\n<ma::agent::output-preview",
    "\n\n<ma::agent::diagnostics",
    "\n\n<ma::agent::mode-active",
  ]
  test("same cut as the core prefix list", () => {
    const t = 'body\n\n[truncated: x]\n\n<ma::agent::mode-active id="a" since="b" />'
    expect(codec.trailingStart?.(t)).toBe(4)
    expect(codec.trailingStart?.("plain")).toBe(5)
  })
  test("micro-benchmark: not slower than 2x of 5 lastIndexOf (risk 4)", () => {
    if (process.env.CI) return
    const big = "x".repeat(1024 * 1024)
    const time = (f: () => void) => {
      const t0 = performance.now()
      for (let i = 0; i < 20; i++) f()
      return performance.now() - t0
    }
    const base = time(() => {
      for (const p of five) big.lastIndexOf(p)
    })
    const ours = time(() => codec.trailingStart?.(big))
    expect(ours).toBeLessThanOrEqual(Math.max(2 * base, 5) * 1.5)
  })
})

// ---------------------------------------------------------------------------
// Per-kind rows (design 3.1, step 3). Each row: render(decl, msg) equals the
// bytes the emitter builds today. A plugin emitter is called (proof of
// equality). A core emitter is a literal with its file:line (core is not
// importable from here); the core drift test pins the same literal.
// ---------------------------------------------------------------------------

const E4 = "a&amp;b &quot;q&quot; &lt;t&gt; &gt;"

/**
 * The real declarations: the `sideband` key of each `ma-*` plugin manifest.
 * A row renders with the declaration that the registry gets (attr order,
 * attr type, layout), not a local copy.
 */
function manifestKinds(): Map<string, SidebandKind> {
  const root = resolve(import.meta.dir, "../..")
  const out = new Map<string, SidebandKind>()
  for (const dir of readdirSync(root).sort()) {
    const path = join(root, dir, "manifest.json")
    if (!dir.startsWith("ma-") || !existsSync(path)) continue
    const m = JSON.parse(readFileSync(path, "utf8")) as {
      id: string
      sideband?: Omit<SidebandKind, "owner">[]
    }
    for (const k of m.sideband ?? []) out.set(k.kind, { ...k, owner: m.id } as SidebandKind)
  }
  return out
}

const MK = manifestKinds()

/** The manifest declaration of a kind. A missing kind fails the test file. */
function m(kind: string): SidebandKind {
  const k = MK.get(kind)
  if (k === undefined) throw new Error(`no manifest declares sideband kind ${kind}`)
  return k
}

const D = {
  rawOutput: m("raw-output"),
  diagnostics: m("diagnostics"),
  policy: m("policy"),
  compaction: m("compaction"),
  binary: m("binary-result"),
  redacted: m("redacted-asset"),
  sanitizer: m("context-sanitizer"),
  outputPreview: m("output-preview"),
  modeActive: m("mode-active"),
  modeChange: m("mode-change"),
  turnAborted: m("turn-aborted"),
  sessionResumed: m("session-resumed"),
  streamInterrupted: m("stream-interrupted"),
  maxTokens: m("max-tokens-continue"),
  memorySaved: m("memory-saved"),
  shortTerm: m("short-term-memory"),
  tasks: m("tasks"),
  subagents: m("subagents"),
  inbox: m("intercom-inbox"),
  peer: m("intercom-peer"),
}

describe("parity declarations come from the manifests", () => {
  test("number attrs are declared int", () => {
    const ints = (k: SidebandKind) =>
      Object.entries(k.attrs)
        .filter(([, v]) => v.type === "int")
        .map(([n]) => n)
    expect(ints(D.memorySaved)).toEqual(["evicted"])
    expect(ints(D.tasks)).toEqual(["total", "done", "doing", "todo", "canceled"])
    expect(ints(D.subagents)).toEqual(["active", "done", "incomplete", "failed"])
    expect(ints(D.inbox)).toEqual(["count", "interrupt"])
  })
})

const r = (kind: SidebandKind, attrs?: SidebandMessage["attrs"], body?: string): string =>
  codec.render(kind, {
    kind: kind.kind,
    ...(attrs ? { attrs } : {}),
    ...(body !== undefined ? { body } : {}),
  })

/** The first line of a text (tag line of a template with prose below). */
const line1 = (s: string): string => s.split("\n")[0]!

describe("parity: core emitters (literals)", () => {
  // CORE src/session/blob-store.ts:512 formatRawOutputFooter (raw)
  test("raw-output", () => {
    expect(r(D.rawOutput, { path: "/w/t1.raw", size: "1.5kB", sha256: "ab12" })).toBe(
      '<ma::agent::raw-output path="/w/t1.raw" size="1.5kB" sha256="ab12" />',
    )
  })
  // CORE src/agent/tool-preview-budget.ts:108 renderDiagnosticsTag (raw, block)
  test("diagnostics", () => {
    expect(r(D.diagnostics, { count: 2, scope: "ad-hoc" }, "note one\nnote two")).toBe(
      '<ma::agent::diagnostics count="2" scope="ad-hoc">\nnote one\nnote two\n</ma::agent::diagnostics>',
    )
    expect(r(D.diagnostics, { count: 1 }, SP)).toBe(
      `<ma::agent::diagnostics count="1">\n${SP}\n</ma::agent::diagnostics>`,
    )
  })
  // CORE src/loops/tool-outcome-annotations.ts:327 POLICY_SPEC.render and
  // src/sdk/hook-context.ts:58 wrapHookContext (raw body)
  test("policy", () => {
    expect(r(D.policy, undefined, SP)).toBe(`<ma::agent::policy>${SP}</ma::agent::policy>`)
  })
  // CORE src/agent/context-compact.ts:133 checkpointText
  test("compaction tail and local", () => {
    expect(r(D.compaction, { kind: "tail" })).toBe('<ma::context::compaction kind="tail" />')
    expect(r(D.compaction, { kind: "local" })).toBe('<ma::context::compaction kind="local" />')
  })
  // CORE src/tools/binary-guard.ts:262 and :307 (E3, local escapeAttr :310)
  test("binary-result withheld and base64 body", () => {
    expect(r(D.binary, { mime: SP, size: "3B", path: SP, sha256: "ab", tool: SP })).toBe(
      `<ma::agent::binary-result mime="${E3}" size="3B" path="${E3}" sha256="ab" tool="${E3}" />`,
    )
    expect(r(D.binary, { mime: SP, size: "2B", encoding: "base64", path: SP }, "+/8=")).toBe(
      `<ma::agent::binary-result mime="${E3}" size="2B" encoding="base64" path="${E3}">\n+/8=\n</ma::agent::binary-result>`,
    )
  })
  // CORE src/tools/embedded-payload-scrub.ts:189 and :199 (E3, wire name chars_removed)
  test("redacted-asset and context-sanitizer", () => {
    expect(
      r(D.redacted, { kind: "data_uri", mime: SP, size: "1B", "chars-removed": 1, tool: "Fetch" }),
    ).toBe(
      `<ma::agent::redacted-asset kind="data_uri" mime="${E3}" size="1B" chars_removed="1" tool="Fetch" />`,
    )
    expect(
      r(D.sanitizer, { removed: 2, kinds: "data_uri", "chars-removed": 4096, saved: SP }),
    ).toBe(
      `<ma::agent::context-sanitizer removed="2" kinds="data_uri" chars_removed="4096" saved="${E3}" />`,
    )
  })
  // CORE src/plugins/loader/session-context.ts:114 (E4 escapeTagAttr, raw block body)
  test("sys roles", () => {
    for (const role of ["behavior", "context", "emit", "mode", "tool"]) {
      const kind = m(role)
      expect(r(kind, { name: SP }, SP)).toBe(
        `<ma::sys::${role} name="${E4}">\n${SP}\n</ma::sys::${role}>`,
      )
    }
  })
})

describe("parity: plugin emitters (called)", () => {
  const core = createCoreToolsSyntheticProvider()
  const rec = createTurnRecoveryProvider()
  // The providers render their tags with the session API (design 40 step 10).
  let sb: Awaited<ReturnType<typeof pluginSideband>>
  beforeAll(async () => {
    sb = await pluginSideband()
  })

  test("core-tools output-preview (raw attrs, raw path)", () => {
    const close = "</ma::agent::output-preview>"
    const rows: Record<string, string | number | boolean>[] = [
      { shown: 10, total: 99, tool: SP, bash: false, rawPath: SP },
      { shown: 1, total: 2, tool: "Bash", bash: true },
    ]
    for (const facts of rows) {
      const out = core.text("tool_output.preview", facts, sb)
      const body = out.slice(out.indexOf("the user saw"), -close.length)
      const { bash: _bash, rawPath, ...rest } = facts
      const attrs = rawPath === undefined ? rest : { ...rest, path: rawPath }
      expect(r(D.outputPreview, attrs, body)).toBe(out)
    }
  })
  test("core-tools mode-active and mode-change (raw)", () => {
    expect(r(D.modeActive, { id: SP, since: "s" })).toBe(
      core.text("mode.active_stamp", { id: SP, since: "s" }, sb),
    )
    expect(r(D.modeChange, { from: SP, to: "b", at: "t" })).toBe(
      core.text("mode.change", { from: SP, to: "b", at: "t" }, sb),
    )
  })
  test("turn-recovery tag lines", () => {
    expect(r(D.turnAborted)).toBe(line1(rec.text("runtime.turn_aborted", {}, sb)))
    expect(r(D.sessionResumed)).toBe(line1(rec.text("runtime.session_resumed", {}, sb)))
    expect(r(D.streamInterrupted)).toBe(line1(rec.text("runtime.stream_interrupted", {}, sb)))
    expect(r(D.streamInterrupted)).toBe(line1(rec.text("continue.stream_interrupted", {}, sb)))
    expect(r(D.maxTokens)).toBe(line1(rec.text("continue.max_tokens", {}, sb)))
  })
  test("fetch binary-result (3 forms, E3)", () => {
    const tag = (s: string) => s.split("\n\n")[0]!
    const w = { mime: SP, sizeBytes: 3, path: SP, sha256: SP }
    expect(
      r(D.binary, { mime: SP, size: fetchBytes(3), path: SP, sha256: SP, tool: "Fetch" }),
    ).toBe(tag(formatBinaryWithheld(w, sb)))
    const big = new Uint8Array(48 * 1024 + 1)
    expect(r(D.binary, { mime: SP, size: fetchBytes(big.length), path: SP, tool: "Fetch" })).toBe(
      tag(formatBinaryOptedIn({ bytes: big, mime: SP, path: SP }, sb)),
    )
    const small = new Uint8Array([0xfb, 0xff])
    expect(
      r(
        D.binary,
        { mime: SP, size: fetchBytes(2), encoding: "base64", path: SP, tool: "Fetch" },
        "+/8=",
      ),
    ).toBe(formatBinaryOptedIn({ bytes: small, mime: SP, path: SP }, sb))
  })
  test("fetch redacted-asset and context-sanitizer (data-uri, html-cleanup)", () => {
    const out = stripDataUris(`x data:Image/PNG;base64,${"A".repeat(400)} y`, sb)
    const [stub, footer] = out.match(/<ma::agent::[^>]*\/>/g)!
    expect(
      r(D.redacted, {
        kind: "data_uri",
        mime: "image/png",
        size: "300B",
        "chars-removed": 400,
        tool: "Fetch",
      }),
    ).toBe(stub!)
    expect(
      r(D.sanitizer, { removed: 1, kinds: "data_uri", "chars-removed": 400, tool: "Fetch" }),
    ).toBe(footer!)
    expect(r(D.redacted, { kind: "style_block", size: "1.5KB", tool: "Fetch" })).toBe(
      assetStub("style_block", 1536, sb),
    )
  })
  test("session-history redacted-asset and context-sanitizer (E3)", () => {
    const out = scrubDumpText(`x data:image/png;base64,${"A".repeat(400)} y`, sb)
    const [stub, footer] = out.match(/<ma::agent::[^>]*\/>/g)!
    expect(
      r(D.redacted, { kind: "data_uri", mime: "image/png", size: "300B", "chars-removed": 400 }),
    ).toBe(stub!)
    expect(
      r(D.sanitizer, { removed: 1, kinds: "data_uri", "chars-removed": 400, saved: "300B" }),
    ).toBe(footer!)
  })
  test('memory memory-saved (attr & and " only, body < and >)', () => {
    const body = 'a&b "q" <t> >'
    expect(r(D.memorySaved, { scope: "short-term", id: SP, evicted: 2 }, body)).toBe(
      renderEcho({ scope: "short-term", id: SP, body, evicted: 2 }, sb),
    )
    expect(r(D.memorySaved, { scope: "global", id: "m1" }, "x")).toBe(
      renderEcho({ scope: "global", id: "m1", body: "x" }, sb),
    )
  })
  // P/ma-memory-plugin/lib/short-term-snapshot.ts:71 (class reads a store: literal)
  test("memory short-term-memory (raw block body)", () => {
    expect(r(D.shortTerm, undefined, `[#1] ${SP}\n[#2] b`)).toBe(
      `<ma::agent::short-term-memory>\n[#1] ${SP}\n[#2] b\n</ma::agent::short-term-memory>`,
    )
  })
  test("tasks renderTasksAgentBlock (E4 after the caller cleanText)", () => {
    const task = {
      id: "1",
      parent: null,
      status: "doing",
      title: SP,
      reason: null,
      active_ms: 0,
    } as unknown as Task
    const stats = { total: 1, done: 0, doing: 1, todo: 0, canceled: 0 }
    const out = renderTasksAgentBlock([task], stats, { action: SP, result: "ok", id: "#1" }, sb)
    expect(
      r(D.tasks, { action: SP, result: "ok", id: "1", ...stats }, renderTasksColumnar([task])),
    ).toBe(out)
  })
  // P/ma-tasks-plugin/lib/attachment.ts:139 (class reads a store: literal)
  test("tasks attachment (int attrs, raw block body)", () => {
    const stats = { total: 2, done: 1, doing: 1, todo: 0, canceled: 0 }
    expect(r(D.tasks, stats, "1  done   a\n2  doing  b")).toBe(
      '<ma::agent::tasks total="2" done="1" doing="1" todo="0" canceled="0">\n1  done   a\n2  doing  b\n</ma::agent::tasks>',
    )
  })
  // P/ma-sub-agents-plugin/lib/attachment.ts:97-98 (class reads a store: literal)
  test("sub-agents subagents (raw attrs, block)", () => {
    const a = { active: 1, done: 2, incomplete: 1, failed: 0, tokens: "1.2k", output: "300" }
    expect(r(D.subagents, a, "row\n… +3 more (SubAgentsListAgents)")).toBe(
      '<ma::agent::subagents active="1" done="2" incomplete="1" failed="0" tokens="1.2k" output="300">\nrow\n… +3 more (SubAgentsListAgents)\n</ma::agent::subagents>',
    )
    const { incomplete: _, ...noInc } = a
    expect(r(D.subagents, noInc, "row")).toBe(
      '<ma::agent::subagents active="1" done="2" failed="0" tokens="1.2k" output="300">\nrow\n</ma::agent::subagents>',
    )
  })
  // P/ma-intercom-plugin/handlers/inbox_attachment.ts:59 (class reads an inbox: literal)
  test("intercom intercom-inbox (raw attrs, block)", () => {
    expect(r(D.inbox, { count: 2, interrupt: 1 }, SP)).toBe(
      `<ma::agent::intercom-inbox count="2" interrupt="1">\n${SP}\n</ma::agent::intercom-inbox>`,
    )
  })
  test("intercom intercom-peer (E4 attrs, escaped text body)", () => {
    expect(r(D.peer, { name: SP, sid: SP }, SP)).toBe(
      formatPeerMentionXml({ name: SP, sid: SP, body: SP }, sb),
    )
    expect(r(D.peer, { sid: "s1" }, "@s1")).toBe(
      formatPeerMentionXml({ sid: "s1", body: "@s1" }, sb),
    )
  })
  test("openai compaction remote and remote-empty (enc encoded by the caller)", () => {
    const [withEnc] = compactOutputToMessages([{ type: "compaction", encrypted_content: SP }], sb)
    expect(r(D.compaction, { kind: "remote", enc: encodeURIComponent(SP) })).toBe(
      line1(withEnc!.content),
    )
    const [noEnc] = compactOutputToMessages([{ type: "compaction" }], sb)
    expect(r(D.compaction, { kind: "remote" })).toBe(line1(noEnc!.content))
    const [empty] = compactOutputToMessages([], sb)
    expect(r(D.compaction, { kind: "remote-empty" })).toBe(line1(empty!.content))
  })
})

describe("v1 attribute wire names", () => {
  test("chars-removed is written as chars_removed and read back", () => {
    const text = r(D.redacted, { kind: "data_uri", size: "1B", "chars-removed": 7 })
    expect(text).toBe('<ma::agent::redacted-asset kind="data_uri" size="1B" chars_removed="7" />')
    const n = createCodec(makeRegistry([D.redacted])).parse(text)[0]!
    expect(n.attrs).toEqual({ kind: "data_uri", size: "1B", "chars-removed": "7" })
  })
  test("a declaration that names chars_removed keeps it", () => {
    const text = '<ma::agent::redacted-asset chars_removed="7" />'
    expect(codec.parse(text)[0]!.attrs).toEqual({ chars_removed: "7" })
  })
  test("memory-saved body round trip (legacyBodyEscaped)", () => {
    const text = r(D.memorySaved, { id: "m1" }, "<t> &")
    expect(text).toBe('<ma::agent::memory-saved id="m1">&lt;t&gt; &</ma::agent::memory-saved>')
    expect(createCodec(makeRegistry([D.memorySaved])).parse(text)[0]!.body).toBe("<t> &")
  })
})

describe("parity: int-only kinds need no escape row", () => {
  // The old turn-recovery template (plugins 223ebb0,
  // ma-turn-recovery-plugin/prompts/reflection-checkpoint.tmpl.md:1) wrote
  // the tag line by hand. The opt-in plugin renders it with the codec and the
  // manifest declaration, with no escape row.
  test("reflection-checkpoint: the plugin tag line equals the old template bytes", async () => {
    const sb = await pluginSideband()
    const line = attachmentText(50, 60_000, sb).split("\n")[0]
    expect(line).toBe(
      '<ma::agent::reflection-checkpoint round="50" cooldown-applied-seconds="60" />',
    )
  })
})
