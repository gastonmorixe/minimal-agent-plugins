import { describe, expect, test } from "bun:test"

import {
  expandTemplate,
  parseSidebandCall,
  PromptTemplateError,
  PromptTemplateSyntaxError,
  renderTemplate,
  type SidebandCallMessage,
  type TemplateSideband,
} from "./index.ts"

class UnknownKind extends Error {}

/** A fake API that records the calls and renders a visible form. */
function fakeSideband(kinds = ["raw-output", "output-preview", "binary-result", "memory"]) {
  const calls: unknown[][] = []
  const check = (k: string) => {
    if (!kinds.includes(k)) throw new UnknownKind(k)
  }
  const a = (msg?: SidebandCallMessage) =>
    Object.entries(msg?.attrs ?? {})
      .map(([k, v]) => ` ${k}="${v}"`)
      .join("")
  const sb: TemplateSideband = {
    ready: true,
    render(k, msg) {
      calls.push(["render", k, msg])
      check(k)
      return `<${k}${a(msg)} />`
    },
    open(k, msg) {
      calls.push(["open", k, msg])
      check(k)
      return `<${k}${a(msg)}>`
    },
    close(k) {
      calls.push(["close", k])
      check(k)
      return `</${k}>`
    },
    name(k) {
      check(k)
      return `ns::${k}`
    },
    example(k, msg) {
      calls.push(["example", k, msg])
      check(k)
      return `<${k}${a(msg)}>ex</${k}>`
    },
  }
  return { sb, calls }
}

describe("grammar: each op", () => {
  const { sb, calls } = fakeSideband()
  test("tag", () => {
    expect(expandTemplate("a %%sideband:tag binary-result%% b", { sideband: sb })).toBe(
      "a <binary-result /> b",
    )
    expect(calls.at(-1)).toEqual(["render", "binary-result", {}])
  })
  test("open and close", () => {
    const t = '%%sideband:open output-preview shown="N" total="M" tool="X"%%x%%sideband:close output-preview%%'
    expect(expandTemplate(t, { sideband: sb })).toBe(
      '<output-preview shown="N" total="M" tool="X">x</output-preview>',
    )
  })
  test("name", () => {
    expect(expandTemplate("the %%sideband:name memory%% block", { sideband: sb })).toBe(
      "the ns::memory block",
    )
  })
  test("example with and without attrs", () => {
    expect(expandTemplate("%%sideband:example memory%%", { sideband: sb })).toBe(
      "<memory>ex</memory>",
    )
    expect(calls.at(-1)).toEqual(["example", "memory", undefined])
    expect(expandTemplate("%%sideband:example memory id=m1%%", { sideband: sb })).toBe(
      '<memory id="m1">ex</memory>',
    )
  })
})

describe("grammar: attribute values", () => {
  const { sb, calls } = fakeSideband()
  test("a quoted value holds spaces and < and the quotes are removed", () => {
    const t = '%%sideband:tag raw-output path="<abs path>" size="<size>"%%'
    expect(expandTemplate(t, { sideband: sb })).toBe('<raw-output path="<abs path>" size="<size>" />')
    expect(calls.at(-1)).toEqual([
      "render",
      "raw-output",
      { attrs: { path: "<abs path>", size: "<size>" } },
    ])
  })
  test("@var gives the var value with its type", () => {
    const t = "%%sideband:tag raw-output size=@n path=@p%%"
    expect(expandTemplate(t, { sideband: sb, vars: { n: 3, p: "/a b" } })).toBe(
      '<raw-output size="3" path="/a b" />',
    )
    expect(calls.at(-1)).toEqual(["render", "raw-output", { attrs: { size: 3, path: "/a b" } }])
  })
  test("@var with no value throws PromptTemplateError and lists the name", () => {
    expect(() => expandTemplate("%%sideband:tag raw-output size=@n%%", { sideband: sb })).toThrow(
      PromptTemplateError,
    )
    try {
      expandTemplate("%%sideband:tag raw-output size=@n%%", { sideband: sb })
    } catch (e) {
      expect((e as PromptTemplateError).missing).toEqual(["n"])
    }
  })
  test("a bare value", () => {
    expect(expandTemplate("%%sideband:tag raw-output size=1.5kB%%", { sideband: sb })).toBe(
      '<raw-output size="1.5kB" />',
    )
  })
  test("attrs keep the written order in the parse; the codec decides the wire order", () => {
    expect(parseSidebandCall('tag raw-output b=1 a="x y" c=@v')).toEqual({
      op: "tag",
      kind: "raw-output",
      attrs: [
        { key: "b", value: "1" },
        { key: "a", value: "x y" },
        { key: "c", varName: "v" },
      ],
    })
  })
  test("an empty quoted value", () => {
    expect(parseSidebandCall('tag raw-output a=""').attrs).toEqual([{ key: "a", value: "" }])
  })
})

describe("escape %%%%", () => {
  test("%%%% writes %%", () => {
    expect(expandTemplate("100%%%% sure")).toBe("100%% sure")
  })
  test("%%%%name%%%% gives a literal placeholder", () => {
    expect(expandTemplate("%%%%name%%%%", { vars: { name: "X" } })).toBe("%%name%%")
  })
  test("%%%%sideband:tag x%%%% gives a literal call", () => {
    const { sb } = fakeSideband()
    expect(expandTemplate("%%%%sideband:tag memory%%%%", { sideband: sb })).toBe(
      "%%sideband:tag memory%%",
    )
  })
})

describe("errors", () => {
  const { sb } = fakeSideband()
  const bad = [
    "%%sideband:%%",
    "%%sideband:tag%%",
    "%%sideband:tag %%",
    "%%sideband:tag  memory%%",
    "%%sideband:tag Memory%%",
    "%%sideband:tag memory %%",
    "%%sideband:tag memory a%%",
    "%%sideband:tag memory a=%%",
    '%%sideband:tag memory a="x%%',
    "%%sideband:tag memory a=1 a=2%%",
    "%%sideband:close memory a=1%%",
    "%%sideband:name memory a=1%%",
    "%%sideband:tag memory\n%%",
    "%%sideband:tag memory",
  ]
  for (const t of bad) {
    test(`malformed: ${JSON.stringify(t)}`, () => {
      expect(() => expandTemplate(t, { sideband: sb })).toThrow(PromptTemplateSyntaxError)
    })
  }
  test("the syntax error is a PromptTemplateError with the offset and source", () => {
    try {
      expandTemplate("ab %%sideband:tag%%", { sideband: sb, source: "/p.md" })
      throw new Error("no throw")
    } catch (e) {
      expect(e).toBeInstanceOf(PromptTemplateError)
      const err = e as PromptTemplateSyntaxError
      expect(err.offset).toBe(3)
      expect(err.source).toBe("/p.md")
      expect(err.message).toContain("/p.md")
    }
  })
  test("unknown op", () => {
    expect(() => expandTemplate("%%sideband:render memory%%", { sideband: sb })).toThrow(
      /unknown sideband op "render"/,
    )
  })
  test("unknown kind with a codec: the API error passes through", () => {
    expect(() => expandTemplate("%%sideband:tag nope%%", { sideband: sb })).toThrow(UnknownKind)
    expect(() => expandTemplate("%%sideband:open nope%%", { sideband: sb })).toThrow(UnknownKind)
  })
})

describe("one pass: no rescan of output", () => {
  const { sb, calls } = fakeSideband()
  test("a var value that holds a call stays literal", () => {
    const before = calls.length
    const out = expandTemplate("x %%a%% y", {
      sideband: sb,
      vars: { a: "%%sideband:tag memory%%" },
    })
    expect(out).toBe("x %%sideband:tag memory%% y")
    expect(calls.length).toBe(before)
  })
  test("a var value that holds a var or an escape stays literal", () => {
    expect(expandTemplate("%%a%%", { vars: { a: "%%b%% %%%%", b: "B" } })).toBe("%%b%% %%%%")
  })
  test("an @var value with %% stays an attr value", () => {
    const out = expandTemplate("%%sideband:tag memory id=@v%%", {
      sideband: sb,
      vars: { v: "%%sideband:tag memory%%" },
    })
    expect(out).toBe('<memory id="%%sideband:tag memory%%" />')
  })
  test("the API output is not scanned", () => {
    const sb2: TemplateSideband = { ...sb, render: () => "%%a%%" }
    expect(expandTemplate("%%sideband:tag memory%%", { sideband: sb2, vars: { a: "A" } })).toBe(
      "%%a%%",
    )
  })
})

describe("no codec: each op renders the kind name (design 50 section 3)", () => {
  test("no sideband in the context", () => {
    const t =
      '%%sideband:tag raw-output path="p"%% %%sideband:open memory%% %%sideband:close memory%% %%sideband:name tasks%% %%sideband:example diff%%'
    expect(expandTemplate(t)).toBe("raw-output memory memory tasks diff")
  })
  test("a sideband API that is not ready uses name()", () => {
    const sb: TemplateSideband = {
      ready: false,
      render: () => "",
      name: (k) => k,
      example: () => "",
    }
    expect(expandTemplate("adds `%%sideband:tag raw-output size=@s%%`.", { sideband: sb, vars: { s: 1 } })).toBe(
      "adds `raw-output`.",
    )
  })
  test("a malformed token still throws with no codec", () => {
    expect(() => expandTemplate("%%sideband:bad x%%")).toThrow(PromptTemplateSyntaxError)
  })
  test("a codec with no open/close gives an empty string", () => {
    const { sb } = fakeSideband()
    const { open: _o, close: _c, ...rest } = sb
    expect(expandTemplate("[%%sideband:open memory%%|%%sideband:close memory%%]", { sideband: rest })).toBe(
      "[|]",
    )
  })
})

describe("old templates keep their bytes", () => {
  const cases: [string, Record<string, string | number>][] = [
    ["Hello %%name%%\n%%opt?%%\nEnd", { name: "W" }],
    ["Hello %%name%%\n%%opt?%%\nEnd", { name: "W", opt: "O" }],
    ["x %%sid.short%% y %%a-b%%", { "sid.short": "s1", "a-b": 2 }],
    ["%%a%%b%%%%", { a: "1", b: "2" }],
    ["no tokens 50% here %% and %%x y%%", {}],
    ["  lead %%a%% trail  \n", { a: "1" }],
  ]
  for (const [t, vars] of cases) {
    test(JSON.stringify(t), () => {
      const want = renderTemplate(t, vars, { trim: false })
      const got = expandTemplate(t, { vars })
      if (t.includes("%%%%")) expect(got).toBe("1b%%")
      else expect(got).toBe(want)
    })
  }
  test("a required var with no value throws like renderTemplate", () => {
    expect(() => expandTemplate("%%x%% %%y%%")).toThrow(PromptTemplateError)
    try {
      expandTemplate("%%x%% %%y%% %%x%%")
    } catch (e) {
      expect((e as PromptTemplateError).missing).toEqual(["x", "y"])
    }
  })
  test("missing: keep leaves the token", () => {
    expect(expandTemplate("a %%x%% b", {}, { missing: "keep" })).toBe("a %%x%% b")
  })
  test("trim is off by default and on when asked", () => {
    expect(expandTemplate(" a ")).toBe(" a ")
    expect(expandTemplate(" a ", {}, { trim: true })).toBe("a")
  })
})
