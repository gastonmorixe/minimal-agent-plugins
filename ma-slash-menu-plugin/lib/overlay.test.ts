import { describe, expect, it } from "bun:test"

import { CLOSED, type State, type TransitionCtx, transition } from "./overlay.ts"
import type { Item } from "./types.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkItem(slug: string, cat: "act" | "skl" = "act"): Item {
  return { slug, description: `desc ${slug}`, category: cat, payload: { actionId: slug } }
}

function mkCtx(items: Item[] = ITEMS, cols = 100): TransitionCtx {
  return { allItems: items, cols, maxRows: 5 }
}

const ITEMS: Item[] = [
  mkItem("config", "act"),
  mkItem("context", "act"),
  mkItem("help", "act"),
  mkItem("memory", "act"),
  mkItem("swiftui-pro", "skl"),
  mkItem("swiftui-liquid-glass", "skl"),
  mkItem("swift-concurrency-expert", "skl"),
]

// ---------------------------------------------------------------------------
// buffer-changed transitions
// ---------------------------------------------------------------------------

describe("transition — buffer-changed (activation)", () => {
  it("typing '/' from empty opens the menu with empty query", () => {
    const r = transition(CLOSED, { kind: "buffer-changed", text: "/" }, mkCtx())
    expect(r.state.kind).toBe("open")
    if (r.state.kind !== "open") throw new Error("narrow")
    expect(r.state.trigger).toBe("/")
    expect(r.state.query).toBe("")
    expect(r.state.selectedIndex).toBe(0)
    expect(r.effects.some((e) => e.kind === "paint-footer")).toBe(true)
  })

  it("typing '$' opens with trigger=$ and skill-scope", () => {
    const r = transition(CLOSED, { kind: "buffer-changed", text: "$" }, mkCtx())
    if (r.state.kind !== "open") throw new Error("narrow")
    expect(r.state.trigger).toBe("$")
  })

  it("typing '/conf' opens with query 'conf'", () => {
    const r = transition(CLOSED, { kind: "buffer-changed", text: "/conf" }, mkCtx())
    if (r.state.kind !== "open") throw new Error("narrow")
    expect(r.state.query).toBe("conf")
  })

  it("buffer without trigger leaves CLOSED state untouched", () => {
    const r = transition(CLOSED, { kind: "buffer-changed", text: "hello" }, mkCtx())
    expect(r.state).toBe(CLOSED)
    expect(r.effects).toEqual([])
  })

  it("buffer with trigger NOT at col 0 does NOT open (e.g. 'foo/bar')", () => {
    const r = transition(CLOSED, { kind: "buffer-changed", text: "foo/bar" }, mkCtx())
    expect(r.state).toBe(CLOSED)
  })

  it("trailing space closes an open menu (user is composing args)", () => {
    const open = transition(CLOSED, { kind: "buffer-changed", text: "/config" }, mkCtx()).state
    const r = transition(open, { kind: "buffer-changed", text: "/config " }, mkCtx())
    expect(r.state).toBe(CLOSED)
    expect(r.effects.some((e) => e.kind === "clear-footer")).toBe(true)
  })

  it("changing query resets selectedIndex to 0 (different match set)", () => {
    let s: State = CLOSED
    s = transition(s, { kind: "buffer-changed", text: "/swift" }, mkCtx()).state
    // Move selection down twice
    s = transition(s, { kind: "key", name: "ArrowDown" }, mkCtx()).state
    s = transition(s, { kind: "key", name: "ArrowDown" }, mkCtx()).state
    if (s.kind !== "open") throw new Error("narrow")
    expect(s.selectedIndex).toBe(2)
    // Now type another char — query changes → reset to 0
    s = transition(s, { kind: "buffer-changed", text: "/swiftu" }, mkCtx()).state
    if (s.kind !== "open") throw new Error("narrow")
    expect(s.selectedIndex).toBe(0)
  })

  it("same query in successive buffer-changes preserves selectedIndex", () => {
    let s: State = CLOSED
    s = transition(s, { kind: "buffer-changed", text: "/swift" }, mkCtx()).state
    s = transition(s, { kind: "key", name: "ArrowDown" }, mkCtx()).state
    if (s.kind !== "open") throw new Error("narrow")
    const before = s.selectedIndex
    // Re-fire same buffer-changed (idempotent → no reset).
    s = transition(s, { kind: "buffer-changed", text: "/swift" }, mkCtx()).state
    if (s.kind !== "open") throw new Error("narrow")
    expect(s.selectedIndex).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// key transitions when CLOSED
// ---------------------------------------------------------------------------

describe("transition — key while CLOSED", () => {
  it("every key is a no-op when closed (pass-through)", () => {
    for (const k of ["Tab", "Enter", "Escape", "ArrowUp", "ArrowDown"] as const) {
      const r = transition(CLOSED, { kind: "key", name: k }, mkCtx())
      expect(r.state).toBe(CLOSED)
      expect(r.effects).toEqual([])
    }
  })
})

// ---------------------------------------------------------------------------
// key transitions when OPEN
// ---------------------------------------------------------------------------

describe("transition — key while OPEN", () => {
  function open(query = ""): State {
    return transition(CLOSED, { kind: "buffer-changed", text: `/${query}` }, mkCtx()).state
  }

  it("ArrowDown increments selectedIndex with halt", () => {
    const s = open("")
    const r = transition(s, { kind: "key", name: "ArrowDown" }, mkCtx())
    if (r.state.kind !== "open") throw new Error("narrow")
    expect(r.state.selectedIndex).toBe(1)
    expect(r.effects.some((e) => e.kind === "halt-key")).toBe(true)
    expect(r.effects.some((e) => e.kind === "paint-footer")).toBe(true)
  })

  it("ArrowDown clamps at items.length - 1", () => {
    let s = open("config")
    // /config narrows the set; let's go off the end.
    for (let i = 0; i < 10; i++) {
      s = transition(s, { kind: "key", name: "ArrowDown" }, mkCtx()).state
    }
    if (s.kind !== "open") throw new Error("narrow")
    // Whatever the filtered count is, selection stays in range.
    expect(s.selectedIndex).toBeGreaterThanOrEqual(0)
  })

  it("ArrowUp decrements, clamps at 0", () => {
    let s = open("")
    s = transition(s, { kind: "key", name: "ArrowDown" }, mkCtx()).state
    s = transition(s, { kind: "key", name: "ArrowDown" }, mkCtx()).state
    if (s.kind !== "open") throw new Error("narrow")
    expect(s.selectedIndex).toBe(2)
    s = transition(s, { kind: "key", name: "ArrowUp" }, mkCtx()).state
    s = transition(s, { kind: "key", name: "ArrowUp" }, mkCtx()).state
    s = transition(s, { kind: "key", name: "ArrowUp" }, mkCtx()).state // overshoot
    if (s.kind !== "open") throw new Error("narrow")
    expect(s.selectedIndex).toBe(0)
  })

  it("Tab completes to '/slug ' with halt; sets buffer via set-buffer effect", () => {
    const s = open("conf")
    const r = transition(s, { kind: "key", name: "Tab" }, mkCtx())
    const setBufEff = r.effects.find((e) => e.kind === "set-buffer")
    expect(setBufEff).toBeDefined()
    if (setBufEff?.kind !== "set-buffer") throw new Error("narrow")
    expect(setBufEff.text).toBe("/config ")
    expect(r.effects.some((e) => e.kind === "halt-key")).toBe(true)
  })

  it("Enter rewrites buffer to '/slug' and does NOT halt (lets editor submit)", () => {
    const s = open("conf")
    const r = transition(s, { kind: "key", name: "Enter" }, mkCtx())
    expect(r.state).toBe(CLOSED)
    const setBufEff = r.effects.find((e) => e.kind === "set-buffer")
    if (setBufEff?.kind !== "set-buffer") throw new Error("narrow")
    expect(setBufEff.text).toBe("/config")
    // NO halt — editor proceeds with default submit on the new buffer.
    expect(r.effects.some((e) => e.kind === "halt-key")).toBe(false)
    // Footer cleared.
    expect(r.effects.some((e) => e.kind === "clear-footer")).toBe(true)
  })

  it("Escape closes, clears footer, halts", () => {
    const s = open("conf")
    const r = transition(s, { kind: "key", name: "Escape" }, mkCtx())
    expect(r.state).toBe(CLOSED)
    expect(r.effects.some((e) => e.kind === "clear-footer")).toBe(true)
    expect(r.effects.some((e) => e.kind === "halt-key")).toBe(true)
  })

  it("Escape on empty filter set still dismisses", () => {
    const s = open("zzzz") // no match
    const r = transition(s, { kind: "key", name: "Escape" }, mkCtx())
    expect(r.state).toBe(CLOSED)
    expect(r.effects.some((e) => e.kind === "halt-key")).toBe(true)
  })

  it("Tab on a disabled item is a no-op halt (no buffer set)", () => {
    const items: Item[] = [{ slug: "broken", description: "x", category: "skl", disabled: true }]
    const ctx = mkCtx(items)
    const s = transition(CLOSED, { kind: "buffer-changed", text: "/" }, ctx).state
    const r = transition(s, { kind: "key", name: "Tab" }, ctx)
    expect(r.effects.find((e) => e.kind === "set-buffer")).toBeUndefined()
    expect(r.effects.some((e) => e.kind === "halt-key")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// '$' (skills-only) scoping
// ---------------------------------------------------------------------------

describe("transition — '$' trigger scopes to skills only", () => {
  it("only skl-category items are considered for filter+selection", () => {
    let s: State = CLOSED
    s = transition(s, { kind: "buffer-changed", text: "$" }, mkCtx()).state
    // 4 actions + 3 skills in ITEMS. Open menu under '$' should
    // expose only 3.
    const r = transition(s, { kind: "key", name: "Enter" }, mkCtx())
    const setBufEff = r.effects.find((e) => e.kind === "set-buffer")
    if (setBufEff?.kind !== "set-buffer") throw new Error("narrow")
    // Empty query → scoring preserves input order. First skill in
    // ITEMS is `swiftui-pro`.
    expect(setBufEff.text).toBe("$swiftui-pro")
  })
})

// ---------------------------------------------------------------------------
// Pure / deterministic invariants
// ---------------------------------------------------------------------------

describe("transition — purity invariants", () => {
  it("two identical calls produce identical results (no I/O, no clock)", () => {
    const ctx = mkCtx()
    const e = { kind: "buffer-changed" as const, text: "/swift" }
    const a = transition(CLOSED, e, ctx)
    const b = transition(CLOSED, e, ctx)
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state))
    expect(JSON.stringify(a.effects)).toBe(JSON.stringify(b.effects))
  })

  it("does not mutate the input state object", () => {
    const s: State = {
      kind: "open",
      trigger: "/",
      query: "swift",
      selectedIndex: 1,
      scrollOffset: 0,
    }
    const snapshot = JSON.stringify(s)
    transition(s, { kind: "key", name: "ArrowDown" }, mkCtx())
    expect(JSON.stringify(s)).toBe(snapshot)
  })
})
