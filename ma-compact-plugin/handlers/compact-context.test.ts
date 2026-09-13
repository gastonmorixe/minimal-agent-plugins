import { describe, expect, it } from "bun:test"

import compactContext from "../handlers/compact-context.ts"
import type { CompactRequestOpts, TUIContext } from "../lib/host-types.ts"

function toolCtx(input: Record<string, unknown>, host?: TUIContext["host"]): TUIContext {
  return {
    trigger: { type: "tool", name: "CompactContext", input, tool_use_id: "t1" },
    cwd: "/work",
    env: {},
    ...(host === undefined ? {} : { host }),
  }
}

describe("compactContext", () => {
  it("rejects a non-tool trigger", async () => {
    const r = await compactContext({
      trigger: { type: "inline_tag", name: "x", body: "y" },
      cwd: "/work",
      env: {},
    })
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("wrong trigger type")
  })

  it("errors when the compact sub-API is absent", async () => {
    const r = await compactContext(toolCtx({}))
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("context:compact")
  })

  it("rejects bad mode and bad tail", async () => {
    const host = { compact: { requestCompact: () => ({ queued: true }) } }
    const badMode = await compactContext(toolCtx({ mode: "sideways" }, host))
    expect(badMode.is_error).toBe(true)
    expect(badMode.content).toContain("`mode`")
    const badTail = await compactContext(toolCtx({ tail: -1 }, host))
    expect(badTail.is_error).toBe(true)
    expect(badTail.content).toContain("`tail`")
    const badReason = await compactContext(toolCtx({ reason: "exceeded" }, host))
    expect(badReason.is_error).toBe(true)
    expect(badReason.content).toContain("`reason`")
  })

  it("queues with defaults (local, tail 6, auto) and reports back", async () => {
    const seen: CompactRequestOpts[] = []
    const host = {
      compact: {
        requestCompact: (opts: CompactRequestOpts) => {
          seen.push(opts)
          return { queued: true }
        },
      },
    }
    const r = await compactContext(toolCtx({}, host))
    expect(r.is_error).toBeUndefined()
    expect(seen).toEqual([{ reason: "auto" }])
    expect(r.content).toContain("Compact queued")
    expect(r.content).toContain("mode: local")
    expect(r.content).toContain("tail: 6")
    expect(r.displayHeader).toContain("compact queued")
  })

  it("passes explicit mode/tail/focus/reason through", async () => {
    const seen: CompactRequestOpts[] = []
    const host = {
      compact: {
        requestCompact: (opts: CompactRequestOpts) => {
          seen.push(opts)
          return Promise.resolve({ queued: true })
        },
      },
    }
    const r = await compactContext(
      toolCtx({ mode: "tail", tail: 10, focus: "keep the API list", reason: "manual" }, host),
    )
    expect(r.is_error).toBeUndefined()
    expect(seen).toEqual([
      { reason: "manual", mode: "tail", keepTail: 10, focus: "keep the API list" },
    ])
    expect(r.content).toContain("Focus: keep the API list")
  })

  it("surfaces a host refusal as an error", async () => {
    const host = { compact: { requestCompact: () => ({ queued: false }) } }
    const r = await compactContext(toolCtx({}, host))
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("refused")
  })

  it("wraps a throwing host as an error", async () => {
    const host = {
      compact: {
        requestCompact: () => {
          throw new Error("mid-tool loop")
        },
      },
    }
    const r = await compactContext(toolCtx({}, host))
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("mid-tool loop")
  })
})
