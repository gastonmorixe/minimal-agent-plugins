import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import type { UiSetupContext } from "@minimal-agent/core/plugin-api/types/plugin"

import { TEST_TERMINAL_KIT } from "../../scripts/ui/test-terminal-kit.ts"
import setup from "../ui/setup.ts"

import { isErrorBody, renderContent, summarize } from "./render.ts"
import { slots } from "./style.ts"

// The display tests below check styled bytes: install the test kit (S41).
beforeAll(() => setup({ tui: { kit: TEST_TERMINAL_KIT } } as UiSetupContext))
afterAll(() => slots.reset())

describe("style slots (S41)", () => {
  test("ui/setup.ts installs the terminal kit; reset makes styles plain", () => {
    slots.reset()
    expect(slots.installed()).toBe(false)
    expect(slots.palette.red).toBe("")
    setup({ tui: { kit: TEST_TERMINAL_KIT } } as UiSetupContext)
    expect(slots.palette.red).toBe("\x1b[31m")
  })
})

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
  test("screenshot window shows the mode, id, title, size and path", () => {
    const s = summarize("screenshot", {
      mode: "window",
      windowId: 4711,
      title: "Notes.txt",
      path: "/x/shot.png",
      width: 1600,
      height: 1200,
      scale: 2,
      occluded: false,
    })
    expect(s).toBe('window 4711 "Notes.txt" 1600×1200 @2x · /x/shot.png')
  })
  test("screenshot window marks an occluded window", () => {
    const s = summarize("screenshot", {
      mode: "window",
      windowId: 7,
      title: "",
      path: "/x/a.png",
      width: 10,
      height: 10,
      scale: 1,
      occluded: true,
    })
    expect(s).toBe("window 7 occluded 10×10 @1x · /x/a.png")
  })
  test("screenshot app shows the app and the window count", () => {
    const s = summarize("screenshot", {
      mode: "app",
      pid: 400,
      bundleId: "com.apple.finder",
      windows: 3,
      path: "/x/b.png",
      width: 800,
      height: 500,
      scale: 0.5,
    })
    expect(s).toBe("app com.apple.finder (3 window(s)) 800×500 @0.5x · /x/b.png")
  })
  test("screenshot screen and area show the display, scale is rounded", () => {
    expect(
      summarize("screenshot", {
        mode: "area",
        display: 1,
        path: "/x/c.png",
        width: 800,
        height: 533,
        scale: 1.333333,
      }),
    ).toBe("area display 1 800×533 @1.33x · /x/c.png")
    expect(
      summarize("screenshot", { mode: "screen", display: 0, bytes: 99, width: 4, height: 2 }),
    ).toBe("screen display 0 4×2 · 99B base64")
  })
  test("screenshot with no mode keeps the old shape", () => {
    expect(summarize("screenshot", {})).toBe("captured")
    expect(summarize("screenshot", { mode: "window", windowId: 9 })).toBe("window 9 captured")
  })
  test("targets counts displays and windows", () => {
    expect(summarize("targets", { displays: [{}, {}], windows: new Array(14).fill({}) })).toBe(
      "2 display(s), 14 window(s)",
    )
    expect(summarize("targets", { displays: [{}], windows: [], truncated: true })).toBe(
      "1 display(s), 0 window(s) (truncated)",
    )
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
