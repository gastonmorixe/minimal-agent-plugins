/**
 * Kit FSM tests: the sigil-agnostic overlay core.
 *
 * Everything is injected (spec, items, buffer) so no disk or TTY is needed.
 */

import { describe, expect, it } from "bun:test"

import { CLOSED, completeIntoBuffer, transition, type TransitionCtx } from "./overlay.ts"
import { filterByCategories, scoreItems } from "./scoring.ts"
import type { Item, TriggerSpec } from "./types.ts"

const AMP: TriggerSpec = {
  sigil: "&",
  tokenRe: /(^|[\s([{])&([a-zA-Z0-9_-]*)$/,
  spanRe: /(^|[\s([{])&([a-zA-Z0-9_-]*)/g,
  categories: ["prm"],
  enterVerb: "insert name",
  bodyVerb: "insert body",
  bodyFor: (item) => (item.payload as { body?: string })?.body ?? null,
}

function items(): Item[] {
  return [
    { slug: "review-pr", description: "review a pull request", category: "prm", payload: { body: "REVIEW BODY" } },
    { slug: "release", description: "release checklist", category: "prm", payload: { body: "RELEASE BODY" } },
    { slug: "other", description: "not a prompt", category: "act", payload: { body: "X" } },
  ]
}

function ctx(over: Partial<TransitionCtx> = {}): TransitionCtx {
  return { spec: AMP, allItems: items(), cols: 100, ...over }
}

function open(sigil = "&", query = "rev"): ReturnType<typeof transition>["state"] {
  let s = transition(CLOSED, { kind: "sigil-typed", sigil, cursor: 1 }, ctx()).state
  s = transition(s, { kind: "buffer-changed", text: `${sigil}${query}`, cursor: 1 + query.length }, ctx()).state
  return s
}

/** Open the menu against an arbitrary buffer, computing the true offsets. */
function openIn(text: string): ReturnType<typeof transition>["state"] {
  const sigilIdx = text.lastIndexOf("&")
  let s = transition(CLOSED, { kind: "sigil-typed", sigil: "&", cursor: sigilIdx + 1 }, ctx()).state
  s = transition(s, { kind: "buffer-changed", text, cursor: text.length }, ctx()).state
  return s
}

describe("arm + filter", () => {
  it("arms on the spec sigil and opens on buffer-changed", () => {
    const s = open()
    expect(s.kind).toBe("open")
    if (s.kind !== "open") return
    expect(s.query).toBe("rev")
  })

  it("ignores a different sigil", () => {
    const s = transition(CLOSED, { kind: "sigil-typed", sigil: "$", cursor: 1 }, ctx()).state
    expect(s.kind).toBe("closed")
  })

  it("arms mid-message (boundary prefix)", () => {
    // "&" sits at index 8, so the sigil-typed cursor is 9 and the token
    // starts at 8. This is what makes `&name extra text` work.
    const s = openIn("explain &rev")
    expect(s.kind).toBe("open")
  })

  it("filters to the spec categories only", () => {
    const pool = filterByCategories(items(), AMP.categories)
    expect(pool.map((i) => i.slug)).toEqual(["review-pr", "release"])
  })

  it("scoreItems drops non-matches and ranks the exact prefix first", () => {
    const out = scoreItems(
      [
        { slug: "release", description: "", category: "prm" },
        { slug: "review-pr", description: "", category: "prm" },
      ],
      "rev",
    )
    expect(out[0]!.slug).toBe("review-pr")
  })
})

describe("keys", () => {
  it("Enter inserts the NAME with a trailing space and halts", () => {
    const r = transition(open(), { kind: "key", name: "Enter" }, ctx({ bufferText: "&rev" }))
    expect(r.state).toEqual(CLOSED)
    const setBuf = r.effects.find((e) => e.kind === "set-buffer")
    expect(setBuf).toBeDefined()
    if (setBuf?.kind === "set-buffer") {
      expect(setBuf.text).toBe("&review-pr ")
    }
    expect(r.effects.some((e) => e.kind === "halt-key")).toBe(true)
  })

  it("Alt+Enter inserts the BODY and halts", () => {
    const r = transition(open(), { kind: "key", name: "Alt+Enter" }, ctx({ bufferText: "&rev" }))
    expect(r.state).toEqual(CLOSED)
    const setBuf = r.effects.find((e) => e.kind === "set-buffer")
    if (setBuf?.kind === "set-buffer") {
      expect(setBuf.text).toBe("REVIEW BODY")
    }
    expect(r.effects.some((e) => e.kind === "halt-key")).toBe(true)
  })

  it("Alt+Enter falls back to name insert when no body resolver", () => {
    const spec: TriggerSpec = { ...AMP, bodyFor: undefined }
    const r = transition(open(), { kind: "key", name: "Alt+Enter" }, ctx({ spec, bufferText: "&rev" }))
    const setBuf = r.effects.find((e) => e.kind === "set-buffer")
    if (setBuf?.kind === "set-buffer") expect(setBuf.text).toBe("&review-pr ")
  })

  it("Tab completes the name in place", () => {
    const r = transition(open(), { kind: "key", name: "Tab" }, ctx({ bufferText: "&rev" }))
    const setBuf = r.effects.find((e) => e.kind === "set-buffer")
    if (setBuf?.kind === "set-buffer") expect(setBuf.text).toBe("&review-pr ")
  })

  it("Escape closes and keeps the buffer", () => {
    const r = transition(open(), { kind: "key", name: "Escape" }, ctx({ bufferText: "&rev" }))
    expect(r.state).toEqual(CLOSED)
    expect(r.effects.some((e) => e.kind === "set-buffer")).toBe(false)
  })

  it("ArrowDown moves the selection and halts", () => {
    const r = transition(open("&", ""), { kind: "key", name: "ArrowDown" }, ctx())
    expect(r.effects.some((e) => e.kind === "halt-key")).toBe(true)
  })

  it("every key is a no-op when the menu is closed", () => {
    const r = transition(CLOSED, { kind: "key", name: "Enter" }, ctx())
    expect(r.state).toEqual(CLOSED)
    expect(r.effects).toEqual([])
  })
})

describe("completion preserves surroundings", () => {
  it("keeps text before and after the token", () => {
    // Open against the token-at-cursor form, then complete into a buffer
    // that has trailing text after the token.
    const state = openIn("please &rev") as Extract<ReturnType<typeof open>, { kind: "open" }>
    const out = completeIntoBuffer("please &rev now", state, "review-pr", true)
    expect(out.text).toBe("please &review-pr  now")
  })
})

describe("disabled rows are inert", () => {
  it("Enter on a disabled row halts without inserting", () => {
    const list: Item[] = [{ slug: "rev", description: "", category: "prm", disabled: true }]
    const c = ctx({ allItems: list, bufferText: "&rev" })
    let s = transition(CLOSED, { kind: "sigil-typed", sigil: "&", cursor: 1 }, c).state
    s = transition(s, { kind: "buffer-changed", text: "&rev", cursor: 4 }, c).state
    const r = transition(s, { kind: "key", name: "Enter" }, c)
    expect(r.effects.some((e) => e.kind === "set-buffer")).toBe(false)
    expect(r.effects.some((e) => e.kind === "halt-key")).toBe(true)
  })
})
