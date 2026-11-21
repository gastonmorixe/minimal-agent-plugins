/**
 * Regression tests: the Cursor wire text must have the SAME bytes as the old
 * path in every case (M3b-1 review findings A1-A3, B1-B5). The reader may use
 * the stored `outcome` only where it gives the same bytes.
 */

import { describe, expect, test } from "bun:test"

import type { PersistedToolOutcome } from "@minimal-agent/core/plugin-api"
import type {
  CanonicalMessage,
  ToolResultBlock,
} from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import { defaultCapabilities } from "@minimal-agent/core/plugin-api/llm/capabilities"
import { stripUnsupportedModalities } from "@minimal-agent/core/plugin-api/llm/modality-check"

import { pluginSideband } from "../tests/support/sideband.ts"

import {
  outcomeWireText,
  stripMaAgentWireAnnotations,
  toolResultToWireText,
} from "./bidi-tool-results.ts"

// The real codec and kinds: the strip step reads the tags with the session API.
const sb = await pluginSideband()

// Tags are built from parts: a source literal of a harness tag is stripped by Cursor tooling.
const LT = String.fromCharCode(60)

/**
 * Frozen copy of the old strip step (plugins 276f390, before design step
 * 12b): the regex reader of the harness tags. The product code reads the
 * tags with the sideband API now; this copy is the byte oracle only. The
 * sources are built from `LT`, as the tags of this file are.
 */
function frozenOldStrip(text: string): string {
  const okLine = (attrs: string): string => {
    const get = (name: string): string | undefined =>
      new RegExp(`\\b${name}="([^"]*)"`, "i").exec(attrs)?.[1]
    const result = (get("result") ?? "ok").trim() || "ok"
    const parts: string[] = [`OK ${result}`]
    const action = get("action")
    if (action) parts.push(`action=${action}`)
    const id = get("id")
    if (id) parts.push(`id=#${id.replace(/^#/, "")}`)
    const parentAuto = get("parent_auto_done")
    if (parentAuto) parts.push(`parent_auto_done=#${parentAuto.replace(/^#/, "")}`)
    const coerced = get("coerced")
    if (coerced) parts.push(`coerced=${coerced}`)
    const reason = get("reason")
    if (reason) parts.push(`reason="${reason}"`)
    for (const key of ["total", "done", "doing", "todo", "canceled"] as const) {
      const v = get(key)
      if (v !== undefined) parts.push(`${key}=${v}`)
    }
    return parts.join(" ")
  }
  const A = `${LT}ma::agent::`
  const Z = `${LT}\\/ma::agent::`
  let out = text
  out = out.replace(
    new RegExp(`${A}tasks\\b([^>]*)>([\\s\\S]*?)${Z}tasks>`, "gi"),
    (_m, attrs: string, body: string) => {
      const head = okLine(attrs)
      const inner = body.replace(/^\n+|\n+$/g, "")
      return inner.length > 0 ? `${head}\n${inner}` : head
    },
  )
  out = out.replace(new RegExp(`${A}tasks\\b([^>]*)\\/>`, "gi"), (_m, attrs: string) =>
    okLine(attrs),
  )
  out = out.replace(new RegExp(`${A}([a-z0-9-]+)\\b[^>]*>[\\s\\S]*?${Z}\\1>`, "gi"), "")
  out = out.replace(new RegExp(`${A}[^>]+\\/>`, "g"), "")
  return out.replace(/\n{3,}/g, "\n\n").trim()
}

/** The old path: join the text blocks with `"\n"`, strip the tags. `strip` defaults to the product strip. */
function legacyToolResultToWireText(
  block: ToolResultBlock,
  strip: (text: string) => string = (t) => stripMaAgentWireAnnotations(t, sb),
): string {
  const parts: string[] = []
  for (const c of block.content) {
    if (c.type === "text" && c.text) parts.push(c.text)
  }
  const joined = parts.join("\n") || "(empty tool result)"
  return strip(joined) || "(empty tool result)"
}

const tag = (name: string, attrs: string, inner?: string): string =>
  inner === undefined
    ? `${LT}ma::agent::${name}${attrs} />`
    : `${LT}ma::agent::${name}${attrs}>${inner}${LT}/ma::agent::${name}>`

const mode = tag("mode-active", ' id="ask" since="2026-07-29T10:14:16.090Z"')
const raw = tag("raw-output", ' path="/tmp/x.raw" size="5.8kB" sha256="abc"')
const rawGt = tag("raw-output", ' path="/tmp/a>b/x.raw" size="5.8kB" sha256="abc"')
const preview = tag(
  "output-preview",
  ' shown="15" total="156" tool="Read" path="/tmp/x.raw"',
  "hint",
)
const diagCloser = tag("diagnostics", "", `note ${LT}/ma::agent::diagnostics> trailing text\nn2\n`)
const truncated = "[truncated: showing 100 of 900 lines]"
const streak = "[note: the same output came 3 times]"

interface Part {
  kind: string
  text: string
  /** The text between the previous part and this one. Default `"\n\n"`. */
  join?: string
}

/** Join the body and the parts, and compute the offsets, as the core record does. */
function build(body: string, parts: Part[]): { text: string; outcome: PersistedToolOutcome } {
  let text = body
  const annotations: PersistedToolOutcome["annotations"] = []
  for (const p of parts) {
    text += p.join ?? "\n\n"
    const start = text.length
    text += p.text
    annotations.push({ kind: p.kind, start, end: text.length })
  }
  return { text, outcome: { v: 1, bodyEnd: body.length, annotations } }
}

const block = (text: string, outcome: PersistedToolOutcome | undefined): ToolResultBlock => ({
  type: "tool_result",
  toolUseId: "call_1",
  content: [{ type: "text", text }],
  ...(outcome === undefined ? {} : { outcome }),
})

const blockOf = (body: string, parts: Part[]): ToolResultBlock => {
  const { text, outcome } = build(body, parts)
  return block(text, outcome)
}

const same = (b: ToolResultBlock): void => {
  expect(toolResultToWireText(b, sb)).toBe(legacyToolResultToWireText(b))
}

const image = {
  type: "image",
  source: { type: "base64", mediaType: "image/png", data: "AAAA" },
} as unknown as ToolResultBlock["content"][number]

/** Run a block through the real modality strip for a text-only model. */
const stripImages = (b: ToolResultBlock): ToolResultBlock => {
  const caps = defaultCapabilities()
  const noImage = { ...caps, modalities: { ...caps.modalities, image: false } }
  const messages: CanonicalMessage[] = [{ role: "user", content: [b] }]
  const out = stripUnsupportedModalities(messages, noImage, "text-only-model")
  return out[0]!.content[0] as ToolResultBlock
}

describe("outcome reader parity: ordinary core outputs use the new path", () => {
  const cases: Array<{ name: string; body: string; parts: Part[] }> = [
    {
      name: "four annotation kinds",
      body: "line 1\nline 2",
      parts: [
        { kind: "output-preview", text: preview },
        { kind: "output-truncated", text: truncated },
        { kind: "output-streak", text: streak },
        { kind: "mode-active", text: mode },
      ],
    },
    {
      name: "empty body + stamp",
      body: "",
      parts: [{ kind: "mode-active", text: mode, join: "" }],
    },
    {
      name: "truncated + blob",
      body: "head of output",
      parts: [
        { kind: "raw-output", text: raw },
        { kind: "output-truncated", text: truncated },
      ],
    },
    {
      name: "body with a note-like text",
      body: "first\n\n[note: this is body text]\nlast",
      parts: [{ kind: "mode-active", text: mode }],
    },
    {
      name: "truncated footer",
      body: "a\n",
      parts: [{ kind: "output-truncated", text: truncated }],
    },
    { name: "plain body, no annotation", body: "plain", parts: [] },
  ]
  for (const c of cases) {
    test(`new path taken, same bytes: ${c.name}`, () => {
      const b = blockOf(c.body, c.parts)
      expect(typeof outcomeWireText(b, sb)).toBe("string")
      same(b)
    })
  }
})

describe("outcome reader parity: other inputs use the old path (review M3B1)", () => {
  const check = (b: ToolResultBlock): void => {
    expect(outcomeWireText(b, sb)).toBeUndefined()
    same(b)
  }

  test("A1: empty first text block + real second text block", () => {
    const b: ToolResultBlock = {
      type: "tool_result",
      toolUseId: "c",
      content: [
        { type: "text", text: "" },
        { type: "text", text: "real" },
      ],
      outcome: { v: 1, bodyEnd: 0, annotations: [] },
    }
    check(b)
    expect(toolResultToWireText(b, sb)).toBe("real")
  })

  test("A2: empty text block + image after the text-only placeholder", () => {
    const b = stripImages({
      type: "tool_result",
      toolUseId: "c",
      content: [{ type: "text", text: "" }, image],
      outcome: { v: 1, bodyEnd: 0, annotations: [] },
    })
    expect(b.outcome).toBeDefined()
    check(b)
    expect(toolResultToWireText(b, sb)).toContain("image attachment not sent")
  })

  test("A2: the placeholder blocks that keep the outcome have the same bytes", () => {
    same(
      stripImages({
        type: "tool_result",
        toolUseId: "c",
        content: [image],
        outcome: { v: 1, bodyEnd: 0, annotations: [] },
      }),
    )
    same(
      stripImages({
        type: "tool_result",
        toolUseId: "c",
        content: [
          ...blockOf("cap", [{ kind: "output-truncated", text: truncated }]).content,
          image,
        ],
        outcome: build("cap", [{ kind: "output-truncated", text: truncated }]).outcome,
      }),
    )
  })

  test("A3: content edited longer after the record", () => {
    const { text, outcome } = build("hello", [{ kind: "output-truncated", text: truncated }])
    check(block(text.replace("hello", "hello there, this was edited and is longer"), outcome))
  })

  test("A3: content prefixed (offsets shift)", () => {
    const { text, outcome } = build("hello world body", [
      { kind: "output-truncated", text: truncated },
    ])
    check(block(`>>> ${text}`, outcome))
  })

  test("A3: tail appended after the last span", () => {
    const { text, outcome } = build("hello", [{ kind: "output-truncated", text: truncated }])
    check(block(`${text}\n\n[extra line from an edit]`, outcome))
  })

  test("B1: plugin annotation with join newline", () => {
    check(blockOf("body", [{ kind: "ma-note", text: "[ma-note: checked]", join: "\n" }]))
  })

  test("B1: plugin annotation with an empty join", () => {
    check(blockOf("body", [{ kind: "ma-note", text: "[ma-note: checked]", join: "" }]))
  })

  test("B1: core plain-text annotation with join newline or empty join", () => {
    check(blockOf("body", [{ kind: "output-streak", text: streak, join: "\n" }]))
    check(blockOf("body", [{ kind: "output-streak", text: streak, join: "" }]))
    check(
      blockOf("body", [
        { kind: "mode-active", text: mode, join: "" },
        { kind: "output-truncated", text: truncated, join: "\n" },
      ]),
    )
  })

  test("B2: plugin annotation = a tag followed by plain words", () => {
    check(blockOf("body", [{ kind: "ma-note", text: `${tag("x", "")} and words after` }]))
  })

  test("B3: the body has an unbalanced harness opener", () => {
    check(
      blockOf(`prose mentions ${LT}ma::agent::policy> as text\nand more real text`, [
        { kind: "mode-active", text: mode },
      ]),
    )
  })

  test("B3: the body has a half tag cut by a clamp", () => {
    check(
      blockOf(`head of file ${LT}ma::agent::foo bar`, [
        { kind: "output-truncated", text: truncated },
      ]),
    )
  })

  test("B4: raw-output tag with a closing bracket inside an attribute", () => {
    check(blockOf("line 1\nline 2", [{ kind: "raw-output", text: rawGt }]))
    check(blockOf("", [{ kind: "raw-output", text: rawGt }]))
  })

  test("B4: diagnostics tag with a closer inside a note", () => {
    check(blockOf("line 1\nline 2", [{ kind: "diagnostics", text: diagCloser }]))
  })

  test("B5: a forged core-kind span with a wrong text shape uses the old path", () => {
    check(blockOf("body", [{ kind: "output-truncated", text: "forged text without the prefix" }]))
    check(blockOf("body", [{ kind: "output-streak", text: "[truncated: fake]" }]))
  })

  test("B5: a forged span with the right text shape gives the same bytes (any path)", () => {
    // The stored record has no owner field, so this span looks like a real core span.
    // The new path then keeps the text, as the old path does.
    same(
      blockOf("body", [
        { kind: "output-truncated", text: "[truncated: fake]" },
        { kind: "output-streak", text: streak },
      ]),
    )
  })
})

describe("outcome reader parity: seeded mini-fuzz", () => {
  let seed = 20260718
  const rnd = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 2 ** 32
  }
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!

  const bodies = [
    "plain",
    "",
    "a\n",
    "a\n\n\n\nb",
    "line 1\nline 2",
    "x\n\n[truncated: fake]\n\ny",
    "emoji \u{1F600} end",
    "lone \uD83D",
    `see ${tag("mode-active", ' id="x"')} end`,
    `doc: ${tag("policy", "", "x")} rest`,
    `prose ${LT}ma::agent::policy> as text\nreal tail`,
    `head ${LT}ma::agent::foo bar`,
    tag(
      "tasks",
      ' action="add" result="added" total="1" done="0" doing="0" todo="1" canceled="0"',
      "\n#a1 todo P1\n",
    ),
    "   ",
  ]
  const parts: Part[] = [
    { kind: "output-truncated", text: truncated },
    { kind: "output-streak", text: streak },
    { kind: "mode-active", text: mode },
    { kind: "raw-output", text: raw },
    { kind: "raw-output", text: rawGt },
    { kind: "output-preview", text: preview },
    { kind: "diagnostics", text: diagCloser },
    { kind: "diagnostics", text: tag("diagnostics", "", "note\nn2\n") },
    { kind: "policy", text: tag("policy", "", "Current local time: 2026-11-18") },
    { kind: "ma-note", text: "[ma-note: p]" },
    { kind: "ma-note", text: `${tag("x", "")}  and words after` },
    { kind: "output-truncated", text: "[truncated: fake]" },
    { kind: "output-truncated", text: "forged" },
  ]
  const joins = ["\n\n", "\n\n", "\n\n", "\n", ""]

  test("300 random hand-built blocks: new bytes === old bytes", () => {
    let newPath = 0
    for (let i = 0; i < 300; i++) {
      const n = Math.floor(rnd() * 5)
      const chosen: Part[] = []
      for (let j = 0; j < n; j++) chosen.push({ ...pick(parts), join: pick(joins) })
      const b = blockOf(pick(bodies), chosen)
      if (outcomeWireText(b, sb) !== undefined) newPath++
      same(b)
    }
    // The new path must still run for a good share of the cases.
    expect(newPath).toBeGreaterThan(30)
  })
})

// ---------------------------------------------------------------------------
// Round 2 (M3B1 fix 2): rows of the second review, built by hand.
// ---------------------------------------------------------------------------

/** Opener and closer text, built from parts (see the note at the top of the file). */
const opener = (name: string, caseForm: "lower" | "upper" | "mixed" = "lower"): string =>
  `${LT}${caseForm === "lower" ? "ma" : caseForm === "upper" ? "MA" : "Ma"}::${caseForm === "lower" ? "agent" : caseForm === "upper" ? "AGENT" : "Agent"}::${name}`
const closer = (name: string): string => `${LT}/ma::agent::${name}>`

const modeAsk = tag("mode-active", ' id="ask" since="2026-11-18T15:00:00.000Z"')
const policyOf = (inner: string): string => tag("policy", "", inner)

describe("outcome reader parity: second review rows (hand-built blocks)", () => {
  const emojiHand = (
    text: string,
    bodyEnd: number,
    spans: PersistedToolOutcome["annotations"],
  ): ToolResultBlock => block(text, { v: 1, bodyEnd, annotations: spans })

  interface Row {
    id: string
    what: string
    block: ToolResultBlock
    /** `true`: the old path must run. `undefined`: only the equality is checked. */
    oldPath?: true
  }
  const rows: Row[] = [
    {
      id: "S1",
      what: 'body ends with "\\n\\n" + plain annotation',
      block: blockOf("x\n\n", [{ kind: "output-truncated", text: truncated }]),
    },
    {
      id: "S1b",
      what: "body ends with four newlines + tag + plain",
      block: blockOf("x\n\n\n\n", [
        { kind: "mode-active", text: modeAsk },
        { kind: "output-truncated", text: truncated },
      ]),
    },
    {
      id: "S2",
      what: "plain annotation text ends with CRLF, then a second plain annotation",
      block: blockOf("x", [
        { kind: "output-truncated", text: `${truncated}\r\n` },
        { kind: "output-streak", text: streak },
      ]),
    },
    {
      id: "S2b",
      what: "plain annotation text has CRLF inside",
      block: blockOf("x", [{ kind: "output-truncated", text: "[truncated: a\r\nb]" }]),
    },
    {
      id: "S3a",
      what: "emoji body, bodyEnd after the whole pair",
      block: blockOf("a\u{1F600}", [{ kind: "output-truncated", text: truncated }]),
    },
    {
      id: "S3b",
      what: "bodyEnd splits the surrogate pair",
      block: emojiHand("a\u{1F600}\n\n[note: z]", 2, [
        { kind: "output-streak", start: 5, end: 17 },
      ]),
      oldPath: true,
    },
    {
      id: "S3c",
      what: "span start inside the pair",
      block: emojiHand("a\u{1F600}\n\n[note: z]", 1, [
        { kind: "output-streak", start: 2, end: 17 },
      ]),
      oldPath: true,
    },
    {
      id: "S3d",
      what: "annotation text ends with a lone high surrogate, text continues",
      block: emojiHand("b\n\n[note: \uD83D\uDE00 done", 1, [
        { kind: "output-streak", start: 3, end: 12 },
        { kind: "output-streak", start: 12, end: 18 },
      ]),
      oldPath: true,
    },
    {
      id: "F1",
      what: "uppercase opener in the body + policy annotation",
      block: blockOf(`prose ${opener("policy", "upper")}> mentioned\nreal tail`, [
        { kind: "policy", text: policyOf("Current local time: 10:30"), join: "\n" },
      ]),
      oldPath: true,
    },
    {
      id: "F2",
      what: "uppercase opener in the body + mode-active",
      block: blockOf(`prose ${opener("mode-active", "upper")}> x\nreal tail`, [
        { kind: "mode-active", text: modeAsk },
      ]),
      oldPath: true,
    },
    {
      id: "F3",
      what: "mixed-case opener in the body + truncated + policy",
      block: blockOf(`see ${opener("policy", "mixed")}> here\nmore`, [
        { kind: "output-truncated", text: truncated },
        { kind: "policy", text: policyOf("Current local time: 10:30"), join: "\n" },
      ]),
      oldPath: true,
    },
    {
      id: "G1",
      what: "tag annotation, then a plain annotation with a closer",
      block: blockOf("x", [
        { kind: "mode-active", text: modeAsk },
        { kind: "output-truncated", text: `[truncated: cut ${closer("mode-active")}` },
      ]),
      oldPath: true,
    },
    {
      id: "G2",
      what: "tag annotation, then a streak note with a closer",
      block: blockOf("x", [
        { kind: "mode-active", text: modeAsk },
        { kind: "output-streak", text: `[note: seen ${closer("mode-active")} twice]` },
      ]),
      oldPath: true,
    },
    {
      id: "H1",
      what: "tag annotation with a trailing space, then plain",
      block: blockOf("x", [
        { kind: "mode-active", text: `${modeAsk} ` },
        { kind: "output-truncated", text: truncated },
      ]),
      oldPath: true,
    },
    {
      id: "H2",
      what: "tag annotation with a trailing CRLF, then plain",
      block: blockOf("x", [
        { kind: "mode-active", text: `${modeAsk}\r\n` },
        { kind: "output-truncated", text: truncated },
      ]),
      oldPath: true,
    },
    {
      id: "H3",
      what: "tag annotation with a leading TAB, then plain",
      block: blockOf("x", [
        { kind: "mode-active", text: `\t${modeAsk}` },
        { kind: "output-truncated", text: truncated },
      ]),
      oldPath: true,
    },
    {
      id: "H4",
      what: "tag annotation with a trailing newline, then plain",
      block: blockOf("x", [
        { kind: "mode-active", text: `${modeAsk}\n` },
        { kind: "output-truncated", text: truncated },
      ]),
      oldPath: true,
    },
    {
      id: "H5",
      what: "policy annotation (join newline) with a trailing space, then plain",
      block: blockOf("x", [
        { kind: "policy", text: `${policyOf("n")} `, join: "\n" },
        { kind: "output-streak", text: streak },
      ]),
      oldPath: true,
    },
    {
      id: "I1",
      what: "plain annotation text with four inner newlines",
      block: blockOf("x", [{ kind: "output-truncated", text: "[truncated: a\n\n\n\nb]" }]),
    },
    {
      id: "I2",
      what: "two tag annotations (join newline) between body and plain",
      block: blockOf("x", [
        { kind: "policy", text: policyOf("a"), join: "\n" },
        { kind: "policy", text: policyOf("b"), join: "\n" },
        { kind: "output-streak", text: streak },
      ]),
    },
    {
      id: "I3",
      what: "empty body, plain only",
      block: blockOf("", [{ kind: "output-truncated", text: truncated }]),
    },
    {
      id: "I4",
      what: "white space body, mode stamp without join, then plain",
      block: blockOf("  \n", [
        { kind: "mode-active", text: modeAsk, join: "" },
        { kind: "output-truncated", text: truncated },
      ]),
    },
    {
      id: "I5",
      what: "body is a CR only",
      block: blockOf("\r", [{ kind: "output-truncated", text: truncated }]),
    },
    {
      id: "I6",
      what: "NBSP and U+2028 at the body edges",
      block: blockOf("\u00a0x\u2028", [{ kind: "output-truncated", text: truncated }]),
    },
    {
      id: "I7",
      what: "body with a lowercase closer only + tag annotation + plain",
      block: blockOf(`x ${closer("policy")} y`, [
        { kind: "policy", text: policyOf("n"), join: "\n" },
        { kind: "output-truncated", text: truncated },
      ]),
      oldPath: true,
    },
    {
      id: "J1",
      what: "streak note with an uppercase opener + a later policy annotation",
      block: blockOf("x", [
        { kind: "output-streak", text: `[note: ${opener("policy", "upper")}> seen]` },
        { kind: "policy", text: policyOf("n"), join: "\n" },
      ]),
      oldPath: true,
    },
  ]

  for (const r of rows) {
    test(`${r.id}: same bytes as the old path (${r.what})`, () => {
      same(r.block)
      if (r.oldPath) expect(outcomeWireText(r.block, sb)).toBeUndefined()
    })
  }

  test("a tag annotation with no leftover keeps the new path", () => {
    const b = blockOf("x", [
      { kind: "mode-active", text: modeAsk },
      { kind: "output-truncated", text: truncated },
    ])
    expect(outcomeWireText(b, sb)).toBeDefined()
    same(b)
  })

  test("an upper-case self-closing tag annotation is not removed by the strip step: old path", () => {
    const upper = `${opener("mode-active", "upper")} id="ask" />`
    const b = blockOf("x", [{ kind: "mode-active", text: upper }])
    expect(outcomeWireText(b, sb)).toBeUndefined()
    same(b)
  })
})

describe("outcome reader parity: grammar fuzz-lite (harness-shaped fragments)", () => {
  test("300 seeded cases: new bytes === old bytes, new path taken in at least 20", () => {
    const NAMES = [
      "mode-active",
      "policy",
      "raw-output",
      "output-preview",
      "diagnostics",
      "tasks",
      "x",
    ]
    const WS = ["", "", "", " ", "  ", "\t", "\n", "\r\n", "\r", "\u00a0", "\u2028", "\n\n"]
    const BITS = [
      "a",
      "b c",
      "line",
      truncated,
      "[note: seen twice]",
      ">",
      "/",
      "/>",
      '"',
      ' id="1"',
      "\u{1F600}",
      "\uD83D",
      "ma::agent::",
      LT,
      `${LT}/`,
    ]
    let newPath = 0
    let cases = 0
    const started = performance.now()
    for (let seed = 1; seed <= 300; seed++) {
      let s = (seed * 2654435761) >>> 0
      const rnd = (): number => {
        s = (s * 1664525 + 1013904223) >>> 0
        return s / 2 ** 32
      }
      const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)] as T
      const OPEN = (n: string): string =>
        pick([
          `${LT}ma::agent::${n}`,
          `${LT}MA::AGENT::${n}`,
          `${LT}Ma::Agent::${n}`,
          `${LT}ma::agent::${n.toUpperCase()}`,
        ])
      const CLOSE = (n: string): string =>
        pick([`${LT}/ma::agent::${n}>`, `${LT}/MA::AGENT::${n}>`, `${LT}/ma::agent::${n}  >`])
      const tagText = (): string => {
        const n = pick(NAMES)
        const k = rnd()
        if (k < 0.35) {
          return `${OPEN(n)}${pick(WS)}${pick(["", ' id="1"', ' a="x>y"', ' a="1" b="2"'])}${pick(["/>", " />", "/ >", ">"])}`
        }
        if (k < 0.7) {
          return `${OPEN(n)}${pick(["", ' id="1"'])}>${pick(["", "x", "a\nb", LT, pick(BITS)])}${CLOSE(pick(NAMES))}`
        }
        return pick([OPEN(n), CLOSE(n), `${OPEN(n)} unterminated`, `${LT}ma::agent::`])
      }
      const anyText = (): string => {
        const parts: string[] = []
        const n = 1 + Math.floor(rnd() * 3)
        for (let i = 0; i < n; i++) parts.push(rnd() < 0.5 ? tagText() : pick(BITS), pick(WS))
        return parts.join("")
      }
      const JOIN = ["\n\n", "\n", ""]
      const annotation = (): Part => {
        const r = rnd()
        if (r < 0.35) {
          const kind = pick(["output-truncated", "output-streak"])
          const prefix = kind === "output-truncated" ? "[truncated:" : "[note:"
          return {
            kind,
            text: rnd() < 0.6 ? `${prefix} ${anyText()}]` : anyText(),
            join: rnd() < 0.85 ? "\n\n" : pick(JOIN),
          }
        }
        if (r < 0.9) {
          return {
            kind: pick(["mode-active", "policy", "raw-output", "output-preview", "diagnostics"]),
            text: rnd() < 0.6 ? tagText() : anyText(),
            join: pick(rnd() < 0.7 ? ["\n\n"] : JOIN),
          }
        }
        return { kind: "ma-note", text: anyText(), join: pick(JOIN) }
      }
      const body = (): string => {
        const r = rnd()
        if (r < 0.25) return ""
        if (r < 0.55) {
          return pick([
            "x",
            "line 1\nline 2",
            "a\n",
            "a\n\n",
            "  \n",
            "\u00a0x\u2028",
            "cut \u{1F600}",
          ])
        }
        return `${pick(BITS)}${pick(WS)}${anyText()}${pick(WS)}`
      }
      const b = body()
      const anns = Array.from({ length: Math.floor(rnd() * 4) }, annotation)
      const blk = blockOf(b, anns)
      cases++
      if (outcomeWireText(blk, sb) !== undefined) newPath++
      same(blk)
    }
    expect(cases).toBe(300)
    expect(newPath).toBeGreaterThanOrEqual(20)
    expect(performance.now() - started).toBeLessThan(2000)
  })
})

describe("outcome reader parity: large bodies finish in seconds", () => {
  test("5 MB body + one output-truncated annotation: same bytes, under 5 s", () => {
    const body = "line\n".repeat(1_000_000)
    expect(body.length).toBe(5_000_000)
    const b = blockOf(body, [{ kind: "output-truncated", text: truncated }])
    expect(outcomeWireText(b, sb)).toBeDefined()
    const started = performance.now()
    const got = toolResultToWireText(b, sb)
    const elapsed = performance.now() - started
    expect(got).toBe(legacyToolResultToWireText(b))
    expect(elapsed).toBeLessThan(5000)
  })

  test("1 MB body that ends with an unterminated opener: old path, same bytes, under 5 s", () => {
    const body = `${"line\n".repeat(200_000)}tail ${opener("policy")} unterminated`
    expect(body.length).toBeGreaterThan(1_000_000)
    const b = blockOf(body, [{ kind: "output-truncated", text: truncated }])
    expect(outcomeWireText(b, sb)).toBeUndefined()
    const started = performance.now()
    const got = toolResultToWireText(b, sb)
    const elapsed = performance.now() - started
    expect(got).toBe(legacyToolResultToWireText(b))
    expect(elapsed).toBeLessThan(5000)
  })
})

describe("wire bytes: the codec strip equals the frozen regex strip for harness-written tags", () => {
  const frozen = (b: ToolResultBlock): string => legacyToolResultToWireText(b, frozenOldStrip)
  const tasksPaired = tag(
    "tasks",
    ' action="add_many" result="added_many" total="2" done="0" doing="0" todo="2" canceled="0"',
    "\n#ce6b5b  todo      Phase 1\n  #ce6b5ba  todo      Native logging\n",
  )
  const tasksSelf = tag(
    "tasks",
    ' action="start" result="started" id="ce6b5ba" parent_auto_done="ce6b5b" total="7" done="1" doing="2" todo="4" canceled="0"',
  )
  const policy = tag("policy", "", "Current local time: 2026-11-18")
  const diag = tag("diagnostics", "", "\nnote\nn2\n")
  const rows: Array<{ name: string; body: string; parts: Part[] }> = [
    {
      name: "four annotation kinds",
      body: "line 1\nline 2",
      parts: [
        { kind: "output-preview", text: preview },
        { kind: "output-truncated", text: truncated },
        { kind: "output-streak", text: streak },
        { kind: "mode-active", text: mode },
      ],
    },
    {
      name: "empty body + stamp",
      body: "",
      parts: [{ kind: "mode-active", text: mode, join: "" }],
    },
    {
      name: "blob + truncated",
      body: "head",
      parts: [
        { kind: "raw-output", text: raw },
        { kind: "output-truncated", text: truncated },
      ],
    },
    {
      name: "policy and diagnostics",
      body: "x",
      parts: [
        { kind: "policy", text: policy, join: "\n" },
        { kind: "diagnostics", text: diag },
      ],
    },
    {
      name: "tasks board in the body",
      body: tasksPaired,
      parts: [{ kind: "mode-active", text: mode }],
    },
    { name: "tasks ack in the body", body: tasksSelf, parts: [] },
    { name: "plain body", body: "plain", parts: [] },
  ]
  for (const r of rows) {
    test(r.name, () => {
      const b = blockOf(r.body, r.parts)
      expect(toolResultToWireText(b, sb)).toBe(frozen(b))
      const { outcome: _, ...noOutcome } = b
      expect(toolResultToWireText(noOutcome, sb)).toBe(frozen(b))
    })
  }

  test("each tag that the API renders for a tool-result kind goes, as before", () => {
    const tags = [
      sb.render("mode-active", { attrs: { id: "ask", since: "2026-11-18T15:00:00.000Z" } }),
      sb.render("raw-output", { attrs: { path: "/tmp/x.raw", size: "5.8kB", sha256: "abc" } }),
      sb.render("output-preview", { attrs: { shown: 15, total: 156, tool: "Read" }, body: "hint" }),
      sb.render("policy", { body: "Current local time: 10:30" }),
    ]
    for (const t of tags) {
      const b = block(`body\n\n${t}`, undefined)
      expect(toolResultToWireText(b, sb)).toBe("body")
      expect(frozen(b)).toBe("body")
    }
  })
})
