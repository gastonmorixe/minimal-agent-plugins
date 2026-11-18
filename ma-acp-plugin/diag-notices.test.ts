import { describe, expect, it } from "bun:test"

import { createDiagNoticer, DIAG_NOTICES, type DiagLike } from "./diag-notices.ts"

/** A `cache.break` diagnostic as the cache plugin writes it (notice level, 5). */
function brk(
  cause: string,
  actionable: boolean,
  streak: number,
  message = `cache broke: ${cause}`,
): DiagLike {
  return {
    code: "cache.break",
    message,
    severity: 5,
    data: { cause, actionable, streak, turn: 3, lost: 1000 },
  }
}

describe("createDiagNoticer", () => {
  it("drops a code that is not listed", () => {
    expect(createDiagNoticer().notice({ code: "events.sink-error", message: "x" })).toBeUndefined()
  })

  it("makes a warning notice for cache.anomaly, with a title for each anomaly code", () => {
    const n = createDiagNoticer()
    expect(
      n.notice({ code: "cache.anomaly", message: "m1", data: { code: "below_min_block_size" } }),
    ).toEqual({ severity: "warning", title: "Prompt too short to cache", description: "m1" })
    expect(n.notice({ code: "cache.anomaly", message: "m2", data: { code: "new_code" } })).toEqual({
      severity: "warning",
      title: "Prompt cache problem",
      description: "m2",
    })
  })

  it("sends each cache.anomaly code and sub-key one time (markers_ignored_cold)", () => {
    const n = createDiagNoticer()
    const d = { code: "cache.anomaly", message: "m", data: { code: "markers_ignored_cold" } }
    expect(n.notice(d)).toEqual({
      severity: "warning",
      title: "Prompt cache not used",
      description: "m",
    })
    expect(n.notice(d)).toBeUndefined()
    expect(createDiagNoticer().notice(d)).toBeDefined()
  })

  it("drops a cache.anomaly code that is also a cache.break", () => {
    const n = createDiagNoticer()
    for (const code of ["prefix_changed", "server_miss", "ttl_expired"]) {
      expect(
        n.notice({ code: "cache.anomaly", message: "m", severity: 4, data: { code } }),
      ).toBeUndefined()
    }
  })

  it("drops a diagnostic below warning severity for a one-time rule", () => {
    const n = createDiagNoticer()
    const info = { code: "cache.anomaly", message: "m", severity: 6, data: { code: "other" } }
    expect(n.notice(info)).toBeUndefined()
  })

  it("a ttl_expired cache.break at notice level gives an info notice", () => {
    expect(createDiagNoticer().notice(brk("ttl_expired", false, 1, "idle 63 min"))).toEqual({
      severity: "info",
      title: "Prompt cache expired",
      description: "idle 63 min",
    })
  })

  it("two prefix_changed breaks in one connection give two warning notices", () => {
    const n = createDiagNoticer()
    const a = n.notice(brk("prefix_changed", true, 1, "first"))
    const b = n.notice(brk("prefix_changed", true, 2, "second"))
    expect([a, b]).toEqual([
      { severity: "warning", title: "Prompt cache not read", description: "first" },
      { severity: "warning", title: "Prompt cache not read", description: "second" },
    ])
  })

  it("titles a cache.break by cause", () => {
    const n = createDiagNoticer()
    const title = (cause: string) => n.notice(brk(cause, true, 1))?.title
    expect(title("server_miss")).toBe("Prompt cache missed (server)")
    expect(title("thinking_lookback")).toBe("Prompt cache partly read")
    expect(title("thinking_older_entry")).toBe("Prompt cache partly read")
    expect(title("unknown")).toBe("Prompt cache not read")
    expect(title("new_cause")).toBe("Prompt cache not read")
  })

  it("a client without notices gets only actionable breaks that start a streak", () => {
    const n = createDiagNoticer()
    const fallback = { clientNotices: false }
    const sent = [
      brk("ttl_expired", false, 1),
      brk("prefix_changed", true, 1, "start"),
      brk("prefix_changed", true, 2),
      brk("server_miss", true, 3),
      brk("thinking_older_entry", false, 1),
      brk("server_miss", true, 1, "start again"),
    ]
      .map((d) => n.notice(d, fallback)?.description)
      .filter((x) => x !== undefined)
    expect(sent).toEqual(["start", "start again"])
    // A client with notices gets every break.
    expect(n.notice(brk("ttl_expired", false, 1), { clientNotices: true })).toBeDefined()
    expect(n.notice(brk("prefix_changed", true, 2), { clientNotices: true })).toBeDefined()
  })

  it("a client without notices gets an actionable break after a non-actionable one", () => {
    const n = createDiagNoticer()
    const fallback = { clientNotices: false }
    expect(n.notice(brk("ttl_expired", false, 1), fallback)).toBeUndefined()
    // The streak counts every cause, so this break has streak 2.
    expect(n.notice(brk("prefix_changed", true, 2, "changed"), fallback)?.description).toBe(
      "changed",
    )
  })

  it("a client without notices gets only the first of two actionable breaks in a row", () => {
    const n = createDiagNoticer()
    const fallback = { clientNotices: false }
    const sent = [brk("prefix_changed", true, 1, "a"), brk("prefix_changed", true, 2, "b")].map(
      (d) => n.notice(d, fallback)?.description,
    )
    expect(sent).toEqual(["a", undefined])
  })

  it("a client without notices gets both actionable breaks around a clean read", () => {
    const n = createDiagNoticer()
    const fallback = { clientNotices: false }
    // A clean read writes no diagnostic; the next break starts a new streak.
    const sent = [brk("server_miss", true, 1, "a"), brk("prefix_changed", true, 1, "b")].map(
      (d) => n.notice(d, fallback)?.description,
    )
    expect(sent).toEqual(["a", "b"])
  })

  it("a client without notices gets the first break of a connection even with streak > 1", () => {
    // For example a resumed session: its history already had breaks.
    const n = createDiagNoticer()
    const fallback = { clientNotices: false }
    const sent = [
      brk("prefix_changed", true, 4, "first"),
      brk("prefix_changed", true, 5, "second"),
    ].map((d) => n.notice(d, fallback)?.description)
    expect(sent).toEqual(["first", undefined])
  })

  it("a cache.break for a client with notices also moves the fallback state", () => {
    const n = createDiagNoticer()
    expect(n.notice(brk("ttl_expired", false, 1))).toBeDefined()
    expect(
      n.notice(brk("prefix_changed", true, 2, "after"), { clientNotices: false })?.description,
    ).toBe("after")
  })

  it("every rule gives a non-empty title", () => {
    for (const [code, rule] of Object.entries(DIAG_NOTICES)) {
      expect(rule.notice({ code, message: "m" }).title.length).toBeGreaterThan(0)
    }
  })
})
