/**
 * Load-contract: the sub-agents manifest declares the surface the host loader
 * wires, and the env-gated handlers behave correctly. This is the repo-portable
 * counterpart to a host loader-integration test (the decoupling contract): it
 * asserts the plugin's OWN contract — its manifest shape, its tool-availability
 * gate, its system-prompt body, its validation — without importing host code.
 * The host's loader-discovery wiring is covered by the host's own
 * loader-contract tests.
 *
 * @module sub-agents/load.test
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import reportResultHandler, {
  available as reportResultAvailable,
} from "./handlers/report_result.ts"
import spawnHandler from "./handlers/spawn_agent.ts"
import type { ToolAvailabilityContext } from "./lib/host-types.ts"
import { ENV_RESULT_PATH } from "./lib/spawn.ts"

interface Manifest {
  headless: {
    tools: {
      id: string
      trigger: { tool?: { name?: string } }
      handler: { path: string }
    }[]
    hooks?: { id: string; channel?: string }[]
  }
  ui?: { liveAreaSlots?: { id: string; refreshMs?: number }[] }
  permissions?: string[]
}

const RAW = JSON.parse(readFileSync(join(import.meta.dir, "manifest.json"), "utf-8")) as Manifest
/** Flat view of the split manifest (S31): headless tools and hooks, ui slots. */
const MANIFEST = {
  tuis: RAW.headless.tools,
  hooks: RAW.headless.hooks,
  liveAreaSlots: RAW.ui?.liveAreaSlots,
  permissions: RAW.permissions,
}

function toolNames(): string[] {
  return MANIFEST.tuis.map((t) => t.trigger.tool?.name).filter((n): n is string => Boolean(n))
}

/** A minimal ToolAvailabilityContext: only `env` matters for the gate. */
function availCtx(env: Record<string, string>): ToolAvailabilityContext {
  return { env } as unknown as ToolAvailabilityContext
}

describe("sub-agents manifest contract", () => {
  it("declares the lead-facing sub-agent tools", () => {
    const names = toolNames()
    expect(names).toContain("SpawnAgent")
    expect(names).toContain("ListAgents")
    expect(names).toContain("AgentStatus")
    expect(names).toContain("AgentResult")
    expect(names).toContain("AgentOutput")
    expect(names).toContain("Mailbox")
    expect(names).toContain("StopAgent")
    // ReportResult is declared too (advertised only inside a worker, see below).
    expect(names).toContain("ReportResult")
  })

  it("registers the supervisor live-area slot at 1s", () => {
    const slot = MANIFEST.liveAreaSlots?.find((s) => s.id === "fleet_supervisor")
    expect(slot).toBeDefined()
    expect(slot?.refreshMs).toBe(1000)
  })

  it("registers agent.willStop to reap the fleet on lead exit", () => {
    const hook = MANIFEST.hooks?.find((h) => h.channel === "agent.willStop")
    expect(hook?.id).toBe("on_agent_will_stop")
    expect(MANIFEST.permissions).toContain("hooks:agent.willStop")
  })

  it("registers agent.didStart to start the worker lead watch", () => {
    const hook = MANIFEST.hooks?.find((h) => h.channel === "agent.didStart")
    expect(hook?.id).toBe("on_agent_did_start")
    expect(MANIFEST.permissions).toContain("hooks:agent.didStart")
  })

  it("contributes a system-prompt block mentioning SpawnAgent", () => {
    const prompt = readFileSync(join(import.meta.dir, "PROMPT.md"), "utf-8")
    expect(prompt).toContain("SpawnAgent")
  })

  it("does NOT advertise a universal low|medium|high effort menu on SpawnAgent", () => {
    // Carlos bug: listing (low|medium|high|xhigh|max) taught leads to pass
    // effort=low on models that only accept medium|high|max. Schema must not
    // invent a cross-model menu.
    const raw = readFileSync(join(import.meta.dir, "manifest.json"), "utf-8")
    expect(raw).not.toMatch(/low\|medium\|high\|xhigh\|max/)
    expect(raw).not.toMatch(/\(low\|medium\|high/)
    const effortDesc = raw.match(/"effort"\s*:\s*\{[^}]*"description"\s*:\s*"([^"]+)"/)
    expect(effortDesc?.[1] ?? "").toMatch(/Omit|omit|default|ModelInfo|actually accepts/i)
  })
})

describe("ReportResult availability gate", () => {
  it("HIDES ReportResult from a lead (no result-path env)", () => {
    expect(reportResultAvailable(availCtx({}))).toBe(false)
  })

  it("ADVERTISES ReportResult inside a worker (result-path env present)", () => {
    expect(reportResultAvailable(availCtx({ [ENV_RESULT_PATH]: "/tmp/worker.result.json" }))).toBe(
      true,
    )
  })

  it("a lead-context ReportResult call explains there is nothing to report", async () => {
    const res = await reportResultHandler({
      trigger: { type: "tool", name: "ReportResult", input: { summary: "x" }, tool_use_id: "t1" },
      packageDir: "/tmp/pkg",
      cwd: process.cwd(),
      env: {},
      abort: new AbortController().signal,
      stdout: process.stdout,
      stdin: process.stdin,
      stderr: process.stderr,
      log: { info() {}, warn() {}, error() {}, debug() {} } as never,
    } as never)
    expect(res.kind).toBe("tool_result")
    if (res.kind === "tool_result") {
      expect(res.is_error).toBe(true)
      expect(res.content).toMatch(/not a sub-agent|nothing to report/i)
    }
  })
})

describe("SpawnAgent validation", () => {
  it("surfaces a validation error for a missing task", async () => {
    const res = await spawnHandler({
      trigger: { type: "tool", name: "SpawnAgent", input: {}, tool_use_id: "t1" },
      packageDir: "/tmp/pkg",
      cwd: process.cwd(),
      env: {},
      abort: new AbortController().signal,
      stdout: process.stdout,
      stdin: process.stdin,
      stderr: process.stderr,
      log: { info() {}, warn() {}, error() {}, debug() {} } as never,
    } as never)
    expect(res.kind).toBe("tool_result")
    if (res.kind === "tool_result") {
      expect(res.is_error).toBe(true)
      expect(res.content).toMatch(/task/i)
    }
  })
})

describe("budget warning contribution (Design A)", () => {
  const raw = RAW as unknown as {
    toolResultTransforms?: { id: string; entry: string }
    sideband?: {
      kind: string
      placement: string
      direction: string
      trust: string
      body: string
      attrs: Record<string, { type: string; values?: string[] }>
    }[]
  }

  it("declares the budget sideband kind with placement tool-result", () => {
    const kind = raw.sideband?.find((k) => k.kind === "budget")
    expect(kind).toBeDefined()
    expect(kind?.placement).toBe("tool-result")
    expect(kind?.direction).toBe("to-model")
    expect(kind?.trust).toBe("harness")
    expect(kind?.body).toBe("text")
    expect(Object.keys(kind?.attrs ?? {})).toEqual(["elapsed", "remaining", "turns-left", "level"])
    expect(kind?.attrs.level?.values).toEqual(["warn", "final"])
  })

  it("declares toolResultTransforms; the entry loads and is a factory", async () => {
    expect(raw.toolResultTransforms?.id).toBe("budget")
    const entry = raw.toolResultTransforms?.entry ?? ""
    const mod = (await import(join(import.meta.dir, entry))) as { default: unknown }
    expect(typeof mod.default).toBe("function")
  })
})
