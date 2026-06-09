import { describe, expect, test } from "bun:test"

import { isErrorBody, renderContent, summarize } from "./render.ts"

describe("isErrorBody", () => {
  test("status >= 400 is an error", () => {
    expect(isErrorBody(403, {})).toBe(true)
    expect(isErrorBody(409, { error: "stale" })).toBe(true)
  })
  test("error field is an error even at 200", () => {
    expect(isErrorBody(200, { error: "app not found" })).toBe(true)
  })
  test("clean 200 is not an error", () => {
    expect(isErrorBody(200, { ok: true })).toBe(false)
  })
})

describe("summarize", () => {
  test("ping shows perms", () => {
    const s = summarize("ping", { version: "0.1.0", perms: { ax: true, screen: true } })
    expect(s).toContain("v0.1.0")
    expect(s).toContain("ax:true")
  })
  test("snapshot reports node count + truncation", () => {
    expect(summarize("snapshot", { nodeCount: 22, truncated: false, snapshotId: "s1" })).toContain(
      "22 node",
    )
    expect(summarize("snapshot", { nodeCount: 2000, truncated: true })).toContain("truncated")
  })
  test("find reports match count", () => {
    expect(summarize("find", { count: 3 })).toBe("3 match(es)")
  })
  test("screenshot reports geometry", () => {
    const s = summarize("screenshot", { path: "/x/y.png", width: 3024, height: 1964, scale: 2 })
    expect(s).toContain("3024×1964")
    expect(s).toContain("@2x")
  })
  test("error field surfaces in the summary", () => {
    expect(summarize("perform", { error: "stale handle e1" })).toContain("stale")
  })
})

describe("renderContent", () => {
  test("pretty-prints JSON", () => {
    expect(renderContent({ ok: true })).toBe('{\n  "ok": true\n}')
  })
  test("omits base64 blobs from readable content", () => {
    const out = renderContent({ base64: "x".repeat(5000), width: 100 })
    expect(out).not.toContain("xxxx")
    expect(out).toContain("base64 chars omitted")
  })
  test("truncates very large bodies", () => {
    const big = {
      elements: Array.from({ length: 5000 }, (_, i) => ({ el: `e${i}`, role: "AXButton" })),
    }
    const out = renderContent(big, 1000)
    expect(out.length).toBeLessThan(1300)
    expect(out).toContain("truncated")
  })
})
