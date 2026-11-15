import { describe, expect, it } from "bun:test"

import type { HostTargetView } from "@minimal-agent/core/host-kit/host-mode"

import {
  createFakeRuntime,
  FAKE_MODELS as FAKE_TABLE,
  type FakeRuntime,
} from "./__fixtures__/fake-runtime.ts"
import { buildConfigOptions, providerValue, setConfigOption } from "./config-options.ts"
import { RpcError } from "./transport.ts"

async function rpcCode(fn: () => unknown): Promise<number | undefined> {
  try {
    await fn()
  } catch (e) {
    return e instanceof RpcError ? e.code : -1
  }
  return undefined
}

describe("buildConfigOptions", () => {
  it("lists model then effort, with the current values", async () => {
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

  it("reports the model default when effort is undefined", async () => {
    const opts = buildConfigOptions(createFakeRuntime({ model: "gamma" }))
    expect(opts[1]?.currentValue).toBe("high")
  })

  it("omits the effort option when the model has no effort levels", async () => {
    const opts = buildConfigOptions(createFakeRuntime({ model: "beta" }))
    expect(opts.map((o) => o.id)).toEqual(["model"])
  })

  it("keeps currentValue usable for a model the list does not show", async () => {
    const rt = createFakeRuntime({ model: "custom-x" })
    const model = buildConfigOptions(rt)[0]
    expect(model?.options.some((o) => o.value === "custom-x")).toBe(true)
  })
})

describe("setConfigOption", () => {
  it("sets the model through the context setter and returns the complete list", async () => {
    const rt = createFakeRuntime({ model: "alpha", effort: "low" })
    const opts = await setConfigOption(rt, "model", "gamma")
    expect(rt.model).toBe("gamma")
    expect(opts.map((o) => o.id)).toEqual(["model", "effort"])
    expect(opts[0]?.currentValue).toBe("gamma")
    // gamma supports low: effort kept, options rebuilt for gamma.
    expect(opts[1]?.currentValue).toBe("low")
    expect(opts[1]?.options.map((o) => o.value)).toEqual(["low", "high"])
  })

  it("reports the reset effort after a model change that core reset", async () => {
    const rt = createFakeRuntime({ model: "alpha", effort: "medium" })
    const opts = await setConfigOption(rt, "model", "gamma")
    expect(rt.effort).toBeUndefined()
    expect(opts[1]?.currentValue).toBe("high") // gamma's default
  })

  it("drops the effort option after switching to a model with no levels", async () => {
    const rt = createFakeRuntime({ model: "alpha", effort: "high" })
    const opts = await setConfigOption(rt, "model", "beta")
    expect(opts.map((o) => o.id)).toEqual(["model"])
    expect(rt.effort).toBeUndefined()
  })

  it("does nothing for the current value: no setter call, the same list", async () => {
    const rt = createFakeRuntime({ model: "alpha", effort: "low" })
    const before = buildConfigOptions(rt)
    let calls = 0
    const setModel = rt.setModel.bind(rt)
    rt.setModel = (id) => {
      calls += 1
      setModel(id)
    }
    expect(await setConfigOption(rt, "model", "alpha")).toEqual(before)
    expect(calls).toBe(0)
  })

  it("sets effort", async () => {
    const rt = createFakeRuntime({ model: "alpha" })
    const opts = await setConfigOption(rt, "effort", "low")
    expect(rt.effort).toBe("low")
    expect(opts[1]?.currentValue).toBe("low")
  })

  it("rejects an unknown configId with -32602, state unchanged", async () => {
    const rt = createFakeRuntime({ model: "alpha", effort: "low" })
    expect(await rpcCode(() => setConfigOption(rt, "temperature", "1"))).toBe(-32602)
    expect([rt.model, rt.effort]).toEqual(["alpha", "low"])
  })

  it("rejects a value not in the list with -32602, state unchanged", async () => {
    const rt = createFakeRuntime({ model: "alpha", effort: "low" })
    expect(await rpcCode(() => setConfigOption(rt, "model", "other-provider-model"))).toBe(-32602)
    expect(await rpcCode(() => setConfigOption(rt, "effort", "ultra"))).toBe(-32602)
    expect(await rpcCode(() => setConfigOption(rt, "effort", true))).toBe(-32602)
    expect([rt.model, rt.effort]).toEqual(["alpha", "low"])
  })

  it("rejects effort when the model has no effort levels", async () => {
    const rt = createFakeRuntime({ model: "beta" })
    expect(await rpcCode(() => setConfigOption(rt, "effort", "low"))).toBe(-32602)
  })

  it("turns a throw from the core setter into -32602 and leaves state unchanged", async () => {
    const rt = createFakeRuntime({ model: "alpha", effort: "low" })
    rt.setModel = () => {
      throw new Error("registry says no")
    }
    let err: unknown
    try {
      await setConfigOption(rt, "model", "gamma")
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(RpcError)
    expect((err as RpcError).code).toBe(-32602)
    expect((err as RpcError).message).toContain("registry says no")
    expect([rt.model, rt.effort]).toEqual(["alpha", "low"])
  })
})

/** Second provider's models for the target tests (`delta` only). */
const OTHER_MODELS: Record<string, string[]> = {
  anthropic: ["alpha", "beta", "gamma"],
  other: ["delta"],
}

/**
 * Adds the optional target members to a fake runtime. `listModels` follows
 * the live provider, and a provider change resets the model to that
 * provider's first model when the current one is not registered there.
 */
function withTargets(rt: FakeRuntime, rows: HostTargetView[]) {
  const state = {
    providerId: "anthropic" as string,
    credentialName: "me@example.com" as string | undefined,
  }
  const calls: Array<{ providerId: string; credentialName?: string }> = []
  const baseList = rt.listModels
  const runtime = Object.assign(rt, {
    calls,
    state,
    listModels: () =>
      baseList().filter((m) => OTHER_MODELS[state.providerId]?.includes(m.id) ?? false),
    listTargets: () => rows,
    getTarget: () => ({ ...state }),
    async setTarget(t: { providerId: string; credentialName?: string }): Promise<void> {
      calls.push(t)
      state.providerId = t.providerId
      state.credentialName = t.credentialName
      const models = OTHER_MODELS[t.providerId] ?? []
      if (!models.includes(rt.model)) rt.setModel(models[0] ?? "")
    },
  })
  return runtime
}

const ROWS: HostTargetView[] = [
  {
    providerId: "anthropic",
    credentialName: "me@example.com",
    label: "Anthropic · me@example.com",
  },
  { providerId: "other", label: "Other" },
]

const DELTA = { id: "delta", label: "Delta", contextWindow: 1000, levels: [], defaultEffort: "low" }

describe("provider config option", () => {
  it("is absent when the host has no target members (older host)", () => {
    const opts = buildConfigOptions(createFakeRuntime({ model: "alpha" }))
    expect(opts.map((o) => o.id)).toEqual(["model", "effort"])
  })

  it("is absent when listTargets returns no rows", () => {
    const rt = withTargets(createFakeRuntime({ model: "alpha" }), [])
    expect(buildConfigOptions(rt).map((o) => o.id)).toEqual(["model", "effort"])
  })

  it("comes first, with hashed values and the credential only in the label", () => {
    const rt = withTargets(createFakeRuntime({ model: "alpha" }), ROWS)
    const opts = buildConfigOptions(rt)
    expect(opts.map((o) => o.id)).toEqual(["provider", "model", "effort"])
    const provider = opts[0]
    expect(provider).toMatchObject({ category: "_provider", type: "select", name: "Provider" })
    const values = provider?.options.map((o) => o.value) ?? []
    expect(values[0]).toMatch(/^anthropic:c-[0-9a-f]{10}$/)
    expect(values[1]).toBe("other")
    expect(values.some((v) => v.includes("@"))).toBe(false)
    expect(provider?.currentValue).toBe(values[0])
    expect(provider?.options[0]?.name).toBe("Anthropic · me@example.com")
    expect(providerValue("anthropic", "me@example.com")).toBe(values[0])
  })

  it("set provider calls setTarget and returns the rebuilt model list", async () => {
    const rt = withTargets(createFakeRuntime({ model: "alpha" }, [...FAKE_TABLE, DELTA]), ROWS)
    const opts = await setConfigOption(rt, "provider", "other")
    expect(rt.calls).toEqual([{ providerId: "other" }])
    expect(opts.map((o) => o.id)).toEqual(["provider", "model"])
    expect(opts[0]?.currentValue).toBe("other")
    expect(opts[1]?.currentValue).toBe("delta")
    expect(opts[1]?.options.map((o) => o.value)).toEqual(["delta"])
  })

  it("same value is a no-op with no setTarget call", async () => {
    const rt = withTargets(createFakeRuntime({ model: "alpha" }), ROWS)
    const before = buildConfigOptions(rt)
    const current = before[0]?.currentValue
    expect(await setConfigOption(rt, "provider", current)).toEqual(before)
    expect(rt.calls).toHaveLength(0)
  })

  it("rejects an unknown value (and a raw credential name) with -32602", async () => {
    const rt = withTargets(createFakeRuntime({ model: "alpha" }), ROWS)
    expect(await rpcCode(() => setConfigOption(rt, "provider", "nope"))).toBe(-32602)
    expect(await rpcCode(() => setConfigOption(rt, "provider", "anthropic:me@example.com"))).toBe(
      -32602,
    )
    expect(rt.calls).toHaveLength(0)
  })

  it("turns a setTarget throw into -32602 with state unchanged", async () => {
    const rt = withTargets(createFakeRuntime({ model: "alpha", effort: "low" }), ROWS)
    rt.setTarget = async () => {
      throw new Error("no credentials for other")
    }
    const before = buildConfigOptions(rt)
    let err: unknown
    try {
      await setConfigOption(rt, "provider", "other")
    } catch (e) {
      err = e
    }
    expect((err as RpcError).code).toBe(-32602)
    expect((err as RpcError).message).toContain("no credentials for other")
    expect(buildConfigOptions(rt)).toEqual(before)
  })
})
