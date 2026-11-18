import { describe, expect, it } from "bun:test"

import { createDiagNoticer, DIAG_NOTICES } from "./diag-notices.ts"

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

  it("sends each code and sub-key one time", () => {
    const n = createDiagNoticer()
    const d = { code: "cache.anomaly", message: "m", data: { code: "cache_evicted" } }
    expect(n.notice(d)).toBeDefined()
    expect(n.notice(d)).toBeUndefined()
    expect(createDiagNoticer().notice(d)).toBeDefined()
  })

  it("every rule gives a non-empty title", () => {
    for (const [code, rule] of Object.entries(DIAG_NOTICES)) {
      expect(rule.notice({ code, message: "m" }).title.length).toBeGreaterThan(0)
    }
  })
})
