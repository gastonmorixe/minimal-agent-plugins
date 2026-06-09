import { describe, expect, test } from "bun:test"

import { isRoute, validateToolInput } from "./routes.ts"

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
