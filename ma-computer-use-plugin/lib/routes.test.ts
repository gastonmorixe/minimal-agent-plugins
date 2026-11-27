import { describe, expect, test } from "bun:test"

import { isRoute, type PathContext, resolveOutputDir, validateToolInput } from "./routes.ts"

describe("isRoute", () => {
  test("accepts known routes", () => {
    expect(isRoute("snapshot")).toBe(true)
    expect(isRoute("mouse")).toBe(true)
    expect(isRoute("activate")).toBe(true)
  })
  test("rejects unknown routes", () => {
    expect(isRoute("nope")).toBe(false)
    expect(isRoute("")).toBe(false)
  })
})

describe("validateToolInput", () => {
  test("rejects non-objects and missing action", () => {
    expect(validateToolInput(null).ok).toBe(false)
    expect(validateToolInput({}).ok).toBe(false)
    expect(validateToolInput({ action: 1 }).ok).toBe(false)
    expect(validateToolInput({ action: "bogus" }).ok).toBe(false)
  })

  test("ping needs nothing", () => {
    const r = validateToolInput({ action: "ping" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.route).toBe("ping")
  })

  test("strips action, forwards the rest as body", () => {
    const r = validateToolInput({
      action: "snapshot",
      bundleId: "com.apple.TextEdit",
      maxNodes: 50,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.route).toBe("snapshot")
      expect(r.body).toEqual({ bundleId: "com.apple.TextEdit", maxNodes: 50 })
      expect("action" in r.body).toBe(false)
    }
  })

  test("drops null/undefined values from the body", () => {
    const r = validateToolInput({ action: "snapshot", bundleId: null, pid: undefined })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.body).toEqual({})
  })

  test("elementAtPoint requires numeric x,y", () => {
    expect(validateToolInput({ action: "elementAtPoint" }).ok).toBe(false)
    expect(validateToolInput({ action: "elementAtPoint", x: 10, y: "z" }).ok).toBe(false)
    expect(validateToolInput({ action: "elementAtPoint", x: 10, y: 20 }).ok).toBe(true)
  })

  test("perform requires el and axAction", () => {
    expect(validateToolInput({ action: "perform", el: "e1" }).ok).toBe(false)
    expect(validateToolInput({ action: "perform", axAction: "AXPress" }).ok).toBe(false)
    expect(validateToolInput({ action: "perform", el: "e1", axAction: "AXPress" }).ok).toBe(true)
  })

  test("setValue requires el and a present value (including empty string)", () => {
    expect(validateToolInput({ action: "setValue", el: "e1" }).ok).toBe(false)
    expect(validateToolInput({ action: "setValue", el: "e1", value: "" }).ok).toBe(true)
    expect(validateToolInput({ action: "setValue", el: "e1", value: 0 }).ok).toBe(true)
  })

  test("type requires a string text (empty allowed)", () => {
    expect(validateToolInput({ action: "type" }).ok).toBe(false)
    expect(validateToolInput({ action: "type", text: "" }).ok).toBe(true)
    expect(validateToolInput({ action: "type", text: "hi" }).ok).toBe(true)
  })

  test("key needs combo or key", () => {
    expect(validateToolInput({ action: "key" }).ok).toBe(false)
    expect(validateToolInput({ action: "key", combo: "cmd+c" }).ok).toBe(true)
    expect(validateToolInput({ action: "keypress", key: "return" }).ok).toBe(true)
  })

  test("mouse op coordinate requirements", () => {
    expect(validateToolInput({ action: "mouse", op: "click" }).ok).toBe(false)
    expect(validateToolInput({ action: "mouse", op: "click", x: 1, y: 2 }).ok).toBe(true)
    expect(validateToolInput({ action: "mouse", op: "drag", x: 1, y: 2 }).ok).toBe(false)
    expect(validateToolInput({ action: "mouse", op: "drag", x: 1, y: 2, toX: 3, toY: 4 }).ok).toBe(
      true,
    )
    // scroll doesn't require x,y
    expect(validateToolInput({ action: "mouse", op: "scroll", dy: -3 }).ok).toBe(true)
  })
})

/** The error text of an input that must fail. */
function errorOf(input: Record<string, unknown>): string {
  const r = validateToolInput(input)
  expect(r.ok).toBe(false)
  return r.ok ? "" : r.error
}

describe("targets", () => {
  test("is a known route and needs no input", () => {
    expect(isRoute("targets")).toBe(true)
    const r = validateToolInput({ action: "targets" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.route).toBe("targets")
  })
  test("forwards the filters", () => {
    const r = validateToolInput({
      action: "targets",
      bundleId: "com.apple.TextEdit",
      title: "notes",
      visibleOnly: false,
      limit: 10,
    })
    expect(r.ok).toBe(true)
    if (r.ok)
      expect(r.body).toEqual({
        bundleId: "com.apple.TextEdit",
        title: "notes",
        visibleOnly: false,
        limit: 10,
      })
  })
  test("rejects a bad limit or pid", () => {
    expect(errorOf({ action: "targets", limit: 0 })).toContain("limit")
    expect(errorOf({ action: "targets", limit: "5" })).toContain("limit")
    expect(errorOf({ action: "targets", pid: "812" })).toContain("pid")
  })
})

describe("screenshot validation", () => {
  test("screen is the default and needs no target", () => {
    expect(validateToolInput({ action: "screenshot" }).ok).toBe(true)
    expect(validateToolInput({ action: "screenshot", mode: "screen", display: 1 }).ok).toBe(true)
    expect(validateToolInput({ action: "screenshot", displayId: 69734208 }).ok).toBe(true)
  })
  test("an unknown mode fails and names the known modes", () => {
    const e = errorOf({ action: "screenshot", mode: "region" })
    expect(e).toContain("'region'")
    expect(e).toContain("screen, area, window, app")
    expect(errorOf({ action: "screenshot", mode: 3 })).toContain("not known")
  })
  test("area needs all of x, y, w and h as numbers", () => {
    const e = errorOf({ action: "screenshot", mode: "area", x: 0, y: 0 })
    expect(e).toContain("Missing: w, h")
    expect(errorOf({ action: "screenshot", mode: "area", x: 0, y: "1", w: 9, h: 9 })).toContain(
      "Missing: y",
    )
    expect(
      validateToolInput({ action: "screenshot", mode: "area", x: 10, y: 20, w: 300, h: 200 }).ok,
    ).toBe(true)
  })
  test("area needs w and h above 0, with a targets hint", () => {
    const e = errorOf({ action: "screenshot", mode: "area", x: 0, y: 0, w: 0, h: 10 })
    expect(e).toContain("more than 0")
    expect(e).toContain("`targets`")
    expect(errorOf({ action: "screenshot", mode: "area", x: 0, y: 0, w: 10, h: -1 })).toContain(
      "more than 0",
    )
  })
  test("window needs windowId, el, pid or bundleId", () => {
    const e = errorOf({ action: "screenshot", mode: "window" })
    expect(e).toContain("windowId, el, pid or bundleId")
    expect(e).toContain("`targets`")
    // A title alone is not a target.
    expect(errorOf({ action: "screenshot", mode: "window", title: "Notes" })).toContain("windowId")
    for (const target of [
      { windowId: 4711 },
      { el: "e3" },
      { pid: 812 },
      { bundleId: "com.apple.TextEdit", title: "notes" },
    ])
      expect(validateToolInput({ action: "screenshot", mode: "window", ...target }).ok).toBe(true)
  })
  test("window rejects a windowId that is not a number", () => {
    expect(errorOf({ action: "screenshot", mode: "window", windowId: "4711" })).toContain(
      "windowId must be an integer",
    )
  })
  test("app needs pid or bundleId", () => {
    expect(errorOf({ action: "screenshot", mode: "app" })).toContain("pid or bundleId")
    expect(errorOf({ action: "screenshot", mode: "app", windowId: 4711 })).toContain(
      "pid or bundleId",
    )
    expect(validateToolInput({ action: "screenshot", mode: "app", pid: 812 }).ok).toBe(true)
    expect(
      validateToolInput({ action: "screenshot", mode: "app", bundleId: "com.apple.finder" }).ok,
    ).toBe(true)
  })
  test("maxSize must be a number of 64 or more", () => {
    expect(errorOf({ action: "screenshot", maxSize: 63 })).toContain("64 or more")
    expect(errorOf({ action: "screenshot", maxSize: 15 })).toContain("maxSize")
    expect(errorOf({ action: "screenshot", maxSize: "800" })).toContain("maxSize")
    expect(validateToolInput({ action: "screenshot", maxSize: 64 }).ok).toBe(true)
    expect(validateToolInput({ action: "screenshot", maxSize: 800, cursor: false }).ok).toBe(true)
  })
  test("display and displayId must be numbers", () => {
    expect(errorOf({ action: "screenshot", display: "0" })).toContain("display must be")
    expect(errorOf({ action: "screenshot", displayId: "1" })).toContain("displayId must be")
  })
  test("forwards every screenshot field to the daemon", () => {
    const r = validateToolInput({
      action: "screenshot",
      mode: "window",
      windowId: 4711,
      maxSize: 800,
      cursor: true,
      format: "path",
      outputDir: "/x",
    })
    expect(r.ok).toBe(true)
    if (r.ok)
      expect(r.body).toEqual({
        mode: "window",
        windowId: 4711,
        maxSize: 800,
        cursor: true,
        format: "path",
        outputDir: "/x",
      })
  })
})

describe("integer ids and sizes (review R3, R10)", () => {
  test("pid is an integer from 1 to 2^31-1 for each action", () => {
    for (const action of ["screenshot", "targets", "windows", "snapshot", "find"]) {
      for (const pid of [1e10, 2 ** 31, 0, -1, 812.5])
        expect(errorOf({ action, mode: "app", pid })).toContain("pid must be an integer")
      expect(validateToolInput({ action, mode: "app", pid: 2 ** 31 - 1 }).ok).toBe(true)
    }
    expect(validateToolInput({ action: "screenshot", mode: "app", pid: 1 }).ok).toBe(true)
  })
  test("windowId is an integer from 1 to 2^32-1", () => {
    for (const windowId of [4711.9, 0, -3, 2 ** 32])
      expect(errorOf({ action: "screenshot", mode: "window", windowId })).toContain(
        "windowId must be an integer",
      )
    expect(
      validateToolInput({ action: "screenshot", mode: "window", windowId: 2 ** 32 - 1 }).ok,
    ).toBe(true)
  })
  test("displayId is an integer from 0 to 2^32-1", () => {
    for (const displayId of [1.5, -1, 2 ** 32])
      expect(errorOf({ action: "screenshot", displayId })).toContain("displayId must be an integer")
    expect(validateToolInput({ action: "screenshot", displayId: 0 }).ok).toBe(true)
    expect(validateToolInput({ action: "screenshot", displayId: 2 ** 32 - 1 }).ok).toBe(true)
  })
  test("display is an integer, 0 or more", () => {
    for (const display of [0.5, -1])
      expect(errorOf({ action: "screenshot", display })).toContain("display must be an integer")
    expect(validateToolInput({ action: "screenshot", display: 0 }).ok).toBe(true)
    expect(validateToolInput({ action: "screenshot", display: 2 }).ok).toBe(true)
  })
  test("maxSize and limit are integers", () => {
    expect(errorOf({ action: "screenshot", maxSize: 64.5 })).toContain("maxSize must be an integer")
    expect(errorOf({ action: "targets", limit: 2.5 })).toContain("limit must be an integer")
    expect(validateToolInput({ action: "targets", limit: 1 }).ok).toBe(true)
  })
})

describe("outputDir (review R6)", () => {
  const paths = { cwd: "/work/repo", home: "/Users/me" }
  const dirOf = (outputDir: string, p: PathContext = paths): unknown => {
    const r = validateToolInput({ action: "screenshot", outputDir }, p)
    expect(r.ok).toBe(true)
    return r.ok ? r.body.outputDir : undefined
  }
  test("a relative path resolves against the agent cwd", () => {
    expect(dirOf("shots")).toBe("/work/repo/shots")
    expect(dirOf("./a/../b")).toBe("/work/repo/b")
    expect(dirOf("../up")).toBe("/work/up")
  })
  test("a ~/ prefix expands with the home directory", () => {
    expect(dirOf("~/Desktop")).toBe("/Users/me/Desktop")
    expect(dirOf("~")).toBe("/Users/me")
    expect(dirOf("~/Library/Application Support/x")).toBe("/Users/me/Library/Application Support/x")
  })
  test("an absolute path stays", () => {
    expect(dirOf("/x")).toBe("/x")
    expect(dirOf("/x/y/")).toBe("/x/y")
  })
  test("a relative path with no cwd is an error", () => {
    const r = validateToolInput({ action: "screenshot", outputDir: "shots" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("relative")
    expect(resolveOutputDir("/abs").ok).toBe(true)
  })
  test("~user and an empty or non-string outputDir are errors", () => {
    expect(errorOf({ action: "screenshot", outputDir: "~other/x" })).toContain("not supported")
    expect(errorOf({ action: "screenshot", outputDir: "" })).toContain("outputDir")
    expect(errorOf({ action: "screenshot", outputDir: 5 })).toContain("outputDir")
  })
})
