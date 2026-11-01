import { describe, expect, it } from "bun:test"

import { createFakeRuntime } from "./__fixtures__/fake-runtime.ts"
import { buildConfigOptions, setConfigOption } from "./config-options.ts"
import { RpcError } from "./transport.ts"

function rpcCode(fn: () => unknown): number | undefined {
  try {
    fn()
  } catch (e) {
    return e instanceof RpcError ? e.code : -1
  }
  return undefined
}

describe("buildConfigOptions", () => {
  it("lists model then effort, with the current values", () => {
    const rt = createFakeRuntime({ model: "alpha", effort: "high" })
    const opts = buildConfigOptions(rt)
    expect(opts.map((o) => o.id)).toEqual(["model", "effort"])
    expect(opts[0]).toMatchObject({ category: "model", type: "select", currentValue: "alpha" })
    expect(opts[0]?.options.map((o) => o.value)).toEqual(["alpha", "beta", "gamma"])
    expect(opts[1]).toMatchObject({
      category: "thought_level",
      type: "select",
      currentValue: "high",
    })
    expect(opts[1]?.options.map((o) => o.value)).toEqual(["low", "medium", "high"])
  })

  it("reports the model default when effort is undefined", () => {
    const opts = buildConfigOptions(createFakeRuntime({ model: "gamma" }))
    expect(opts[1]?.currentValue).toBe("high")
  })

  it("omits the effort option when the model has no effort levels", () => {
    const opts = buildConfigOptions(createFakeRuntime({ model: "beta" }))
    expect(opts.map((o) => o.id)).toEqual(["model"])
  })

  it("keeps currentValue usable for a model the list does not show", () => {
    const rt = createFakeRuntime({ model: "custom-x" })
    const model = buildConfigOptions(rt)[0]
    expect(model?.options.some((o) => o.value === "custom-x")).toBe(true)
  })
})

describe("setConfigOption", () => {
  it("sets the model through the context setter and returns the complete list", () => {
    const rt = createFakeRuntime({ model: "alpha", effort: "low" })
    const opts = setConfigOption(rt, "model", "gamma")
    expect(rt.model).toBe("gamma")
    expect(opts.map((o) => o.id)).toEqual(["model", "effort"])
    expect(opts[0]?.currentValue).toBe("gamma")
    // gamma supports low: effort kept, options rebuilt for gamma.
    expect(opts[1]?.currentValue).toBe("low")
    expect(opts[1]?.options.map((o) => o.value)).toEqual(["low", "high"])
  })

  it("reports the reset effort after a model change that core reset", () => {
    const rt = createFakeRuntime({ model: "alpha", effort: "medium" })
    const opts = setConfigOption(rt, "model", "gamma")
    expect(rt.effort).toBeUndefined()
    expect(opts[1]?.currentValue).toBe("high") // gamma's default
  })

  it("drops the effort option after switching to a model with no levels", () => {
    const rt = createFakeRuntime({ model: "alpha", effort: "high" })
    const opts = setConfigOption(rt, "model", "beta")
    expect(opts.map((o) => o.id)).toEqual(["model"])
    expect(rt.effort).toBeUndefined()
  })

  it("does nothing for the current value: no setter call, the same list", () => {
    const rt = createFakeRuntime({ model: "alpha", effort: "low" })
    const before = buildConfigOptions(rt)
    let calls = 0
    const setModel = rt.setModel.bind(rt)
    rt.setModel = (id) => {
      calls += 1
      setModel(id)
    }
    expect(setConfigOption(rt, "model", "alpha")).toEqual(before)
    expect(calls).toBe(0)
  })

  it("sets effort", () => {
    const rt = createFakeRuntime({ model: "alpha" })
    const opts = setConfigOption(rt, "effort", "low")
    expect(rt.effort).toBe("low")
    expect(opts[1]?.currentValue).toBe("low")
  })

  it("rejects an unknown configId with -32602, state unchanged", () => {
    const rt = createFakeRuntime({ model: "alpha", effort: "low" })
    expect(rpcCode(() => setConfigOption(rt, "temperature", "1"))).toBe(-32602)
    expect([rt.model, rt.effort]).toEqual(["alpha", "low"])
  })

  it("rejects a value not in the list with -32602, state unchanged", () => {
    const rt = createFakeRuntime({ model: "alpha", effort: "low" })
    expect(rpcCode(() => setConfigOption(rt, "model", "other-provider-model"))).toBe(-32602)
    expect(rpcCode(() => setConfigOption(rt, "effort", "ultra"))).toBe(-32602)
    expect(rpcCode(() => setConfigOption(rt, "effort", true))).toBe(-32602)
    expect([rt.model, rt.effort]).toEqual(["alpha", "low"])
  })

  it("rejects effort when the model has no effort levels", () => {
    const rt = createFakeRuntime({ model: "beta" })
    expect(rpcCode(() => setConfigOption(rt, "effort", "low"))).toBe(-32602)
  })

  it("turns a throw from the core setter into -32602 and leaves state unchanged", () => {
    const rt = createFakeRuntime({ model: "alpha", effort: "low" })
    rt.setModel = () => {
      throw new Error("registry says no")
    }
    let err: unknown
    try {
      setConfigOption(rt, "model", "gamma")
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(RpcError)
    expect((err as RpcError).code).toBe(-32602)
    expect((err as RpcError).message).toContain("registry says no")
    expect([rt.model, rt.effort]).toEqual(["alpha", "low"])
  })
})
