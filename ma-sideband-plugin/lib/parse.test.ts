import { describe, expect, test } from "bun:test"

import createCodec from "./codec.ts"
import { makeRegistry } from "./testing.ts"

const codec = createCodec(makeRegistry())

describe("parse v2 and legacy forms", () => {
  test("v2 empty element", () => {
    const n = codec.parse('<ma:mode-active id="x" since="s" />')
    expect(n[0]).toMatchObject({
      kind: "mode-active",
      form: "v2",
      selfClosing: true,
      attrs: { id: "x", since: "s" },
    })
    expect(n[0]?.legacyQname).toBeUndefined()
  })
  test("v2 ma prefix any case, single quotes, refs", () => {
    const n = codec.parse("<MA:Tasks a='x&amp;y&#65;'>b&lt;&#x42;</MA:Tasks>")
    expect(n[0]).toMatchObject({ kind: "tasks", attrs: { a: "x&yA" }, body: "b<B", form: "v2" })
  })
  test("v2 segment mapping: underscore and dot to dash", () => {
    expect(codec.parse("<ma:Some_kind.x />")[0]?.kind).toBe("some-kind-x")
  })
  test("v2 CDATA body joined", () => {
    expect(codec.parse("<ma:output><![CDATA[a<b]]>&amp;c</ma:output>")[0]?.body).toBe("a<b&c")
  })
  test("bad ref stays literal", () => {
    const n = codec.parse('<ma:x a="&#0;&bogus;&#1114112;">&#0; &</ma:x>')
    expect(n[0]?.attrs.a).toBe("&#0;&bogus;&#1114112;")
    expect(n[0]?.body).toBe("&#0; &")
  })
  test("duplicate attr: first wins", () => {
    expect(codec.parse('<ma:x a="1" a="2" />')[0]?.attrs).toEqual({ a: "1" })
  })
  test("bare forms", () => {
    const n = codec.parse('<mode-change from="a" to="b" /> <memory-saved id="1">hi</memory-saved>')
    expect(n.map((x) => [x.kind, x.form, x.legacyQname])).toEqual([
      ["mode-change", "v1-bare", "mode-change"],
      ["memory-saved", "v1-bare", "memory-saved"],
    ])
  })
  test("L1: one segment, level, other level, A2", () => {
    const k = (s: string): string | undefined => codec.parse(`<${s} />`)[0]?.kind
    expect(k("ma::mode-active")).toBe("mode-active")
    expect(k("ma::agent::tasks")).toBe("tasks")
    expect(k("ma::plugin::memory::saved")).toBe("memory-saved")
    expect(k("ma::plugin::memory::short-term")).toBe("short-term-memory")
    expect(k("ma::intercom::peer")).toBe("intercom-peer")
    expect(k("ma::tui::name")).toBe("tui-name")
    expect(k("ma::context::compaction")).toBe("compaction")
  })
  test("L1 step 1: registered legacy alias first", () => {
    const n = codec.parse('<ma::agent::inline-ack reason="r" />')
    expect(n[0]).toMatchObject({
      kind: "inline-ack",
      form: "v1",
      legacyQname: "ma::agent::inline-ack",
    })
  })
  test("sys role: kind is role, name is attr; entities decoded", () => {
    const n = codec.parse('<ma::sys::tool name="a&quot;b&amp;c">\nB\n</ma::sys::tool>')
    expect(n[0]).toMatchObject({ kind: "tool", attrs: { name: 'a"b&c' }, body: "B" })
  })
  test("mixed close tags", () => {
    const n = codec.parse('<memory-saved id="1">x</ma::plugin::memory::saved>')
    expect(n[0]).toMatchObject({ kind: "memory-saved", body: "x", form: "v1-bare" })
  })
  test("v1 body verbatim unless legacyBodyEscaped", () => {
    expect(codec.parse("<ma::agent::policy>a&lt;b</ma::agent::policy>")[0]?.body).toBe("a&lt;b")
    expect(
      codec.parse("<ma::agent::short-term-memory>\na&lt;b\n</ma::agent::short-term-memory>")[0]
        ?.body,
    ).toBe("a<b")
  })
  test("placeholder segments skipped", () => {
    expect(codec.parse("<ma::sys::ROLE name='x' />")).toEqual([])
    expect(codec.parse("<ma::*::x />")).toEqual([])
    expect(codec.parse("<ma::{a}::x />")).toEqual([])
  })
  test("body ends at first same-kind close, nodes in body not returned", () => {
    const n = codec.parse("<ma:x>a<ma:x>b</ma:x>c</ma:x>")
    expect(n.length).toBe(1)
    expect(n[0]?.body).toBe("a<ma:x>b")
  })
  test("never throws, text ignored", () => {
    expect(codec.parse("<ma:<<<ma:")).toEqual([])
    expect(codec.parse("plain <b>text</b>")).toEqual([])
    expect(codec.parse('<ma:x a="unterminated')).toEqual([])
  })
  test("spans are UTF-16 offsets", () => {
    const s = "\u{1F600}<ma:x />"
    const n = codec.parse(s)
    expect(n[0]?.span).toEqual({ start: 2, end: s.length })
  })
})

describe("scanner", () => {
  function run(chunks: string[]): { out: string[]; raws: string[] } {
    const sc = codec.scanner()
    const out: string[] = []
    const raws: string[] = []
    sc.onText((t) => out.push(`T:${t}`))
    sc.onNode((n, raw) => {
      out.push(`N:${n.kind}:${n.body ?? ""}`)
      raws.push(raw)
    })
    for (const c of chunks) sc.write(c)
    sc.end()
    return { out, raws }
  }
  const input = 'before <ma::agent::inline-ack reason="r">body</ma::agent::inline-ack> after'
  test("any split gives same events", () => {
    for (let i = 0; i <= input.length; i++) {
      const r = run([input.slice(0, i), input.slice(i)])
      expect(r.out.join("|").replace(/\|T:/g, "").replace(/^T:/, "")).toContain("N:inline-ack:body")
      expect(r.raws).toEqual(['<ma::agent::inline-ack reason="r">body</ma::agent::inline-ack>'])
    }
  })
  test("text and raw concatenation equals input", () => {
    const sc = codec.scanner()
    let all = ""
    sc.onText((t) => (all += t))
    sc.onNode((_n, raw) => (all += raw))
    for (const ch of input) sc.write(ch)
    sc.end()
    expect(all).toBe(input)
  })
  test("to-model and unknown kinds pass through as text", () => {
    const t = '<ma::agent::mode-active id="x" /> <ma:nope />'
    const r = run([t])
    expect(r.raws).toEqual([])
    expect(r.out.map((s) => s.slice(2)).join("")).toBe(t)
  })
  test("unterminated capture flushes as text at end", () => {
    const t = "x <ma::agent::inline-ack reason='r'>never closed"
    const r = run([t.slice(0, 10), t.slice(10)])
    expect(r.raws).toEqual([])
    expect(r.out.map((s) => s.slice(2)).join("")).toBe(t)
  })
  test("lone < and held tail flush", () => {
    const r = run(["a <", " b <m"])
    expect(r.out.map((s) => s.slice(2)).join("")).toBe("a < b <m")
  })
})

describe("hostile input", () => {
  test("many unclosed openers finish fast", () => {
    const t0 = performance.now()
    const out = codec.parse("<ma:policy>".repeat(20000))
    expect(Array.isArray(out)).toBe(true)
    expect(performance.now() - t0).toBeLessThan(1000)
  })
})

describe("linear time on HTML-like text (M1)", () => {
  // Before the fix, each `<` that is not a tag copied the rest of the buffer:
  // 192 KB of `<div>a</div>` took about 1.6 s. Core TagScanner takes about 1 ms.
  const html = (kb: number) => "<div>a</div>".repeat(Math.ceil((kb * 1024) / 12))
  const time = (f: () => void): number => {
    f() // warm up
    const t0 = performance.now()
    f()
    return performance.now() - t0
  }
  const scan = (t: string) => () => {
    const s = codec.scanner()
    s.onText(() => {})
    s.write(t)
    s.end()
  }
  const small = html(48)
  const big = html(192)
  test("parse: 192 KB below 50 ms and ratio 48 KB to 192 KB below 8", () => {
    if (process.env.CI) return
    const a = time(() => codec.parse(small))
    const b = time(() => codec.parse(big))
    expect(b).toBeLessThan(50)
    expect(b / Math.max(a, 0.5)).toBeLessThan(8)
  })
  test("scanner: 192 KB below 50 ms and ratio 48 KB to 192 KB below 8", () => {
    if (process.env.CI) return
    const a = time(scan(small))
    const b = time(scan(big))
    expect(b).toBeLessThan(50)
    expect(b / Math.max(a, 0.5)).toBeLessThan(8)
  })
})
