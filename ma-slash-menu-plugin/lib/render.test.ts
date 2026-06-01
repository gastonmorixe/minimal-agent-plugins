import { describe, expect, it } from "bun:test"

import { stripSgr } from "./palette.ts"
import { _internals, overlayHeight, renderOverlay } from "./render.ts"
import { scoreItems } from "./scoring.ts"
import type { Item, OverlayState } from "./types.ts"

function mkItem(slug: string, opts: Partial<Item> = {}): Item {
  return {
    slug,
    description: opts.description ?? `desc for ${slug}`,
    category: opts.category ?? "skl",
    tokens: opts.tokens,
    disabled: opts.disabled,
    disabledReason: opts.disabledReason,
    payload: opts.payload,
  }
}

function mkState(opts: Omit<Partial<OverlayState>, "items"> & { items: Item[] }): OverlayState {
  const items = scoreItems(opts.items, opts.query ?? "")
  return {
    trigger: opts.trigger ?? "/",
    query: opts.query ?? "",
    items,
    selectedIndex: opts.selectedIndex ?? 0,
    scrollOffset: opts.scrollOffset ?? 0,
    maxRows: opts.maxRows ?? 5,
    cols: opts.cols ?? 100,
    contextWindow: opts.contextWindow,
  }
}

describe("visibleWindow", () => {
  it("returns full list when shorter than maxRows", () => {
    const state = mkState({ items: [mkItem("a"), mkItem("b")] })
    const w = _internals.visibleWindow(state)
    expect(w).toEqual({ start: 0, end: 2, count: 2 })
  })

  it("clamps to maxRows when list is longer", () => {
    const items = Array.from({ length: 20 }, (_, i) => mkItem(`x${i}`))
    const state = mkState({ items, maxRows: 5 })
    const w = _internals.visibleWindow(state)
    expect(w).toEqual({ start: 0, end: 5, count: 5 })
  })

  it("scrolls down to keep selection visible", () => {
    const items = Array.from({ length: 20 }, (_, i) => mkItem(`x${i}`))
    const state = mkState({ items, maxRows: 5, selectedIndex: 8 })
    const w = _internals.visibleWindow(state)
    expect(w.start).toBeLessThanOrEqual(8)
    expect(w.end).toBeGreaterThan(8)
  })

  it("respects scrollOffset as a hint when selection fits", () => {
    const items = Array.from({ length: 20 }, (_, i) => mkItem(`x${i}`))
    const state = mkState({ items, maxRows: 5, selectedIndex: 7, scrollOffset: 5 })
    const w = _internals.visibleWindow(state)
    expect(w.start).toBe(5)
    expect(w.end).toBe(10)
  })

  it("returns count=0 when no items", () => {
    const state = mkState({ items: [] })
    expect(_internals.visibleWindow(state)).toEqual({ start: 0, end: 0, count: 0 })
  })
})

describe("renderOverlay — empty state", () => {
  it("shows '(no commands available)' on empty query + empty items", () => {
    const out = renderOverlay(mkState({ items: [] }))
    expect(stripSgr(out[0]!)).toContain("(no commands available)")
  })

  it("shows 'no commands match · /xyz' on filter miss", () => {
    const out = renderOverlay(mkState({ items: [mkItem("foo")], query: "xyz" }))
    expect(stripSgr(out[0]!)).toContain("no commands match")
    expect(stripSgr(out[0]!)).toContain("/xyz")
  })

  it("forced trigger gets '$' in the no-match message", () => {
    const out = renderOverlay(mkState({ items: [], query: "zzzz", trigger: "$" }))
    expect(stripSgr(out[0]!)).toContain("$zzzz")
  })
})

describe("renderOverlay — selection", () => {
  it("first row gets the ► selection arrow", () => {
    const out = renderOverlay(
      mkState({ items: [mkItem("alpha"), mkItem("beta")], selectedIndex: 0 }),
    )
    expect(stripSgr(out[0]!)).toContain("►")
    expect(stripSgr(out[1]!)).not.toContain("►")
  })

  it("second row gets the ► when selected", () => {
    const out = renderOverlay(
      mkState({ items: [mkItem("alpha"), mkItem("beta")], selectedIndex: 1 }),
    )
    expect(stripSgr(out[0]!)).not.toContain("►")
    expect(stripSgr(out[1]!)).toContain("►")
  })
})

describe("renderOverlay — sigil + slug", () => {
  it("'/' trigger renders the slug with leading '/'", () => {
    const out = renderOverlay(mkState({ items: [mkItem("config")], trigger: "/" }))
    expect(stripSgr(out[0]!)).toMatch(/\/config/)
  })

  it("'$' trigger renders the slug with leading '$'", () => {
    const out = renderOverlay(mkState({ items: [mkItem("swiftui-pro")], trigger: "$" }))
    expect(stripSgr(out[0]!)).toMatch(/\$swiftui-pro/)
  })
})

describe("renderOverlay — token chip", () => {
  it("shows formatted tokens when known", () => {
    const out = renderOverlay(mkState({ items: [mkItem("foo", { tokens: 2100 })] }))
    expect(stripSgr(out[0]!)).toContain("~2.1k")
  })

  it("does NOT show a token chip when tokens is undefined", () => {
    const out = renderOverlay(mkState({ items: [mkItem("foo")] }))
    expect(stripSgr(out[0]!)).not.toMatch(/~\d/)
  })

  it("severity color: cheap (<1k) uses dim+lime", () => {
    const out = renderOverlay(mkState({ items: [mkItem("foo", { tokens: 500 })] }))
    // dim+lime = ESC[2;38;5;118m
    expect(out[0]!).toContain("\x1b[2;38;5;118m")
  })

  it("severity color: heavy (8k–20k) uses dim red", () => {
    const out = renderOverlay(mkState({ items: [mkItem("foo", { tokens: 12_000 })] }))
    expect(out[0]!).toContain("\x1b[2;31m")
  })
})

describe("renderOverlay — scroll affordances", () => {
  it("shows '↑ N more' when scrolled past top", () => {
    const items = Array.from({ length: 20 }, (_, i) => mkItem(`item${i}`))
    const out = renderOverlay(mkState({ items, maxRows: 5, selectedIndex: 12, scrollOffset: 8 }))
    expect(stripSgr(out[0]!)).toContain("↑ 8 more")
  })

  it("shows '↓ N more' in divider when there's more below", () => {
    const items = Array.from({ length: 20 }, (_, i) => mkItem(`item${i}`))
    const out = renderOverlay(mkState({ items, maxRows: 5 }))
    // Last few lines include the divider; check for the "more" marker.
    const joined = out.map(stripSgr).join("\n")
    expect(joined).toContain("↓ 15 more")
  })

  it("no '↓ N more' when at end of list", () => {
    const items = Array.from({ length: 5 }, (_, i) => mkItem(`item${i}`))
    const out = renderOverlay(mkState({ items, maxRows: 5 }))
    const joined = out.map(stripSgr).join("\n")
    expect(joined).not.toContain("more")
  })
})

describe("overlayHeight — matches renderOverlay row count", () => {
  const items20 = Array.from({ length: 20 }, (_, i) => mkItem(`item${i}`))
  const cases = [
    { label: "scrolled (has ↑ more row)", selectedIndex: 12, scrollOffset: 8 },
    { label: "top of list (no ↑ more row)", selectedIndex: 1, scrollOffset: 0 },
  ]
  for (const c of cases) {
    it(c.label, () => {
      const state = mkState({
        items: items20,
        maxRows: 5,
        selectedIndex: c.selectedIndex,
        scrollOffset: c.scrollOffset,
      })
      // Regression: overlayHeight returned count+2 even when renderOverlay
      // emitted an extra "↑ N more" row (count+3), under-reserving a row.
      expect(overlayHeight(state)).toBe(renderOverlay(state).length)
    })
  }

  it("small list (no scroll affordances)", () => {
    const items = Array.from({ length: 3 }, (_, i) => mkItem(`item${i}`))
    const state = mkState({ items, maxRows: 5 })
    expect(overlayHeight(state)).toBe(renderOverlay(state).length)
  })
})

describe("renderOverlay — footer hint line", () => {
  it("shows ↑↓ ⇥ ⏎ esc chips", () => {
    const out = renderOverlay(mkState({ items: [mkItem("foo")] }))
    const last = stripSgr(out[out.length - 1]!)
    expect(last).toContain("↑↓")
    expect(last).toContain("⇥")
    expect(last).toContain("⏎")
    expect(last).toContain("esc")
  })

  it("tab hint becomes dynamic when query non-empty + match found", () => {
    const out = renderOverlay(
      mkState({ items: [mkItem("config"), mkItem("context")], query: "co" }),
    )
    const last = stripSgr(out[out.length - 1]!)
    expect(last).toContain("⇥ /config")
  })

  it("enter verb is 'load skill' for skill rows on '/'", () => {
    const out = renderOverlay(
      mkState({ items: [mkItem("foo", { category: "skl" })], trigger: "/" }),
    )
    const last = stripSgr(out[out.length - 1]!)
    expect(last).toContain("⏎ load skill")
  })

  it("enter verb is 'run' for action rows on '/'", () => {
    const out = renderOverlay(
      mkState({ items: [mkItem("config", { category: "act" })], trigger: "/" }),
    )
    const last = stripSgr(out[out.length - 1]!)
    expect(last).toContain("⏎ run")
  })

  it("enter verb is universally 'activate skill' on '$'", () => {
    const out = renderOverlay(
      mkState({ items: [mkItem("foo", { category: "skl" })], trigger: "$" }),
    )
    const last = stripSgr(out[out.length - 1]!)
    expect(last).toContain("⏎ activate skill")
  })

  it("'$' trigger shows 'forced activation' label", () => {
    const out = renderOverlay(
      mkState({ items: [mkItem("foo", { category: "skl" })], trigger: "$" }),
    )
    const last = stripSgr(out[out.length - 1]!)
    expect(last).toContain("forced activation")
  })

  it("'$' trigger shows cost-vs-context chip when both are known", () => {
    const out = renderOverlay(
      mkState({
        items: [mkItem("foo", { tokens: 2100 })],
        trigger: "$",
        contextWindow: 1_000_000,
      }),
    )
    const last = stripSgr(out[out.length - 1]!)
    expect(last).toContain("cost:")
    expect(last).toContain("~2.1k")
    expect(last).toContain("~1000k")
  })
})

describe("renderOverlay — disabled (broken) items", () => {
  it("marks broken items with dim-red description", () => {
    const out = renderOverlay(
      mkState({
        items: [mkItem("broken", { disabled: true, disabledReason: "parse fail" })],
      }),
    )
    // dim-red = ESC[2;31m
    expect(out[0]!).toContain("\x1b[2;31m")
  })

  it("enter verb is '(broken)' when selected row is disabled", () => {
    const out = renderOverlay(
      mkState({
        items: [mkItem("broken", { disabled: true })],
      }),
    )
    const last = stripSgr(out[out.length - 1]!)
    expect(last).toContain("(broken)")
  })
})

describe("renderOverlay — width invariant (no row wraps in production)", () => {
  // Phase 1 of this fix shipped to a real user session with an off-by-2
  // in the per-row width formula. The actions row "  ▸ /clear  …  act"
  // came out 129 cells at cols=127 — terminal wrapped, badge split as
  // "a / ct" across two physical rows, eraseLiveSeq miscounted, footer
  // rows leaked into scrollback on every keystroke. Never again.
  //
  // Rule: at any (cols >= 60, any item, any state), EVERY returned
  // line must satisfy stripSgr(line).length <= cols.

  for (const cols of [60, 70, 80, 100, 120, 127, 160, 200]) {
    it(`cols=${cols}: no row exceeds the terminal width`, () => {
      const ITEMS: Item[] = [
        mkItem("clear", { category: "act", description: "clear scrollback (history preserved)" }),
        mkItem("config", { category: "act", description: "view or edit user config" }),
        mkItem("context", { category: "act", description: "show context window / quota usage" }),
        mkItem("memory", { category: "act", description: "manage saved memories" }),
        mkItem("swiftui-pro", {
          category: "skl",
          description:
            "Comprehensively reviews SwiftUI code for best practices on modern APIs, maintainability, and performance.",
          tokens: 1000,
        }),
        mkItem("swift-concurrency-expert", {
          category: "skl",
          description:
            "Swift Concurrency review and remediation for Swift 6.2+. Use when asked to review Swift Concurrency.",
          tokens: 1100,
        }),
      ]
      const out = renderOverlay(mkState({ items: ITEMS, cols, query: "" }))
      for (const line of out) {
        const w = stripSgr(line).length
        if (w > cols) {
          throw new Error(
            `cols=${cols}: row width ${w} > ${cols} cells. line=${JSON.stringify(stripSgr(line))}`,
          )
        }
      }
    })
  }

  it("divider with N-more annotation also fits within cols", () => {
    const items = Array.from({ length: 50 }, (_, i) =>
      mkItem(`item${i}`, { description: `desc ${i}` }),
    )
    for (const cols of [60, 80, 100, 127, 160, 200]) {
      const out = renderOverlay(mkState({ items, cols, query: "", maxRows: 5 }))
      const divider = out.find((l) => stripSgr(l).includes("─")) ?? ""
      expect(stripSgr(divider).length).toBeLessThanOrEqual(cols)
    }
  })

  it("forced-mode hint with cost chip + 'forced activation' still fits", () => {
    const items = [mkItem("swift-concurrency-expert", { category: "skl", tokens: 1100 })]
    for (const cols of [80, 100, 127, 160]) {
      const out = renderOverlay(mkState({ items, cols, trigger: "$", contextWindow: 1_000_000 }))
      const hintLine = out[out.length - 1] ?? ""
      expect(stripSgr(hintLine).length).toBeLessThanOrEqual(cols)
    }
  })
})

describe("renderOverlay — width degradation", () => {
  it("at >= 100 cols: icon, slug, description, and tokens all show", () => {
    const out = renderOverlay(
      mkState({
        items: [mkItem("foo", { tokens: 2100, description: "this is a description" })],
        cols: 110,
      }),
    )
    const row = stripSgr(out[0]!)
    expect(row).toContain("this is a description")
    expect(row).toContain("~2.1k")
    expect(row).toContain("✦") // skill icon
  })

  it("at 80–99 cols: tokens + description still show (no trailing badge)", () => {
    const out = renderOverlay(
      mkState({
        items: [mkItem("foo", { tokens: 2100, description: "this is a description" })],
        cols: 90,
      }),
    )
    const row = stripSgr(out[0]!)
    expect(row).toContain("this is a description")
    expect(row).toContain("~2.1k")
    // Old text badges are GONE — the leading icon carries category now.
    expect(row).not.toContain(" skl")
    expect(row).not.toContain(" act")
  })

  it("at 60–79 cols: description drops; tokens still shown", () => {
    const out = renderOverlay(
      mkState({
        items: [mkItem("foo", { tokens: 2100, description: "this is a description" })],
        cols: 70,
      }),
    )
    const row = stripSgr(out[0]!)
    expect(row).not.toContain("this is a description")
    expect(row).toContain("~2.1k")
  })

  it("at < 60 cols: description AND tokens drop; just the slug remains", () => {
    const out = renderOverlay(
      mkState({
        items: [mkItem("foo", { tokens: 2100, description: "this is a description" })],
        cols: 50,
      }),
    )
    const row = stripSgr(out[0]!)
    expect(row).not.toContain("this is a description")
    expect(row).not.toContain("~2.1k")
    // Slug is still there.
    expect(row).toContain("/foo")
  })
})

describe("renderOverlay — fuzzy highlight", () => {
  it("highlights matched chars in lime+bold", () => {
    const out = renderOverlay(
      mkState({
        items: [mkItem("config")],
        query: "conf",
      }),
    )
    // The boldLime SGR (\x1b[1;38;5;118m) wraps the matched chars.
    expect(out[0]!).toContain("\x1b[1;38;5;118m")
  })

  it("non-matched chars stay in selection color", () => {
    const out = renderOverlay(
      mkState({
        items: [mkItem("apple-development-official")],
        query: "ado",
      }),
    )
    // Mixed coloring: both bold-lime (match) and bold-sky (selected base).
    expect(out[0]!).toContain("\x1b[1;38;5;118m")
    expect(out[0]!).toContain("\x1b[1;38;5;45m")
  })
})
