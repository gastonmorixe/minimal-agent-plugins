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

import {
  outcomeWireText,
  stripMaAgentWireAnnotations,
  toolResultToWireText,
} from "./bidi-tool-results.ts"

/** Frozen copy of the old path: join the text blocks with `"\n"`, strip the tags. */
function legacyToolResultToWireText(block: ToolResultBlock): string {
  const parts: string[] = []
  for (const c of block.content) {
    if (c.type === "text" && c.text) parts.push(c.text)
  }
  const joined = parts.join("\n") || "(empty tool result)"
  return stripMaAgentWireAnnotations(joined) || "(empty tool result)"
}

// Tags are built from parts: a source literal of a harness tag is stripped by Cursor tooling.
const LT = String.fromCharCode(60)
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
  expect(toolResultToWireText(b)).toBe(legacyToolResultToWireText(b))
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
      expect(typeof outcomeWireText(b)).toBe("string")
      same(b)
    })
  }
})

describe("outcome reader parity: other inputs use the old path (review M3B1)", () => {
  const check = (b: ToolResultBlock): void => {
    expect(outcomeWireText(b)).toBeUndefined()
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
    expect(toolResultToWireText(b)).toBe("real")
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
    expect(toolResultToWireText(b)).toContain("image attachment not sent")
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
      if (outcomeWireText(b) !== undefined) newPath++
      same(b)
    }
    // The new path must still run for a good share of the cases.
    expect(newPath).toBeGreaterThan(30)
  })
})
