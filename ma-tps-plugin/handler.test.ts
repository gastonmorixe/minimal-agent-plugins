import { describe, expect, it } from "bun:test"

import handle from "./handler.ts"
import type { LiveAreaHandlerContext } from "./host-types.ts"
import { tracker } from "./tracker-holder.ts"

/**
 * Contract test: the handler ALWAYS returns null and renders exclusively
 * through setFooterTail. Returning a string would paint a second footer
 * row AND double-render the tail (see DESIGN.md).
 */
describe("tps handler contract", () => {
  it("always returns null and publishes the tail", async () => {
    tracker.reset()
    // Seed one delta so the tracker has state.
    tracker.sample(performance.now(), 50)
    const published: string[] = []
    const ctx: LiveAreaHandlerContext = {
      abort: new AbortController().signal,
      setFooterTail: (text) => published.push(text),
    }
    const result = await handle(ctx)
    expect(result).toBeNull()
    expect(published.length).toBe(1)
  })

  it("publishes empty when the tracker is idle", async () => {
    tracker.reset()
    const published: string[] = []
    const ctx: LiveAreaHandlerContext = {
      abort: new AbortController().signal,
      setFooterTail: (text) => published.push(text),
    }
    const result = await handle(ctx)
    expect(result).toBeNull()
    expect(published).toEqual([""])
  })
})

describe("on_output_delta event handler", () => {
  it("feeds EventHandlerContext payloads (the loader's real call shape)", async () => {
    tracker.reset()
    const { default: onDelta } = await import("./on_output_delta.ts")
    // REGRESSION: the loader always calls `fn(ctx)`, never `fn(payload)`.
    // Reading `ctx.deltaTokens` (as if the bus payload were the first
    // argument) silently no-ops every production event.
    onDelta(eventCtx({ deltaTokens: 25 }))
    onDelta(eventCtx({ deltaTokens: 25 }))
    expect(tracker.read(performance.now()).active).toBe(true)
  })

  it("also accepts a raw {deltaTokens} payload", async () => {
    tracker.reset()
    const { default: onDelta } = await import("./on_output_delta.ts")
    onDelta({ deltaTokens: 25 })
    onDelta({ deltaTokens: 25 })
    expect(tracker.read(performance.now()).active).toBe(true)
  })

  it("ignores malformed payloads", async () => {
    tracker.reset()
    const { default: onDelta } = await import("./on_output_delta.ts")
    onDelta(undefined)
    onDelta("nope")
    onDelta({ nope: 1 })
    onDelta({ deltaTokens: "not-a-number" })
    onDelta(eventCtx(undefined))
    onDelta(eventCtx({ nope: 1 }))
    expect(tracker.read(performance.now()).active).toBe(false)
  })
})

describe("on_output_end event handler", () => {
  it("hides immediately on EventHandlerContext (loader call shape)", async () => {
    tracker.reset()
    const { default: onDelta } = await import("./on_output_delta.ts")
    const { default: onEnd } = await import("./on_output_end.ts")
    onDelta(eventCtx({ deltaTokens: 25 }, "llm.outputDelta"))
    onDelta(eventCtx({ deltaTokens: 25 }, "llm.outputDelta"))
    expect(tracker.read(performance.now()).active).toBe(true)
    onEnd(eventCtx({ reason: "stream_end" }, "llm.outputEnd"))
    expect(tracker.read(performance.now())).toEqual({ tps: 0, active: false })
    // Repeat is idempotent.
    onEnd(eventCtx({ reason: "stream_end" }, "llm.outputEnd"))
    expect(tracker.read(performance.now())).toEqual({ tps: 0, active: false })
  })

  it("slot handler publishes empty after outputEnd", async () => {
    tracker.reset()
    const { default: onDelta } = await import("./on_output_delta.ts")
    const { default: onEnd } = await import("./on_output_end.ts")
    onDelta(eventCtx({ deltaTokens: 25 }, "llm.outputDelta"))
    onDelta(eventCtx({ deltaTokens: 25 }, "llm.outputDelta"))
    onEnd(eventCtx({ reason: "stream_end" }, "llm.outputEnd"))
    const published: string[] = []
    const ctx: LiveAreaHandlerContext = {
      abort: new AbortController().signal,
      setFooterTail: (text) => published.push(text),
    }
    const result = await handle(ctx)
    expect(result).toBeNull()
    expect(published).toEqual([""])
  })
})

function eventCtx(payload: unknown, event = "llm.outputDelta") {
  return {
    event,
    payload,
    packageDir: "/tmp",
    cwd: "/tmp",
    env: {},
    emit: () => {},
    abort: new AbortController().signal,
    stderr: process.stderr,
  }
}
