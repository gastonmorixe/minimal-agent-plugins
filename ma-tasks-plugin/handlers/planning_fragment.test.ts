import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import type { ModelInfoSnapshot, PromptFragmentContext } from "../lib/host-types.ts"

import planningFragment from "./planning_fragment.ts"

const PKG_DIR = join(import.meta.dir, "..")

function snapshot(userDefined: boolean): ModelInfoSnapshot {
  return {
    modelId: "m",
    displayName: "M",
    providerId: "p",
    surfaceId: "s",
    contextWindow: 1,
    maxOutputTokens: 1,
    modalities: { image: false, audio: false, pdf: false, video: false },
    acceptedInput: {},
    thinking: {
      adaptive: false,
      extended: false,
      visible: false,
      interleaved: false,
    },
    effort: { levels: [], default: "" },
    caching: {
      explicit: false,
      automatic: false,
      ttls: [],
      reportsCacheHits: false,
    },
    tools: { userDefined, parallel: false },
    serverTools: [],
    pricing: {
      inputPerMTok: 0,
      outputPerMTok: 0,
      cacheWritePerMTok: 0,
      cacheReadPerMTok: 0,
    },
    resolved: true,
  }
}

function ctx(
  query?: () => ModelInfoSnapshot | undefined,
  env: Record<string, string> = {},
): PromptFragmentContext {
  return {
    packageDir: PKG_DIR,
    cwd: PKG_DIR,
    env,
    abort: new AbortController().signal,
    stderr: process.stderr,
    log: {
      debug() {},
      info() {},
      notice() {},
      warn() {},
      error() {},
    } as unknown as PromptFragmentContext["log"],
    agent: { sessionId: "s", pid: 1, model: "m", version: "0" },
    ...(query ? { queryModelInfo: query } : {}),
  }
}

describe("tasks planning fragment", () => {
  it("emits the phase-planning guidance when the model supports user-defined tools", () => {
    const out = planningFragment(ctx(() => snapshot(true)))
    expect(out).toMatch(/Plan non-trivial work in phases with `Task`/)
  })

  it("suppresses the guidance when the model lacks user-defined tool support", () => {
    const out = planningFragment(ctx(() => snapshot(false)))
    expect(out).toBe("")
  })

  it("emits when no model snapshot is available (defers to the loader gate)", () => {
    const out = planningFragment(ctx())
    expect(out).toMatch(/Plan non-trivial work in phases/)
  })

  it("reads the text from prompt markdown, not hardcoded literals", () => {
    const out = planningFragment(ctx(() => snapshot(true)))
    expect(out.length).toBeGreaterThan(0)
    expect(out).toBe(out.trim())
  })

  it("describes compact status results by default", () => {
    const out = planningFragment(ctx(() => snapshot(true)))
    expect(out).toContain("return a short plain `OK ...` acknowledgement")
    expect(out).toContain("next-turn `<ma::agent::tasks>` attachment")
    expect(out).not.toContain("Every successful mutation")
  })

  it("describes full status results when the session env enables them", () => {
    const out = planningFragment(
      ctx(() => snapshot(true), { MINIMAL_AGENT_TASKS_FULL_RESULTS: "1" }),
    )
    expect(out).toContain("Every successful mutation")
    expect(out).toContain("complete updated canonical-id board")
    expect(out).not.toContain("return a short plain `OK ...` acknowledgement")
  })
})
