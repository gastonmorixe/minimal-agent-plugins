/**
 * Config-driven status-bar segment ordering + visibility.
 *
 * @module quota-status/render.segments.test
 */

import { describe, expect, it } from "bun:test"

import type { QuotaWindow, SessionTokens } from "./host-types.ts"
import { stripAnsi } from "./lib/term-width.ts"
import { DEFAULT_SEGMENT_ORDER, normalizeSegmentOrder, renderQuotaFooter } from "./render.ts"

const TOKENS: SessionTokens = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreate: 0,
  total: 0,
  turns: 0,
  contextSize: 24_000,
  contextSizeEstimated: false,
}

const WINDOWS: QuotaWindow[] = [
  { id: "5h", utilization: 0.21 },
  { id: "7d", utilization: 0.08 },
]

const baseOpts = {
  contextWindow: 200_000,
  effort: "high",
  modelLabel: "anth-4.8",
  sid: "b00e2d52",
} as const

function order(out: string): { quota: number; context: number; model: number; sid: number } {
  const s = stripAnsi(out)
  return {
    quota: s.indexOf("5h"),
    context: s.indexOf("k"), // session token count ends with k/M; rough anchor
    model: s.indexOf("anth-4.8"),
    sid: s.indexOf("b00e2d52"),
  }
}

describe("normalizeSegmentOrder", () => {
  it("defaults when undefined/empty", () => {
    expect(normalizeSegmentOrder()).toEqual([...DEFAULT_SEGMENT_ORDER])
    expect(normalizeSegmentOrder([])).toEqual([...DEFAULT_SEGMENT_ORDER])
  })
  it("drops unknown ids and dedupes, preserving order", () => {
    expect(normalizeSegmentOrder(["sid", "bogus", "quota", "sid"])).toEqual(["sid", "quota"])
  })
  it("falls back to default when all ids are invalid", () => {
    expect(normalizeSegmentOrder(["nope", "zzz"])).toEqual([...DEFAULT_SEGMENT_ORDER])
  })
})

describe("renderQuotaFooter — configurable segments", () => {
  it("default order is quota → context → model → sid", () => {
    const out = renderQuotaFooter(WINDOWS, TOKENS, { ...baseOpts, cols: 200 })!
    const o = order(out)
    expect(o.quota).toBeGreaterThanOrEqual(0)
    expect(o.quota).toBeLessThan(o.model)
    expect(o.model).toBeLessThan(o.sid)
  })

  it("honors a custom order (sid → model → quota)", () => {
    const out = renderQuotaFooter(WINDOWS, TOKENS, {
      ...baseOpts,
      cols: 200,
      segments: ["sid", "model", "quota"],
    })!
    const s = stripAnsi(out)
    expect(s.indexOf("b00e2d52")).toBeLessThan(s.indexOf("anth-4.8"))
    expect(s.indexOf("anth-4.8")).toBeLessThan(s.indexOf("5h"))
  })

  it("hides segments not listed (quota-only)", () => {
    const out = renderQuotaFooter(WINDOWS, TOKENS, {
      ...baseOpts,
      cols: 200,
      segments: ["quota"],
    })!
    const s = stripAnsi(out)
    expect(s).toContain("5h")
    expect(s).not.toContain("anth-4.8") // model hidden
    expect(s).not.toContain("b00e2d52") // sid hidden
  })

  it("a provider with no quota windows renders context-only (capability-adaptive)", () => {
    const out = renderQuotaFooter([], TOKENS, {
      contextWindow: 200_000,
      cols: 200,
      segments: ["quota", "context"],
    })!
    const s = stripAnsi(out)
    expect(s).not.toContain("5h") // no quota segment (no windows)
    expect(s).toContain("k") // context token count present
  })

  it("unknown ids in the list are ignored (lenient)", () => {
    const out = renderQuotaFooter(WINDOWS, TOKENS, {
      ...baseOpts,
      cols: 200,
      segments: ["quota", "typo", "sid"],
    })!
    const s = stripAnsi(out)
    expect(s).toContain("5h")
    expect(s).toContain("b00e2d52")
    expect(s).not.toContain("anth-4.8") // model not listed
  })
})

describe("renderQuotaFooter — host-reserved width (full-line budget)", () => {
  // The handler computes `cols: terminalCols - footerReservedWidth` before
  // calling the renderer. These tests pin the CONTRACT that makes the bars
  // shrink as soon as the whole painted line (slot content + host-appended
  // tail block) would stop fitting — not only when the bare line overflows.

  it("bars stay at max width when the bare line fits cols", () => {
    const wide = renderQuotaFooter(WINDOWS, TOKENS, { ...baseOpts, cols: 120 })!
    const s = stripAnsi(wide)
    // Full-width bar run present (8-cell quota bars).
    expect(s).toMatch(/5h [█▏▎▍▌▋▊▉░]{8}/)
  })

  it("bars shrink when the caller passes a reduced budget (reserved width)", () => {
    // Same data; only the budget differs. With a reservation of, say, 20
    // cells for a tps tail + LSP badge, a 100-col terminal behaves like an
    // 80-col one and the ladder must walk further down.
    const bare = renderQuotaFooter(WINDOWS, TOKENS, { ...baseOpts, cols: 100 })!
    const reserved = renderQuotaFooter(WINDOWS, TOKENS, {
      ...baseOpts,
      cols: 100 - 20,
    })!
    const sb = stripAnsi(bare)
    const sr = stripAnsi(reserved)
    // The reserved-budget line is strictly leaner.
    expect(sr.length).toBeLessThan(sb.length)
    // And both still respect their own budgets (Rule 3 invariant).
    expect(sb.length).toBeLessThanOrEqual(100)
    expect(sr.length).toBeLessThanOrEqual(80)
  })

  it("the reduced-budget line never exceeds its usable width at any reservation", () => {
    // Sweep reservations from 0 to 40 cells against a fixed terminal:
    // every rendered form must fit within (cols - reservation).
    for (let resv = 0; resv <= 40; resv += 5) {
      const out = stripAnsi(renderQuotaFooter(WINDOWS, TOKENS, { ...baseOpts, cols: 90 - resv })!)
      expect(out.length).toBeLessThanOrEqual(90 - resv)
    }
  })
})
