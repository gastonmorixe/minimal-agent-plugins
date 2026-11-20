/**
 * Parity of the codec scanner with core `TagScanner`.
 *
 * The cases are a copy of the inputs and expects of
 * `minimal-agent-core/src/plugins/scanner.test.ts` (40 cases). The `drive`
 * helper models the core caller (`plugins/stream.ts`): a codec scanner with
 * the default options (codeAware true, v1 escape on) over a registry where
 * each emit tag of the cases is a from-model kind with a `ma::emit::` name.
 * Core events map: `TagSpan.name` = node kind, `body` = node body or "",
 * `self_closing` = node selfClosing, `raw` = the raw argument of onNode.
 */
import { describe, expect, it } from "bun:test"

import createCodec from "./codec.ts"
import { makeRegistry, TEST_KINDS } from "./testing.ts"
import type { SidebandKind } from "./types.ts"

interface TagSpan {
  name: string
  attrs: Record<string, string>
  body: string
  self_closing: boolean
  raw: string
}

interface CollectedEvents {
  text: string[]
  tags: TagSpan[]
}

const EMIT_NAMES = [
  "spinner",
  "ping",
  "diff",
  "chart",
  "t",
  "foo",
  "x",
  "y",
  "memory",
  "outer",
  "inner",
  "same",
  "pre",
  "a",
  "b",
  "output",
]

function emitKind(name: string): SidebandKind {
  return {
    kind: name,
    owner: "test",
    direction: "from-model",
    placement: "inline",
    attrs: {},
    body: "text",
    trust: "untrusted",
    summary: "synthetic emit kind",
    legacy: [`ma::emit::${name}`],
  }
}

const codec = createCodec(makeRegistry(EMIT_NAMES.map(emitKind)))

function runChunks(chunks: string[], maxSpanBytes?: number): CollectedEvents {
  const events: CollectedEvents = { text: [], tags: [] }
  const scanner = codec.scanner(maxSpanBytes === undefined ? {} : { maxSpanUnits: maxSpanBytes })
  scanner.onText((t) => events.text.push(t))
  scanner.onNode((n, raw) =>
    events.tags.push({
      name: n.kind,
      attrs: n.attrs,
      body: n.body ?? "",
      self_closing: n.selfClosing,
      raw,
    }),
  )
  for (const c of chunks) scanner.write(c)
  scanner.end()
  return events
}

/**
 * Run the given chunks. Then run the same text at each 2-way split and one
 * unit per chunk, and assert the same joined text and the same tags: the
 * result must not depend on the chunk cuts.
 */
function drive(chunks: string[], maxSpanBytes?: number): CollectedEvents {
  const base = runChunks(chunks, maxSpanBytes)
  const full = chunks.join("")
  const splits: string[][] = [full.split("")]
  for (let k = 1; k < full.length; k++) splits.push([full.slice(0, k), full.slice(k)])
  for (const split of splits) {
    const e = runChunks(split, maxSpanBytes)
    expect({ cut: split.length, text: e.text.join(""), tags: e.tags }).toEqual({
      cut: split.length,
      text: base.text.join(""),
      tags: base.tags,
    })
  }
  return base
}

describe("codec scanner: TagScanner parity", () => {
  it("passes plain text through unchanged", () => {
    const e = drive(["hello ", "world"])
    expect(e.text.join("")).toBe("hello world")
    expect(e.tags).toHaveLength(0)
  })

  it("detects a self-closing tag", () => {
    const e = drive(["before ", '<ma::emit::spinner label="build" />', " after"])
    expect(e.tags).toHaveLength(1)
    expect(e.tags[0].name).toBe("spinner")
    expect(e.tags[0].attrs).toEqual({ label: "build" })
    expect(e.tags[0].body).toBe("")
    expect(e.tags[0].self_closing).toBe(true)
    expect(e.text.join("")).toBe("before  after")
  })

  it("detects a self-closing tag with no attrs", () => {
    const e = drive(["x<ma::emit::ping />y"])
    expect(e.tags).toHaveLength(1)
    expect(e.tags[0].name).toBe("ping")
    expect(e.tags[0].attrs).toEqual({})
    expect(e.tags[0].self_closing).toBe(true)
    expect(e.text.join("")).toBe("xy")
  })

  it("detects a tag with body and matching close", () => {
    const e = drive(["<ma::emit::diff>some body</ma::emit::diff>"])
    expect(e.tags).toHaveLength(1)
    expect(e.tags[0].name).toBe("diff")
    expect(e.tags[0].body).toBe("some body")
    expect(e.tags[0].self_closing).toBe(false)
  })

  it("detects an opener that spans two chunks", () => {
    const e = drive(["prefix <ma::emit::cha", 'rt type="bar">payload</ma::emit::chart>!'])
    expect(e.tags).toHaveLength(1)
    expect(e.tags[0].name).toBe("chart")
    expect(e.tags[0].attrs).toEqual({ type: "bar" })
    expect(e.tags[0].body).toBe("payload")
    expect(e.text.join("")).toBe("prefix !")
  })

  it("detects a close that spans two chunks", () => {
    const e = drive(["<ma::emit::diff>body</ma::em", "it::diff> tail"])
    expect(e.tags).toHaveLength(1)
    expect(e.tags[0].body).toBe("body")
    expect(e.text.join("")).toBe(" tail")
  })

  it("parses single-quoted attributes", () => {
    const e = drive(["<ma::emit::t a='one' b=\"two\" />"])
    expect(e.tags[0].attrs).toEqual({ a: "one", b: "two" })
  })

  it("supports minimal escapes in attribute values", () => {
    const e = drive(['<ma::emit::t a="a\\"b" c=\'d\\nE\' />'])
    expect(e.tags[0].attrs.a).toBe('a"b')
    expect(e.tags[0].attrs.c).toBe("d\nE")
  })

  it("honors the escape form backslash-lt-tui-colon-colon", () => {
    const e = drive(["literal \\<ma::emit::foo /> kept"])
    expect(e.tags).toHaveLength(0)
    expect(e.text.join("")).toBe("literal <ma::emit::foo /> kept")
  })

  it("flushes plain text before an opener", () => {
    const e = drive(["some text <ma::emit::x />more"])
    expect(e.text.join("")).toBe("some text more")
    expect(e.tags).toHaveLength(1)
  })

  it("falls back to raw text when span exceeds maxSpanBytes", () => {
    const big = "x".repeat(1000)
    const e = drive([`<ma::emit::diff>${big}`], 100)
    expect(e.tags).toHaveLength(0)
    // The raw, un-dispatched text should end up on the text channel.
    expect(e.text.join("")).toContain("<ma::emit::diff>")
    expect(e.text.join("")).toContain(big)
  })

  it("falls back to raw text when the stream ends mid-capture", () => {
    const e = drive(["<ma::emit::diff>unterminated body"])
    expect(e.tags).toHaveLength(0)
    expect(e.text.join("")).toBe("<ma::emit::diff>unterminated body")
  })

  it("falls back to raw text when the closer name doesn't match the opener", () => {
    // Regression: only `</ma::emit::NAME>` exactly matching the opener closes a
    // capture. A differently-named closer is just more body content, so the
    // capture runs to end-of-stream and falls back to raw flush — same code
    // path as the no-closer-at-all case above, but a distinct authoring
    // mistake worth documenting. Real instance: a memory tag closed with
    // `</thinking>` (the older Anthropic scratchpad pattern) instead of
    // `</ma::emit::memory>` flushed the body to the terminal but skipped the save.
    const e = drive(["<ma::emit::memory>save me</thinking> trailing"])
    expect(e.tags).toHaveLength(0)
    expect(e.text.join("")).toBe("<ma::emit::memory>save me</thinking> trailing")
  })

  it("handles nested different-name tags by capturing the outer raw body", () => {
    const e = drive(["<ma::emit::outer><ma::emit::inner /></ma::emit::outer>"])
    expect(e.tags).toHaveLength(1)
    expect(e.tags[0].name).toBe("outer")
    expect(e.tags[0].body).toBe("<ma::emit::inner />")
  })

  it("closes on first same-name close (accepted limitation)", () => {
    // Outer has body containing a same-name tag. The scanner does not track
    // nesting depth, so the first </ma::emit::same> closes the outer capture.
    const e = drive(["<ma::emit::same>inner<ma::emit::same/>tail</ma::emit::same>"])
    // The first "<ma::emit::same>" opens. Inside body, another self-closing
    // "<ma::emit::same/>" does not terminate because it has a slash-gt, not a
    // closing tag form. The first "</ma::emit::same>" is the real outer close.
    expect(e.tags).toHaveLength(1)
    expect(e.tags[0].body).toBe("inner<ma::emit::same/>tail")
  })

  it("emits multiple tags in a single stream", () => {
    const e = drive(["a<ma::emit::x />b<ma::emit::y>B</ma::emit::y>c"])
    expect(e.tags).toHaveLength(2)
    expect(e.tags[0].name).toBe("x")
    expect(e.tags[1].name).toBe("y")
    expect(e.text.join("")).toBe("abc")
  })

  it("streams text even when a dangling partial-opener prefix is in the tail", () => {
    // After the first chunk ends with '<tu', the scanner must hold it because
    // it could be the start of an opener. When the second chunk arrives as
    // plain text, the tail is flushed intact.
    const e = drive(["plain <tu", "rbulent waters"])
    expect(e.tags).toHaveLength(0)
    expect(e.text.join("")).toBe("plain <turbulent waters")
  })

  it("preserves body bytes exactly, including whitespace and newlines", () => {
    const body = "\nline one\n  line two\n"
    const e = drive([`<ma::emit::pre>${body}</ma::emit::pre>`])
    expect(e.tags).toHaveLength(1)
    expect(e.tags[0].body).toBe(body)
  })

  it("raw span on the tag event contains the full opener and closer", () => {
    const e = drive(['<ma::emit::x k="v">body</ma::emit::x>'])
    expect(e.tags[0].raw).toBe('<ma::emit::x k="v">body</ma::emit::x>')
  })

  it("raw span for self-closing tag is the opener alone", () => {
    const e = drive(['<ma::emit::x k="v" />'])
    expect(e.tags[0].raw).toBe('<ma::emit::x k="v" />')
  })

  // ---------------------------------------------------------------------
  // Markdown code-context regression tests
  //
  // The scanner used to greedily match `<ma::emit::NAME>` anywhere in the
  // stream, even inside backticked inline code or fenced blocks. That
  // broke mdstream's table renderer when a row cell contained something
  // like `` `<ma::emit::diff>` `` — the scanner started buffering, mdstream's
  // table state was wrecked, and the rest of the table fell through to
  // raw markdown. Symptom captured in the user's table-rendering report.
  // ---------------------------------------------------------------------

  it("ignores <ma::emit:: openers inside single-backtick inline code", () => {
    const e = drive(["see `<ma::emit::diff>` for details"])
    expect(e.tags).toHaveLength(0)
    expect(e.text.join("")).toBe("see `<ma::emit::diff>` for details")
  })

  it("ignores <ma::emit:: closers inside inline code too", () => {
    const e = drive(["wraps `</ma::emit::diff>` literally"])
    expect(e.tags).toHaveLength(0)
    expect(e.text.join("")).toBe("wraps `</ma::emit::diff>` literally")
  })

  it("regression: table cell with backticked tag plus following rows", () => {
    // Mirrors the exact user-reported failure: a table cell containing
    // `<ma::emit::diff>` followed by more table rows. The scanner must not
    // start a capture, so mdstream's table parser sees clean input.
    const md =
      "| Plugin | Notes |\n| --- | --- |\n| diff-view | `<ma::emit::diff>` |\n| memory | tag |\n"
    const e = drive([md])
    expect(e.tags).toHaveLength(0)
    expect(e.text.join("")).toBe(md)
  })

  it("ignores <ma::emit:: openers inside double-backtick inline code", () => {
    const e = drive(["``a `<ma::emit::x />` b``"])
    expect(e.tags).toHaveLength(0)
    expect(e.text.join("")).toBe("``a `<ma::emit::x />` b``")
  })

  it("re-enables tag detection after an inline code span closes", () => {
    const e = drive(["`<ma::emit::a />` then <ma::emit::b />"])
    expect(e.tags).toHaveLength(1)
    expect(e.tags[0].name).toBe("b")
    expect(e.text.join("")).toBe("`<ma::emit::a />` then ")
  })

  it("ignores <ma::emit:: openers inside a fenced code block (backticks)", () => {
    const md = "```\n<ma::emit::diff>body</ma::emit::diff>\n```\nafter"
    const e = drive([md])
    expect(e.tags).toHaveLength(0)
    expect(e.text.join("")).toBe(md)
  })

  it("ignores <ma::emit:: openers inside a fenced code block (tildes)", () => {
    const md = "~~~\n<ma::emit::diff>body</ma::emit::diff>\n~~~\nafter"
    const e = drive([md])
    expect(e.tags).toHaveLength(0)
    expect(e.text.join("")).toBe(md)
  })

  it("re-enables tag detection after a fenced code block closes", () => {
    const md = "```\n<ma::emit::a />\n```\n<ma::emit::b />"
    const e = drive([md])
    expect(e.tags).toHaveLength(1)
    expect(e.tags[0].name).toBe("b")
  })

  it("handles inline code split across chunk boundaries", () => {
    // Backtick run at end of chunk is held until classification is known.
    const e = drive(["pre `", "<ma::emit::x />` post"])
    expect(e.tags).toHaveLength(0)
    expect(e.text.join("")).toBe("pre `<ma::emit::x />` post")
  })

  it("handles fence opener split across chunk boundaries", () => {
    // Three backticks at line start could be a fence; the partial run
    // must be held until the third backtick arrives.
    const e = drive(["``", "`\n<ma::emit::x />\n```\n"])
    expect(e.tags).toHaveLength(0)
    expect(e.text.join("")).toBe("```\n<ma::emit::x />\n```\n")
  })

  it("a backtick mid-line does NOT open a fence", () => {
    // Fence detection only triggers at line start.
    const e = drive(["text ``` more <ma::emit::x />"])
    // Three backticks mid-line open a 3-tick inline code span; the tag
    // inside is suppressed; the span is unterminated so it stays open
    // until end-of-stream (still text).
    expect(e.tags).toHaveLength(0)
    expect(e.text.join("")).toBe("text ``` more <ma::emit::x />")
  })

  it("a fenced block whose close fence is longer than the open still closes", () => {
    const md = "```\nbody <ma::emit::x />\n````\nafter <ma::emit::y />"
    const e = drive([md])
    expect(e.tags).toHaveLength(1)
    expect(e.tags[0].name).toBe("y")
  })

  it("does NOT close a 3-backtick fence with a 2-backtick run", () => {
    const md = "```\n``\n<ma::emit::x />\n```\n"
    const e = drive([md])
    expect(e.tags).toHaveLength(0)
  })

  // ---------------------------------------------------------------------
  // emit-output tag shapes
  //
  // The emit-output plugin (plugins/emit-output) drives the scanner with
  // self-closing `<ma::emit::output ... />` tags carrying a `tool=` blob
  // pointer, a `path=` filesystem reference, and an optional `title=`. The
  // scanner is tag-name agnostic, but these cases pin the EXACT attribute
  // shapes that plugin depends on so a future scanner change can't silently
  // break blob/file resolution (the value of `path` carries slashes + dots,
  // which must survive the quoted-attribute parser verbatim).
  // ---------------------------------------------------------------------

  it("parses a self-closing emit-output tag with a tool= blob pointer", () => {
    const e = drive(['<ma::emit::output tool="call_00_dMMw39hweiGAR2xNzEoG1240" />'])
    expect(e.tags).toHaveLength(1)
    expect(e.tags[0].name).toBe("output")
    expect(e.tags[0].self_closing).toBe(true)
    expect(e.tags[0].body).toBe("")
    expect(e.tags[0].attrs).toEqual({ tool: "call_00_dMMw39hweiGAR2xNzEoG1240" })
  })

  it("preserves slashes and dots in a path= attribute value verbatim", () => {
    const e = drive(['before <ma::emit::output path="/tmp/render_tree.txt" /> after'])
    expect(e.tags).toHaveLength(1)
    expect(e.tags[0].name).toBe("output")
    expect(e.tags[0].attrs).toEqual({ path: "/tmp/render_tree.txt" })
    // The tag span is consumed; only the surrounding prose reaches text.
    expect(e.text.join("")).toBe("before  after")
  })

  it("parses path= together with an optional title=", () => {
    const e = drive(['<ma::emit::output path="/tmp/out.txt" title="Tree view" />'])
    expect(e.tags).toHaveLength(1)
    expect(e.tags[0].attrs).toEqual({ path: "/tmp/out.txt", title: "Tree view" })
  })

  it("parses tool= together with an optional title=", () => {
    const e = drive(['<ma::emit::output tool="toolu_01abc" title="render" />'])
    expect(e.tags[0].attrs).toEqual({ tool: "toolu_01abc", title: "render" })
  })

  it("handles an emit-output opener split across chunk boundaries", () => {
    const e = drive(["see <ma::emit::out", 'put tool="toolu_01abc" />!'])
    expect(e.tags).toHaveLength(1)
    expect(e.tags[0].name).toBe("output")
    expect(e.tags[0].attrs).toEqual({ tool: "toolu_01abc" })
    expect(e.text.join("")).toBe("see !")
  })

  it("splits an emit-output tag right inside the path= value across chunks", () => {
    const e = drive(['<ma::emit::output path="/tmp/re', 'nder_tree.txt" />'])
    expect(e.tags).toHaveLength(1)
    expect(e.tags[0].attrs).toEqual({ path: "/tmp/render_tree.txt" })
  })

  it("does not fire emit-output inside backticked inline code (doc reference)", () => {
    // PROMPT.md and prose reference the tag name in backticks; those must not
    // trigger a real render.
    const e = drive(['use `<ma::emit::output tool="..." />` for ascii art'])
    expect(e.tags).toHaveLength(0)
    expect(e.text.join("")).toBe('use `<ma::emit::output tool="..." />` for ascii art')
  })
})

describe("codec scanner: option edges", () => {
  function run(chunks: string[], opts: Parameters<typeof codec.scanner>[0]): string[] {
    const sc = codec.scanner(opts)
    const out: string[] = []
    sc.onText((t) => out.push(`T:${t}`))
    sc.onNode((n) => out.push(`N:${n.kind}`))
    for (const c of chunks) sc.write(c)
    sc.end()
    return out
  }
  it("codeAware false reads a node inside a code span", () => {
    expect(run(["see `<ma::emit::x />` here"], { codeAware: false })).toEqual([
      "T:see `",
      "N:x",
      "T:` here",
    ])
  })
  it("an escape split across chunks is held and decoded", () => {
    expect(run(["a \\<ma::em", "it::x /> b"], {})).toEqual(["T:a ", "T:<ma::emit::x /> b"])
  })
  it("the escape is not decoded when the scan reads no emit kind", () => {
    const k = { ...emitKind("ack"), legacy: ["ma::agent::ack"] }
    const c = createCodec(makeRegistry([k]))
    const sc = c.scanner({ kinds: ["ack"] })
    let t = ""
    sc.onText((s) => (t += s))
    sc.write("a \\<ma::emit::x /> b")
    sc.end()
    expect(t).toBe("a \\<ma::emit::x /> b")
  })
})

// ---------------------------------------------------------------------------
// Known differences from core TagScanner. These pin the codec result of
// today. Core results are in the comments (checked against
// minimal-agent-core/src/plugins/scanner.ts). Step 9 decides the behavior.
// ---------------------------------------------------------------------------

describe("known differences from core TagScanner (decided in step 9)", () => {
  function one(t: string): CollectedEvents {
    return drive([t])
  }
  function fires(t: string, name: string, body: string, attrs: Record<string, string> = {}) {
    const e = one(t)
    expect(e.tags.map((x) => [x.name, x.attrs, x.body])).toEqual([[name, attrs, body]])
    expect(e.text.join("")).toBe("")
  }

  it("codec fires on <ma::memory> (v1 without a level)", () => {
    // core: no tag, text "<ma::memory>b</ma::memory>"
    fires("<ma::memory>b</ma::memory>", "memory", "b")
  })
  it("codec fires on <ma::agent::memory> (other level)", () => {
    // core: no tag, the text passes through
    fires("<ma::agent::memory>b</ma::agent::memory>", "memory", "b")
  })
  it("codec fires on <ma:memory> (v2 form)", () => {
    // core: no tag, the text passes through
    fires("<ma:memory>b</ma:memory>", "memory", "b")
  })
  it("codec fires on <ma::plugin::diff> (plugin level)", () => {
    // core: no tag, the text passes through
    fires("<ma::plugin::diff>b</ma::plugin::diff>", "diff", "b")
  })
  it("codec fires on <ma::emit::Memory> and lowercases the kind", () => {
    // core: fires with name "Memory" (case kept)
    fires("<ma::emit::Memory>b</ma::emit::Memory>", "memory", "b")
  })
  it("codec closes on an upper-case closer </MA::EMIT::X>", () => {
    // core: no tag (closer is case-sensitive), raw flush of all the text
    fires("<ma::emit::x>b</MA::EMIT::X>", "x", "b")
  })
  it("codec closes on a closer with a space </ma::emit::x >", () => {
    // core: no tag, raw flush of all the text
    fires("<ma::emit::x>b</ma::emit::x >", "x", "b")
  })
  it('codec accepts spaces around = in an attr (path = "a")', () => {
    // core: no tag, the text passes through
    fires('<ma::emit::output path = "a" />', "output", "", { path: "a" })
  })
  it('codec does not fire when a quoted attr value has < (title="a<b")', () => {
    // core: fires, attrs { title: "a<b" }, text ""
    const t = '<ma::emit::output title="a<b" />'
    const e = one(t)
    expect(e.tags).toHaveLength(0)
    expect(e.text.join("")).toBe(t)
  })
  it('codec does not fire with no space between attrs (path="a"title="b")', () => {
    // core: fires, attrs { path: "a", title: "b" }, text ""
    const t = '<ma::emit::output path="a"title="b" />'
    const e = one(t)
    expect(e.tags).toHaveLength(0)
    expect(e.text.join("")).toBe(t)
  })
  it("duplicate attr: codec keeps the first value", () => {
    // core: the last value wins, attrs { a: "2" }
    fires('<ma::emit::t a="1" a="2" />', "t", "", { a: "1" })
  })
  it("unknown backslash escape \\q in an attr: codec keeps the backslash", () => {
    // core: drops the backslash, attrs { a: "xqy" }
    fires('<ma::emit::t a="x\\qy" />', "t", "", { a: "x\\qy" })
  })
  it("upper-case name <ma::emit::T />: codec gives kind t", () => {
    // core: fires with name "T"
    fires("<ma::emit::T />", "t", "")
  })
  it("upper-case prefix <MA::EMIT::t />: codec fires", () => {
    // core: no tag (the opener probe is case-sensitive), the text passes through
    fires("<MA::EMIT::t />", "t", "")
  })
  it("no kinds filter: the scanner also consumes <ma::agent::reflection-ack .../>", () => {
    // core: TagScanner reads only <ma::emit::, so the ack is text
    // "a <ma::agent::reflection-ack ... /> b" (the ack stripper removes it later)
    const c = createCodec(makeRegistry([...EMIT_NAMES.map(emitKind), TEST_KINDS.reflectionAck!]))
    const sc = c.scanner()
    let text = ""
    const kinds: string[] = []
    sc.onText((t) => (text += t))
    sc.onNode((n) => kinds.push(n.kind))
    sc.write('a <ma::agent::reflection-ack silence-for="2" reason="r" /> b')
    sc.end()
    expect(kinds).toEqual(["reflection-ack"])
    expect(text).toBe("a  b")
  })
})
