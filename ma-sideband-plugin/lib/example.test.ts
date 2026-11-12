import { describe, expect, test } from "bun:test"

import createCodec from "./codec.ts"
import { TEST_KINDS as K, makeRegistry } from "./testing.ts"

const codec = createCodec(makeRegistry())

describe("example", () => {
  test("built example uses defaults", () => {
    expect(codec.example(K.diagnostics!)).toBe(
      '<ma::agent::diagnostics count="0" scope="ad-hoc">\n...\n</ma::agent::diagnostics>',
    )
    expect(codec.example(K.rawOutput!)).toBe(
      '<ma::agent::raw-output path="..." size="..." sha256="..." />',
    )
  })
  test("explicit msg wins", () => {
    expect(codec.example(K.compaction!, { kind: "compaction", attrs: { kind: "local" } })).toBe(
      '<ma::context::compaction kind="local" />',
    )
  })
  test("kind.example used when no msg", () => {
    const kind = {
      ...K.modeChange!,
      example: { kind: "mode-change", attrs: { from: "a", to: "b", at: "t" } },
    }
    expect(codec.example(kind)).toBe('<ma::agent::mode-change from="a" to="b" at="t" />')
  })
  test("deterministic and parseable for to-model kinds", () => {
    for (const k of Object.values(K).filter((x) => x.direction === "to-model")) {
      const a = codec.example(k)
      expect(codec.example(k)).toBe(a)
      const nodes = codec.parse(a)
      expect(nodes.length).toBe(1)
      expect(nodes[0]?.kind).toBe(k.kind)
    }
  })
  test("from-model example is read by the scanner", () => {
    const k = K.reflectionAck!
    const sc = codec.scanner()
    const got: string[] = []
    let text = ""
    sc.onNode((n) => got.push(n.kind))
    sc.onText((t) => (text += t))
    sc.write(codec.example(k))
    sc.end()
    expect(got).toEqual(["reflection-ack"])
    expect(text).toBe("")
  })
})
