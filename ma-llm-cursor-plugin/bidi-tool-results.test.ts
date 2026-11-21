/**
 * Unit tests for bidi tool-result extraction.
 */

import { describe, expect, test } from "bun:test"

import type { PersistedToolOutcome } from "@minimal-agent/core/plugin-api"
import type { ToolResultBlock } from "@minimal-agent/core/plugin-api/llm/canonical-messages"

import { pluginSideband } from "../tests/support/sideband.ts"

import {
  extractTrailingFollowUpUserText,
  extractTrailingToolResults,
  outcomeWireText,
  requestHasToolResultContinuation,
  stripMaAgentWireAnnotations,
  toolResultToWireText,
} from "./bidi-tool-results.ts"

// The real codec and kinds: the strip step reads the tags with the session API.
const sb = await pluginSideband()

describe("bidi tool results", () => {
  test("extracts trailing tool_result blocks", () => {
    const results = extractTrailingToolResults([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "ModelInfo", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "call_1",
            content: [{ type: "text", text: "model=cursor-auto" }],
          },
        ],
      },
    ])
    expect(results).toHaveLength(1)
    expect(results[0]!.toolUseId).toBe("call_1")
    expect(toolResultToWireText(results[0]!, sb)).toBe("model=cursor-auto")
  })

  test("stripMaAgentWireAnnotations removes harness tags from wire text", () => {
    expect(
      stripMaAgentWireAnnotations(
        '546 README.md\n\n<ma::agent::mode-active id="ask" since="2026-07-29T10:14:16.090Z" />',
        sb,
      ),
    ).toBe("546 README.md")
    expect(
      stripMaAgentWireAnnotations(
        'line 1\n\n<ma::agent::raw-output path="/tmp/x.raw" size="5.8kB" sha256="abc" />\n\n<ma::agent::output-preview shown="15" total="156" tool="Read" path="/tmp/x.raw">hint</ma::agent::output-preview>',
        sb,
      ),
    ).toBe("line 1")
  })

  test("toolResultToWireText strips MA annotations before Cursor encoding", () => {
    const text = toolResultToWireText(
      {
        type: "tool_result",
        toolUseId: "call_1",
        content: [
          {
            type: "text",
            text: '546 README.md\n\n<ma::agent::mode-active id="ask" since="2026-07-29T10:14:16.090Z" />',
          },
        ],
      },
      sb,
    )
    expect(text).toBe("546 README.md")
    expect(text).not.toContain("<ma::agent::")
  })

  test("requestHasToolResultContinuation is false for fresh user text only", () => {
    expect(
      requestHasToolResultContinuation({
        modelId: "cursor-auto",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      }),
    ).toBe(false)
  })
})

describe("BUG-293802 trailing follow-up user text on bidi continuation", () => {
  const toolResultUser = {
    role: "user" as const,
    content: [
      {
        type: "tool_result" as const,
        toolUseId: "call_1",
        content: [{ type: "text" as const, text: "search hits" }],
      },
    ],
  }

  test("returns null when continuation is tool_results only", () => {
    expect(extractTrailingFollowUpUserText([toolResultUser])).toBeNull()
  })

  test("returns queued text appended after tool_results (core inputQueue port)", () => {
    expect(
      extractTrailingFollowUpUserText([
        {
          role: "user",
          content: [
            ...toolResultUser.content,
            { type: "text", text: "what is the square root of 9?" },
          ],
        },
      ]),
    ).toBe("what is the square root of 9?")
  })

  test("ignores a fresh user turn that is not a tool continuation", () => {
    expect(
      extractTrailingFollowUpUserText([
        { role: "user", content: [{ type: "text", text: "what is the square root of 9?" }] },
      ]),
    ).toBeNull()
  })
})

describe("MA-39298 tasks payloads survive Cursor strip", () => {
  // Build tags without embedding literal "<ma::agent::..." in source - that
  // pattern is stripped by Cursor wire tooling mid-edit (MA-39298 itself).
  const LT = String.fromCharCode(60)
  const GT = String.fromCharCode(62)
  const tasksTag = "ma::agent::tasks"
  const openTasks = (attrs: string, body: string): string =>
    LT + tasksTag + attrs + GT + body + LT + "/" + tasksTag + GT
  const selfTasks = (attrs: string): string => LT + tasksTag + attrs + " />"
  const agentPrefix = LT + "ma::agent::"

  test("unwraps paired tasks board into OK header + rows", () => {
    const raw = openTasks(
      ' action="add_many" result="added_many" total="2" done="0" doing="0" todo="2" canceled="0"',
      "\n#ce6b5b  todo      Phase 1\n  #ce6b5ba  todo      Native logging\n",
    )
    const out = stripMaAgentWireAnnotations(raw, sb)
    expect(out).toContain("OK added_many")
    expect(out).toContain("action=add_many")
    expect(out).toContain("#ce6b5b  todo      Phase 1")
    expect(out).toContain("#ce6b5ba  todo      Native logging")
    expect(out).not.toContain(tasksTag)
    expect(out).not.toBe("(empty tool result)")
  })

  test("converts self-closing tasks ack to plain OK line", () => {
    const raw = selfTasks(
      ' action="start" result="started" id="ce6b5ba" total="7" done="1" doing="2" todo="4" canceled="0"',
    )
    const out = toolResultToWireText(
      {
        type: "tool_result",
        toolUseId: "call_1",
        content: [{ type: "text", text: raw }],
      },
      sb,
    )
    expect(out).toContain("OK started")
    expect(out).toContain("id=#ce6b5ba")
    expect(out).toContain("doing=2")
    expect(out.includes(agentPrefix)).toBe(false)
    expect(out).not.toBe("(empty tool result)")
  })

  test("plain OK Task content passes through unchanged", () => {
    const plain = "OK started action=start id=#ce6b5ba total=7 done=1 doing=2 todo=4 canceled=0"
    expect(stripMaAgentWireAnnotations(plain, sb)).toBe(plain)
    expect(
      toolResultToWireText(
        {
          type: "tool_result",
          toolUseId: "call_1",
          content: [{ type: "text", text: plain }],
        },
        sb,
      ),
    ).toBe(plain)
  })

  test("still strips mode-active and other harness chrome", () => {
    const mode = agentPrefix + 'mode-active id="ask" />'
    const rawOut = agentPrefix + 'raw-output path="/tmp/x" />'
    const raw = "hello\n" + mode + "\n" + rawOut
    const out = stripMaAgentWireAnnotations(raw, sb)
    expect(out).toBe("hello")
    expect(out).not.toContain("mode-active")
    expect(out).not.toContain("raw-output")
  })
})

describe("toolResultToWireText outcome parity (M3b-1)", () => {
  const LT = String.fromCharCode(60)
  const tag = (name: string, attrs: string, inner?: string): string =>
    inner === undefined
      ? `${LT}ma::agent::${name}${attrs} />`
      : `${LT}ma::agent::${name}${attrs}>${inner}${LT}/ma::agent::${name}>`

  const mode = tag("mode-active", ' id="ask" since="2026-07-29T10:14:16.090Z"')
  const raw = tag("raw-output", ' path="/tmp/x.raw" size="5.8kB" sha256="abc"')
  const preview = tag(
    "output-preview",
    ' shown="15" total="156" tool="Read" path="/tmp/x.raw"',
    "hint",
  )
  const truncated = "[truncated: showing 100 of 900 lines]"
  const streak = "[note: the same output came 3 times]"

  interface Part {
    kind: string
    text: string
    join?: string
  }

  /** Build the stored text and the record outcome by the D6 join (`"\n\n"` default). */
  const build = (body: string, parts: Part[]): { text: string; outcome: PersistedToolOutcome } => {
    let text = body
    const annotations: PersistedToolOutcome["annotations"] = []
    for (const p of parts) {
      text += text.length === 0 && p.join === "" ? "" : "\n\n"
      const start = text.length
      text += p.text
      annotations.push({ kind: p.kind, start, end: text.length })
    }
    return { text, outcome: { v: 1, bodyEnd: body.length, annotations } }
  }

  const blocks = (text: string, outcome: PersistedToolOutcome) => {
    const without: ToolResultBlock = {
      type: "tool_result",
      toolUseId: "call_1",
      content: [{ type: "text", text }],
    }
    return { without, withOutcome: { ...without, outcome } satisfies ToolResultBlock }
  }

  const cases: Array<{ name: string; body: string; parts: Part[]; expected: string }> = [
    {
      name: "four annotation kinds in one outcome",
      body: "line 1\nline 2",
      parts: [
        { kind: "output-preview", text: preview },
        { kind: "output-truncated", text: truncated },
        { kind: "output-streak", text: streak },
        { kind: "mode-active", text: mode },
      ],
      expected: `line 1\nline 2\n\n${truncated}\n\n${streak}`,
    },
    {
      name: "empty body with only a stamp",
      body: "",
      parts: [{ kind: "mode-active", text: mode, join: "" }],
      expected: "(empty tool result)",
    },
    {
      name: "body that contains a note-like text itself",
      body: "first\n\n[note: this is body text]\nlast",
      parts: [{ kind: "mode-active", text: mode }],
      expected: "first\n\n[note: this is body text]\nlast",
    },
    {
      name: "truncated + blob",
      body: "head of output",
      parts: [
        { kind: "raw-output", text: raw },
        { kind: "output-truncated", text: truncated },
      ],
      expected: `head of output\n\n${truncated}`,
    },
    {
      name: "tasks paired tag in the body",
      body: tag(
        "tasks",
        ' action="add_many" result="added_many" total="1" done="0" doing="0" todo="1" canceled="0"',
        "\n#ce6b5b  todo      Phase 1\n",
      ),
      parts: [{ kind: "mode-active", text: mode }],
      expected:
        "OK added_many action=add_many total=1 done=0 doing=0 todo=1 canceled=0\n#ce6b5b  todo      Phase 1",
    },
    {
      name: "body with trailing newline and a tag between",
      body: "a\n",
      parts: [
        { kind: "raw-output", text: raw },
        { kind: "output-streak", text: streak },
      ],
      expected: `a\n\n${streak}`,
    },
  ]

  for (const c of cases) {
    test(`parity: ${c.name}`, () => {
      const { text, outcome } = build(c.body, c.parts)
      const { without, withOutcome } = blocks(text, outcome)
      expect(toolResultToWireText(withOutcome, sb)).toBe(toolResultToWireText(without, sb))
      expect(toolResultToWireText(withOutcome, sb)).toBe(c.expected)
    })
  }

  test("parity: media-only content gives the empty marker in both paths", () => {
    const image = {
      type: "image",
      source: { type: "base64", mediaType: "image/png", data: "AAAA" },
    } as unknown as ToolResultBlock["content"][number]
    const outcome: PersistedToolOutcome = { v: 1, bodyEnd: 0, annotations: [] }
    const without: ToolResultBlock = { type: "tool_result", toolUseId: "c", content: [image] }
    const withOutcome: ToolResultBlock = { ...without, outcome }
    expect(toolResultToWireText(withOutcome, sb)).toBe("(empty tool result)")
    expect(toolResultToWireText(without, sb)).toBe("(empty tool result)")
    // Empty text block + image: same.
    const emptyText = { ...without, content: [{ type: "text", text: "" } as const, image] }
    expect(toolResultToWireText({ ...emptyText, outcome }, sb)).toBe(
      toolResultToWireText(emptyText, sb),
    )
  })

  test("parity: an outcome that does not fit gives the old result", () => {
    const { text, outcome } = build("body", [{ kind: "output-truncated", text: truncated }])
    const { without } = blocks(text, outcome)
    const tooBig: ToolResultBlock = {
      ...without,
      outcome: { ...outcome, bodyEnd: text.length + 50 },
    }
    expect(toolResultToWireText(tooBig, sb)).toBe(toolResultToWireText(without, sb))
    // Text changed after the outcome was stored: offsets point to other text.
    const changed: ToolResultBlock = {
      ...without,
      content: [{ type: "text", text: "short" }],
      outcome,
    }
    const changedWithout: ToolResultBlock = { ...changed, outcome: undefined }
    delete changedWithout.outcome
    expect(toolResultToWireText(changed, sb)).toBe(toolResultToWireText(changedWithout, sb))
    expect(toolResultToWireText(changed, sb)).toBe("short")
  })

  test("parity: no outcome gives the old result", () => {
    const { text } = build("plain", [{ kind: "mode-active", text: mode }])
    const { without } = blocks(text, { v: 1, bodyEnd: 0, annotations: [] })
    expect(toolResultToWireText(without, sb)).toBe("plain")
  })

  test("a block with two text blocks uses the old path", () => {
    const block: ToolResultBlock = {
      type: "tool_result",
      toolUseId: "c",
      content: [
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ],
      outcome: { v: 1, bodyEnd: 3, annotations: [] },
    }
    expect(toolResultToWireText(block, sb)).toBe("one\ntwo")
  })
})

describe("design step 12b: the strip step reads tags with the sideband API", () => {
  const stamp = sb.render("mode-active", { attrs: { id: "ask", since: "2026-11-18T15:00:00Z" } })
  test("a closing bracket inside a quoted attribute: the whole tag goes", () => {
    const blob = sb.render("raw-output", { attrs: { path: "/tmp/a>b/x.raw", size: "1B" } })
    expect(stripMaAgentWireAnnotations(`a\n\n${blob}`, sb)).toBe("a")
  })
  test("NO_SIDEBAND: with no codec the text does not change", () => {
    const none = { ...sb, ready: false } as typeof sb
    const text = `x\n\n${stamp}`
    const b: ToolResultBlock = {
      type: "tool_result",
      toolUseId: "c",
      content: [{ type: "text", text }],
      outcome: {
        v: 1,
        bodyEnd: 1,
        annotations: [{ kind: "mode-active", start: 3, end: text.length }],
      },
    }
    expect(outcomeWireText(b, sb)).toBe("x")
    for (const api of [none, undefined]) {
      expect(stripMaAgentWireAnnotations(text, api)).toBe(text)
      expect(outcomeWireText(b, api)).toBeUndefined()
      expect(toolResultToWireText(b, api)).toBe(text)
    }
  })
})
