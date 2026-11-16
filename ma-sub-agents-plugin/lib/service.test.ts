import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { renderFor } from "../../tests/support/prompt-render.ts"

import type { StartupProfile } from "./host-types.ts"
import {
  type ServiceDeps,
  spawnAgent,
  stopAgent,
  stopAllAgents,
  type WorkerDefinition,
} from "./service.ts"
import { ENV_EXPECT_ARTIFACTS, type SpawnDeps } from "./spawn.ts"
import { SubagentStore } from "./store.ts"
import { sessionId, subagentId } from "./types.ts"

const testRender = renderFor("ma-sub-agents-plugin", `${import.meta.dirname}/..`)

const LEAD = sessionId("11111111-1111-4111-8111-111111111111")
const FIXED_SID = "9c1a4f2e-0b3d-4a6c-8e1f-2d3c4b5a6978"

function makeDeps(
  dir: string,
  over: Partial<ServiceDeps> = {},
): ServiceDeps & { launched: string[][] } {
  const launched: string[][] = []
  const spawnDeps: SpawnDeps = {
    launch: (argv) => {
      launched.push([...argv])
      return 5000 + launched.length
    },
  }
  return {
    store: new SubagentStore(LEAD, { dir }),
    spawnDeps,
    agentBin: ["minimal-agent"],
    leadSid: LEAD,
    depth: 0,
    cwd: "/repo",
    sessionsDir: dir,
    defaultModel: "claude-sonnet-4-6",
    newSid: () => FIXED_SID,
    now: () => new Date("2026-05-30T12:00:00.000Z"),
    launched,
    renderPrompt: testRender,
    ...over,
  }
}

describe("spawnAgent", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "subagents-svc-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("passes expectArtifacts to the worker env as a resolved, deduped JSON array", async () => {
    const envs: Record<string, string>[] = []
    const deps = makeDeps(dir, {
      spawnDeps: {
        launch: (_argv, opts) => {
          envs.push(opts.env)
          return 7001
        },
      },
    })
    const r = await spawnAgent(
      { task: "write findings", expectArtifacts: ["/abs/x/../f.md", "/abs/f.md"] },
      deps,
    )
    expect(r.ok).toBe(true)
    expect(JSON.parse(envs[0]?.[ENV_EXPECT_ARTIFACTS] ?? "null")).toEqual(["/abs/f.md"])
    if (r.ok) expect(r.value.expectArtifacts).toEqual(["/abs/f.md"])
  })

  it("does not set the contract env when there is no expectArtifacts", async () => {
    const envs: Record<string, string>[] = []
    const deps = makeDeps(dir, {
      spawnDeps: {
        launch: (_argv, opts) => {
          envs.push(opts.env)
          return 7002
        },
      },
    })
    await spawnAgent({ task: "no files" }, deps)
    expect(ENV_EXPECT_ARTIFACTS in (envs[0] ?? {})).toBe(false)
  })

  it("rejects a relative expectArtifacts path with a teaching error, and launches nothing", async () => {
    const deps = makeDeps(dir)
    const r = await spawnAgent({ task: "x", expectArtifacts: ["research/f.md"] }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/absolute/)
    expect(deps.launched.length).toBe(0)
  })

  it("launches a worker, persists a running handle, returns it", async () => {
    const deps = makeDeps(dir)
    const r = await spawnAgent({ task: "refactor parser" }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.id).toBe(subagentId("A1"))
    expect(r.value.status.kind).toBe("running")
    if (r.value.status.kind === "running") expect(r.value.status.pid).toBe(5001)
    // lastPid survives ReportResult / terminal finalize so willStop can still reap.
    expect(r.value.lastPid).toBe(5001)
    expect(deps.store.get("A1")?.lastPid).toBe(5001)
    // persisted
    expect(deps.store.get("A1")?.sid).toBe(sessionId(FIXED_SID))
    // launched with the pinned sid + the task (now followed by the REQUIRED
    // deliverable protocol, so the prompt CONTAINS the task rather than equals it)
    expect(deps.launched[0]).toContain("--session-id")
    const prompt = deps.launched[0]?.at(-1) ?? ""
    expect(prompt).toContain("refactor parser")
    // the deliverable protocol tells the worker to hand back via ReportResult
    expect(prompt).toMatch(/ReportResult/)
    // and the manual-fallback path points at this worker's own result.json sentinel
    expect(prompt).toContain(".result.json")
  })

  it("rejects an empty task without launching", async () => {
    const deps = makeDeps(dir)
    const r = await spawnAgent({ task: "   " }, deps)
    expect(r.ok).toBe(false)
    expect(deps.launched).toHaveLength(0)
  })

  it("enforces the nesting ban from a worker (depth 1 → childDepth 2)", async () => {
    const deps = makeDeps(dir, { depth: 1 })
    const r = await spawnAgent({ task: "spawn a grandchild" }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/nesting/i)
    expect(deps.launched).toHaveLength(0)
  })

  it("resolves a named definition (model + system preamble)", async () => {
    const reviewer: WorkerDefinition = {
      name: "reviewer",
      model: "claude-opus-4-8",
      systemPrompt: "You are a strict reviewer.",
      isolation: "fresh",
    }
    const deps = makeDeps(dir, {
      resolveDefinition: (n) => (n === "reviewer" ? reviewer : undefined),
    })
    const r = await spawnAgent({ task: "review the diff", agent: "reviewer" }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.type).toBe("reviewer")
    expect(r.value.model).toBe("claude-opus-4-8")
    // the system preamble is folded into the launched prompt
    expect(deps.launched[0]?.at(-1)).toContain("You are a strict reviewer.")
  })

  it("inherits deps.defaultModel (the lead's model) when the request omits one", async () => {
    const deps = makeDeps(dir, { defaultModel: "gpt-5.5" })
    const r = await spawnAgent({ task: "inherit my model" }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.model).toBe("gpt-5.5")
    const argv = deps.launched[0] ?? []
    expect(argv[argv.indexOf("--model") + 1]).toBe("gpt-5.5")
  })

  it("passes --provider from resolveProvider when inheriting the lead model (Lisa/grok dual-id)", async () => {
    // Regression: bare `grok-4.5` is dual-registered (grok + opencode). The
    // host must pin the LEAD provider so the child does not last-write-win to
    // OpenCode Go and 401 on empty credits.
    const deps = makeDeps(dir, {
      defaultModel: "grok-4.5",
      resolveProvider: (modelId) => (modelId === "grok-4.5" ? "grok" : undefined),
    })
    const r = await spawnAgent({ task: "scan pii", agent: undefined }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.model).toBe("grok-4.5")
    const argv = deps.launched[0] ?? []
    expect(argv[argv.indexOf("--model") + 1]).toBe("grok-4.5")
    expect(argv).toContain("--provider")
    expect(argv[argv.indexOf("--provider") + 1]).toBe("grok")
  })

  it("omits --provider when resolveProvider returns undefined", async () => {
    const deps = makeDeps(dir, {
      defaultModel: "grok-4.5",
      resolveProvider: () => undefined,
    })
    const r = await spawnAgent({ task: "no provider known" }, deps)
    expect(r.ok).toBe(true)
    const argv = deps.launched[0] ?? []
    expect(argv).toContain("--model")
    expect(argv).not.toContain("--provider")
  })

  it("rejects unsupported effort before launch (Carlos/schema-vs-runtime)", async () => {
    // Manifest used to advertise low|medium|high|xhigh|max; leads then passed
    // effort=low on models that only accept medium|high|max and the child died
    // at boot. Refuse at the tool boundary with a teaching error instead.
    const deps = makeDeps(dir, {
      defaultModel: "grok-4.5",
      effortLevelsForModel: (id) => (id === "grok-4.5" ? ["medium", "high", "max"] : undefined),
    })
    const r = await spawnAgent({ task: "scan news", effort: "low" }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/effort "low"/i)
      expect(r.error).toMatch(/medium, high, max/)
      expect(r.error).toMatch(/Omit/)
    }
    expect(deps.launched).toHaveLength(0)
  })

  it("allows a supported effort and passes --effort through", async () => {
    const deps = makeDeps(dir, {
      defaultModel: "grok-4.5",
      effortLevelsForModel: () => ["medium", "high", "max"],
    })
    const r = await spawnAgent({ task: "scan news", effort: "medium" }, deps)
    expect(r.ok).toBe(true)
    const argv = deps.launched[0] ?? []
    expect(argv[argv.indexOf("--effort") + 1]).toBe("medium")
  })

  it("inherits lead effort when the worker model supports it", async () => {
    const deps = makeDeps(dir, {
      defaultModel: "gpt-5.6-sol",
      resolveProvider: () => "openai",
      leadProvider: "openai",
      defaultEffort: "high",
      effortLevelsForModel: () => ["none", "low", "medium", "high", "xhigh", "max"],
    })
    const r = await spawnAgent({ task: "inherit effort" }, deps)
    expect(r.ok).toBe(true)
    const argv = deps.launched[0] ?? []
    expect(argv[argv.indexOf("--effort") + 1]).toBe("high")
  })

  it("drops unsupported lead effort and still launches (Nathan xhigh→grok)", async () => {
    // Lead on OpenAI xhigh; retry worker on grok-4.5 which only accepts
    // medium|high|max. Must NOT fail the spawn — omit --effort + scrub env.
    const deps = makeDeps(dir, {
      defaultModel: "grok-4.5",
      resolveProvider: () => "grok",
      leadProvider: "openai",
      defaultEffort: "xhigh",
      effortLevelsForModel: (id) =>
        id === "grok-4.5" ? ["medium", "high", "max"] : ["none", "low", "medium", "high", "xhigh"],
    })
    const r = await spawnAgent({ task: "retry with grok", model: "grok-4.5" }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const argv = deps.launched[0] ?? []
    expect(argv).not.toContain("--effort")
    // Credential must NOT follow a cross-provider model pick.
    expect(argv).not.toContain("--credential-name")
  })

  it("passes lead --credential-name when worker reuses lead provider (Brittany)", async () => {
    // Lead: --provider openai --model gpt-5.6-sol --credential-name openai-chatgpt-oauth-2
    // Worker must keep the same credential or Codex rejects gpt-5.6-sol on the
    // default OAuth account.
    const deps = makeDeps(dir, {
      defaultModel: "gpt-5.6-sol",
      resolveProvider: (id) => (id === "gpt-5.6-sol" ? "openai" : undefined),
      leadProvider: "openai",
      defaultCredentialName: "openai-chatgpt-oauth-2",
      defaultEffort: "high",
      effortLevelsForModel: () => ["none", "low", "medium", "high", "xhigh", "max"],
    })
    const r = await spawnAgent({ task: "crossref docs" }, deps)
    expect(r.ok).toBe(true)
    const argv = deps.launched[0] ?? []
    expect(argv[argv.indexOf("--model") + 1]).toBe("gpt-5.6-sol")
    expect(argv[argv.indexOf("--provider") + 1]).toBe("openai")
    expect(argv[argv.indexOf("--credential-name") + 1]).toBe("openai-chatgpt-oauth-2")
    expect(argv[argv.indexOf("--effort") + 1]).toBe("high")
  })

  it("omits lead credential when worker switches provider", async () => {
    const deps = makeDeps(dir, {
      defaultModel: "gpt-5.6-sol",
      resolveProvider: (id) => (id === "grok-4.5" ? "grok" : "openai"),
      leadProvider: "openai",
      defaultCredentialName: "openai-chatgpt-oauth-2",
      defaultEffort: "high",
      effortLevelsForModel: (id) =>
        id === "grok-4.5" ? ["medium", "high", "max"] : ["high", "xhigh"],
    })
    const r = await spawnAgent({ task: "use grok", model: "grok-4.5" }, deps)
    expect(r.ok).toBe(true)
    const argv = deps.launched[0] ?? []
    expect(argv).not.toContain("--credential-name")
  })

  it("passes effort through when effort levels are unknown", async () => {
    // Forward-compatible: no levels wired → don't invent a veto.
    const deps = makeDeps(dir, { defaultModel: "grok-4.5" })
    const r = await spawnAgent({ task: "scan", effort: "ultra" }, deps)
    expect(r.ok).toBe(true)
    const argv = deps.launched[0] ?? []
    expect(argv[argv.indexOf("--effort") + 1]).toBe("ultra")
  })

  it("REGRESSION: refuses explicit effort when model has empty levels (Thomas/Adrian fleet)", async () => {
    // cursor-grok / no-effort models: leads (and LLMs filling optional tool
    // fields) often pass effort=medium. Empty levels means known-unsupported —
    // refuse at the tool boundary instead of launching a child that dies with
    // `effort "medium" was requested but this model does not support reasoning effort`.
    const deps = makeDeps(dir, {
      defaultModel: "cursor-grok-4.5-high-fast",
      effortLevelsForModel: () => [],
    })
    const r = await spawnAgent({ task: "scan resume path", effort: "medium" }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/effort "medium"/i)
      expect(r.error).toMatch(/does not support reasoning effort/i)
    }
    expect(deps.launched).toHaveLength(0)
  })

  it("REGRESSION: does not inherit lead effort when model has empty levels", async () => {
    const deps = makeDeps(dir, {
      defaultModel: "cursor-grok-4.5-high-fast",
      defaultEffort: "medium",
      effortLevelsForModel: () => [],
    })
    const r = await spawnAgent({ task: "inherit must scrub" }, deps)
    expect(r.ok).toBe(true)
    const argv = deps.launched[0] ?? []
    expect(argv).not.toContain("--effort")
  })

  it("REGRESSION: does not inherit lead effort when levels are unknown", async () => {
    // JSDoc contract: unsupported OR unknown → omit + scrub. The old branch
    // `!levels || levels.length === 0 || levels.includes(...)` inherited on
    // both unknown and empty, which killed no-effort workers at boot.
    const deps = makeDeps(dir, {
      defaultModel: "cursor-grok-4.5-high-fast",
      defaultEffort: "medium",
      // effortLevelsForModel omitted → unknown
    })
    const r = await spawnAgent({ task: "unknown levels must scrub" }, deps)
    expect(r.ok).toBe(true)
    const argv = deps.launched[0] ?? []
    expect(argv).not.toContain("--effort")
  })

  it("OMITS --model when no model is knowable (model-agnostic; child self-resolves)", async () => {
    const deps = makeDeps(dir, { defaultModel: "" })
    const r = await spawnAgent({ task: "no model anywhere" }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.model).toBe("")
    const argv = deps.launched[0] ?? []
    expect(argv).not.toContain("--model")
  })

  it("a per-spawn model overrides the inherited default", async () => {
    const deps = makeDeps(dir, { defaultModel: "gpt-5.5" })
    const r = await spawnAgent({ task: "override", model: "claude-opus-4-8" }, deps)
    expect(r.ok && r.value.model).toBe("claude-opus-4-8")
  })

  it("uses the provider's role recommendation for a role-bearing specialist (Phase G)", async () => {
    const scout: WorkerDefinition = { name: "explorer", role: "scout", systemPrompt: "scout" }
    const deps = makeDeps(dir, {
      defaultModel: "lead-model-x",
      resolveDefinition: (n) => (n === "explorer" ? scout : undefined),
      recommendForRole: (role) =>
        role === "scout" ? { modelId: "provider-scout-model", effort: "low" } : undefined,
    })
    const r = await spawnAgent({ task: "scan", agent: "explorer" }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // the role recommendation beat the lead default
    expect(r.value.model).toBe("provider-scout-model")
    // and the recommended effort rode along on the launch
    const argv = deps.launched[0] ?? []
    expect(argv[argv.indexOf("--effort") + 1]).toBe("low")
  })

  it("falls back to the lead model when the provider recommends nothing for the role", async () => {
    const deep: WorkerDefinition = { name: "reviewer", role: "deep", systemPrompt: "review" }
    const deps = makeDeps(dir, {
      defaultModel: "lead-model-x",
      resolveDefinition: (n) => (n === "reviewer" ? deep : undefined),
      recommendForRole: () => undefined, // provider has no rec for this role
    })
    const r = await spawnAgent({ task: "review", agent: "reviewer" }, deps)
    expect(r.ok && r.value.model).toBe("lead-model-x")
  })

  it("an explicit per-spawn model still wins over a role recommendation", async () => {
    const scout: WorkerDefinition = { name: "explorer", role: "scout", systemPrompt: "scout" }
    const deps = makeDeps(dir, {
      defaultModel: "lead-model-x",
      resolveDefinition: (n) => (n === "explorer" ? scout : undefined),
      recommendForRole: () => ({ modelId: "provider-scout-model" }),
    })
    const r = await spawnAgent({ task: "scan", agent: "explorer", model: "user-pick" }, deps)
    expect(r.ok && r.value.model).toBe("user-pick")
  })

  it("threads isolation=fork through to a --resume <leadSid> launch", async () => {
    const deps = makeDeps(dir)
    const r = await spawnAgent({ task: "side task with my context", isolation: "fork" }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.isolation).toBe("fork")
    const argv = deps.launched[0] ?? []
    // fork resumes the lead so its history forks into the pinned child sid.
    expect(argv[argv.indexOf("--resume") + 1]).toBe(LEAD)
    expect(argv).toContain("--session-id")
  })

  it("rejects an unknown definition name", async () => {
    const deps = makeDeps(dir, { resolveDefinition: () => undefined })
    const r = await spawnAgent({ task: "x", agent: "ghost" }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/unknown sub-agent/i)
  })

  it("launches a read-only specialist with --mode ask (Edit/Write denied at dispatch)", async () => {
    const readonly: WorkerDefinition = { name: "explorer", role: "scout", mode: "ask" }
    const deps = makeDeps(dir, {
      resolveDefinition: (n) => (n === "explorer" ? readonly : undefined),
    })
    const r = await spawnAgent({ task: "find the bug", agent: "explorer" }, deps)
    expect(r.ok).toBe(true)
    const argv = deps.launched[0] ?? []
    expect(argv[argv.indexOf("--mode") + 1]).toBe("ask")
  })

  it("launches an implementer with --mode none (writable) when the definition sets no mode", async () => {
    const writer: WorkerDefinition = { name: "worker", role: "balanced" }
    const deps = makeDeps(dir, {
      resolveDefinition: (n) => (n === "worker" ? writer : undefined),
    })
    const r = await spawnAgent({ task: "implement it", agent: "worker" }, deps)
    expect(r.ok).toBe(true)
    const argv = deps.launched[0] ?? []
    expect(argv[argv.indexOf("--mode") + 1]).toBe("none")
  })

  it("defaults an inline (definition-less) worker to --mode none", async () => {
    const deps = makeDeps(dir)
    const r = await spawnAgent({ task: "inline work" }, deps)
    expect(r.ok).toBe(true)
    const argv = deps.launched[0] ?? []
    expect(argv[argv.indexOf("--mode") + 1]).toBe("none")
  })
})

describe("stopAgent", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "subagents-stop-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("kills the pid and marks the worker stopped", async () => {
    const deps = makeDeps(dir)
    const sp = await spawnAgent({ task: "long job" }, deps)
    expect(sp.ok).toBe(true)
    const killed: number[] = []
    const r = stopAgent("A1", "superseded", {
      store: deps.store,
      kill: (pid) => killed.push(pid),
      now: () => new Date("2026-05-30T12:05:00.000Z"),
    })
    expect(r.ok).toBe(true)
    expect(killed).toEqual([5001])
    expect(deps.store.get("A1")?.status.kind).toBe("stopped")
  })

  it("is a no-op on an unknown id (err) and idempotent on a terminal worker", async () => {
    const deps = makeDeps(dir)
    const miss = stopAgent("ZZ", undefined, {
      store: deps.store,
      kill: () => {},
      now: () => new Date(),
    })
    expect(miss.ok).toBe(false)
  })

  it("SIGKILLs lastPid on a done leftover without rewriting status", () => {
    const deps = makeDeps(dir)
    deps.store.upsert({
      id: subagentId("A1"),
      sid: sessionId(FIXED_SID),
      label: "explorer",
      type: "explorer",
      model: "cursor-auto",
      task: "scout",
      isolation: "fresh",
      workspace: "inherit-cwd",
      spawnedAt: "2026-05-30T12:00:00.000Z",
      status: {
        kind: "done",
        endedAt: "2026-05-30T12:01:00.000Z",
        result: { short: "ok", tokens: 1, tools: 1 },
      },
      lastPid: 4242,
      depth: 1,
      leadSid: LEAD,
    })
    const killed: number[] = []
    const r = stopAgent("A1", "reap leftover", {
      store: deps.store,
      kill: (pid) => killed.push(pid),
      now: () => new Date("2026-05-30T12:05:00.000Z"),
    })
    expect(r.ok).toBe(true)
    expect(killed).toEqual([4242])
    expect(deps.store.get("A1")?.status.kind).toBe("done")
  })
})

describe("stopAllAgents", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "subagents-stopall-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("SIGKILLs every running worker and marks them stopped (lead willStop)", async () => {
    const deps = makeDeps(dir)
    expect((await spawnAgent({ task: "a" }, deps)).ok).toBe(true)
    expect((await spawnAgent({ task: "b" }, deps)).ok).toBe(true)
    const killed: number[] = []
    const n = stopAllAgents("lead shutting down", {
      store: deps.store,
      kill: (pid) => killed.push(pid),
      now: () => new Date("2026-05-30T12:05:00.000Z"),
    })
    expect(n).toBe(2)
    expect(killed).toEqual([5001, 5002])
    for (const id of ["A1", "A2"]) {
      const st = deps.store.get(id)?.status
      expect(st?.kind).toBe("stopped")
      if (st?.kind === "stopped") expect(st.reason).toBe("lead shutting down")
    }
  })

  it("is a no-op when the fleet is empty", () => {
    const deps = makeDeps(dir)
    const killed: number[] = []
    expect(
      stopAllAgents("lead shutting down", {
        store: deps.store,
        kill: (pid) => killed.push(pid),
        now: () => new Date(),
      }),
    ).toBe(0)
    expect(killed).toEqual([])
  })

  it("SIGKILLs lastPid on a done leftover (ReportResult pid still alive)", () => {
    // Live 2026-08-29: supervisor marks done on the sentinel while the bun pid
    // is still alive. done has no pid field, so skipping terminal records (or
    // only reading running.pid) leaves obscura-worker children orphaned.
    const deps = makeDeps(dir)
    deps.store.upsert({
      id: subagentId("A1"),
      sid: sessionId(FIXED_SID),
      label: "explorer",
      type: "explorer",
      model: "cursor-auto",
      task: "scout",
      isolation: "fresh",
      workspace: "inherit-cwd",
      spawnedAt: "2026-05-30T12:00:00.000Z",
      status: {
        kind: "done",
        endedAt: "2026-05-30T12:01:00.000Z",
        result: { short: "ok", tokens: 1, tools: 1 },
      },
      lastPid: 4242,
      depth: 1,
      leadSid: LEAD,
    })
    const killed: number[] = []
    const n = stopAllAgents("lead shutting down", {
      store: deps.store,
      kill: (pid) => killed.push(pid),
      now: () => new Date("2026-05-30T12:05:00.000Z"),
    })
    expect(n).toBe(1)
    expect(killed).toEqual([4242])
    // Work already finished. Reap the pid, do not rewrite the status.
    expect(deps.store.get("A1")?.status.kind).toBe("done")
  })
})

describe("spawnAgent permission clamp (SPEC R6, R7, R13, T2, T3, T8)", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "subagents-clamp-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const ASK = { id: "ask", permissions: { allow: ["*"], deny: ["Edit", "Write"] } }
  const argAfter = (argv: string[] | undefined, flag: string): string | undefined =>
    argv ? argv[argv.indexOf(flag) + 1] : undefined

  it("lead in ask lowers a writable worker to ask and reports it", async () => {
    const deps = makeDeps(dir, {
      queryHostPolicy: () => ({ activeModeId: "ask", modes: [ASK], tools: { kind: "all" } }),
    })
    const r = await spawnAgent({ task: "edit things" }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(argAfter(deps.launched[0], "--mode")).toBe("ask")
    expect(r.value.modeLowered).toEqual({ from: "none", to: "ask" })
    expect(deps.launched[0]).not.toContain("--tools")
  })

  it("lead in no mode keeps a read-only role in ask, not lowered", async () => {
    const def: WorkerDefinition = { name: "explorer", mode: "ask" }
    const deps = makeDeps(dir, {
      resolveDefinition: () => def,
      queryHostPolicy: () => ({ activeModeId: null, modes: [ASK], tools: { kind: "all" } }),
    })
    const r = await spawnAgent({ task: "look", agent: "explorer" }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(argAfter(deps.launched[0], "--mode")).toBe("ask")
    expect(r.value.modeLowered).toBeUndefined()
  })

  it("lead --tools Read,Grep: worker gets Read,Grep and the report tool (T3)", async () => {
    const deps = makeDeps(dir, {
      queryHostPolicy: () => ({
        activeModeId: null,
        modes: [],
        tools: { kind: "list", names: ["Read", "Grep"] },
      }),
    })
    await spawnAgent({ task: "read" }, deps)
    expect(argAfter(deps.launched[0], "--tools")).toBe(
      "Read,Grep,SubAgentsReportResult,ReportResult",
    )
  })

  it("lead --no-tools: worker gets only the report tool, never --no-tools (T3)", async () => {
    const deps = makeDeps(dir, {
      queryHostPolicy: () => ({ activeModeId: null, modes: [], tools: { kind: "none" } }),
    })
    await spawnAgent({ task: "read" }, deps)
    expect(argAfter(deps.launched[0], "--tools")).toBe("SubAgentsReportResult,ReportResult")
    expect(deps.launched[0]).not.toContain("--no-tools")
  })

  it("no snapshot, no lead env mode (older core): role mode kept, no --tools (T8)", async () => {
    const warnings: string[] = []
    const deps = makeDeps(dir, { warn: (m: string) => warnings.push(m) })
    const r = await spawnAgent({ task: "edit" }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(argAfter(deps.launched[0], "--mode")).toBe("none")
    expect(deps.launched[0]).not.toContain("--tools")
    expect(r.value.modeLowered).toBeUndefined()
    expect(warnings.length).toBe(1)
  })

  it("no snapshot, lead env mode ask: a writable worker is lowered to ask (T8, R7)", async () => {
    const deps = makeDeps(dir, { leadModeEnv: "ask" })
    const r = await spawnAgent({ task: "edit" }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(argAfter(deps.launched[0], "--mode")).toBe("ask")
    expect(r.value.modeLowered).toEqual({ from: "none", to: "ask" })
  })

  it("persists modeLowered and the inherit summary on the record (R12, R13)", async () => {
    const deps = makeDeps(dir, {
      queryHostPolicy: () => ({ activeModeId: "ask", modes: [ASK], tools: { kind: "all" } }),
    })
    await spawnAgent({ task: "edit" }, deps)
    const stored = new SubagentStore(LEAD, { dir }).get("A1")
    expect(stored?.modeLowered).toEqual({ from: "none", to: "ask" })
    expect(stored?.inherit).toBe("inherit: profile:none tools:all mode:ask")
  })
})

describe("spawnAgent startup profile (SPEC 4.4, 4.5, 6.4, R11, R12, T1, T8)", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "subagents-profile-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const argAfter = (argv: string[] | undefined, flag: string): string | undefined =>
    argv?.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined
  const PROFILE: StartupProfile = {
    version: 1,
    systemPrompt: {
      providerPreamble: { kind: "replace", text: "PRE" },
      instructions: { kind: "omit" },
      unsafeProviderOverrides: true,
    },
    noAgentsMd: true,
    pluginPrompts: { all: true, suppress: [], keep: [] },
    plugins: { disable: ["foo"], enable: [] },
    bare: false,
    tools: { kind: "list", names: ["Read", "Grep"] },
  }
  const leadPath = (d: string): string => `${d}/${LEAD}.profile.json`

  it("passes the lead profile path and records the summary (T1, R12)", async () => {
    const deps = makeDeps(dir, {
      startupProfile: () => ({ path: leadPath(dir), profile: PROFILE }),
    })
    const r = await spawnAgent({ task: "go" }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(argAfter(deps.launched[0], "--startup-profile")).toBe(leadPath(dir))
    expect(argAfter(deps.launched[0], "--disable-plugin")).toBe("intercom")
    expect(r.value.inherit).toBe(
      "inherit: sys(~pre,-instr,!unsafe) agents-md:off plugin-prompts:off plugins(-foo) tools:lead mode:none",
    )
  })

  it("falls back to profile.tools for the clamp when no snapshot exists", async () => {
    const deps = makeDeps(dir, {
      startupProfile: () => ({ path: leadPath(dir), profile: PROFILE }),
    })
    await spawnAgent({ task: "go" }, deps)
    expect(argAfter(deps.launched[0], "--tools")).toBe(
      "Read,Grep,SubAgentsReportResult,ReportResult",
    )
  })

  it("R11 off: no --startup-profile, clamps still apply, env channel back (T1)", async () => {
    const envs: Record<string, string>[] = []
    const deps = makeDeps(dir, {
      inherit: false,
      disabledPlugins: "memory",
      startupProfile: () => ({ path: leadPath(dir), profile: PROFILE }),
      queryHostPolicy: () => ({
        activeModeId: "ask",
        modes: [{ id: "ask", permissions: { allow: ["*"], deny: ["Edit"] } }],
        tools: { kind: "none" },
      }),
    })
    const launched: string[][] = []
    const d2 = {
      ...deps,
      spawnDeps: {
        launch: (argv: readonly string[], opts: { env: Record<string, string> }) => {
          launched.push([...argv])
          envs.push(opts.env)
          return 9001
        },
      },
    }
    const r = await spawnAgent({ task: "go" }, d2)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(launched[0]).not.toContain("--startup-profile")
    expect(argAfter(launched[0], "--tools")).toBe("SubAgentsReportResult,ReportResult")
    expect(argAfter(launched[0], "--mode")).toBe("ask")
    expect(envs[0]?.MINIMAL_AGENT_DISABLE_PLUGINS).toBe("memory,intercom")
    expect(r.value.inherit).toBe("inherit: profile:off tools:none mode:ask")
  })

  it("T8: no ctx.startupProfile and no snapshot, spawn works as before", async () => {
    const envs: Record<string, string>[] = []
    const deps = makeDeps(dir, {
      disabledPlugins: "memory",
      spawnDeps: {
        launch: (_argv, opts) => {
          envs.push(opts.env)
          return 9002
        },
      },
    })
    const r = await spawnAgent({ task: "go" }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(envs[0]?.MINIMAL_AGENT_DISABLE_PLUGINS).toBe("memory,intercom")
    expect(r.value.inherit).toBe("inherit: profile:none tools:all mode:none")
  })

  it("SPEC 6.4: other provider gets a derived profile without provider parts", async () => {
    const written: { path: string; profile: StartupProfile }[] = []
    const warns: string[] = []
    const deps = makeDeps(dir, {
      leadProvider: "anthropic",
      resolveProvider: () => "openai",
      startupProfile: () => ({ path: leadPath(dir), profile: PROFILE }),
      writeProfile: (path, profile) => written.push({ path, profile }),
      warn: (m) => warns.push(m),
    })
    const r = await spawnAgent({ task: "go", model: "gpt-x" }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const childPath = `${dir}/${FIXED_SID}.profile.json`
    expect(written).toHaveLength(1)
    expect(written[0]?.path).toBe(childPath)
    expect(written[0]?.profile.systemPrompt).toEqual({ instructions: { kind: "omit" } })
    expect(argAfter(deps.launched[0], "--startup-profile")).toBe(childPath)
    // No snapshot here, so the best-effort clamp warning (T8) comes first.
    const providerWarns = warns.filter((w) => w.includes("openai"))
    expect(providerWarns).toHaveLength(1)
    expect(r.value.profileProvider).toEqual({ lead: "anthropic", worker: "openai" })
    expect(r.value.inherit).toBe(
      "inherit: sys(-instr) agents-md:off plugin-prompts:off plugins(-foo) tools:lead mode:none",
    )
  })

  it("SPEC 6.4: the real writer puts valid JSON on disk", async () => {
    const deps = makeDeps(dir, {
      leadProvider: "anthropic",
      resolveProvider: () => "openai",
      startupProfile: () => ({ path: leadPath(dir), profile: PROFILE }),
    })
    const r = await spawnAgent({ task: "go", model: "gpt-x" }, deps)
    expect(r.ok).toBe(true)
    const onDisk = JSON.parse(readFileSync(`${dir}/${FIXED_SID}.profile.json`, "utf8"))
    expect(onDisk.systemPrompt.providerPreamble).toBeUndefined()
    expect(onDisk.systemPrompt.unsafeProviderOverrides).toBeUndefined()
    expect(onDisk.plugins.disable).toEqual(["foo"])
  })

  it("same provider keeps the lead profile file, writes nothing", async () => {
    const written: string[] = []
    const deps = makeDeps(dir, {
      leadProvider: "anthropic",
      resolveProvider: () => "anthropic",
      startupProfile: () => ({ path: leadPath(dir), profile: PROFILE }),
      writeProfile: (path) => written.push(path),
    })
    await spawnAgent({ task: "go", model: "claude-x" }, deps)
    expect(written).toHaveLength(0)
    expect(argAfter(deps.launched[0], "--startup-profile")).toBe(leadPath(dir))
  })
})

describe("provider-profile template (SPEC 6.4)", () => {
  it("renders one line that names both providers", () => {
    const out = testRender("provider-profile.tmpl.md", { lead: "a", worker: "b" }).trim()
    expect(out.split("\n")).toHaveLength(1)
    expect(out).toContain("`a`")
    expect(out).toContain("`b`")
    expect(out).not.toContain("%%")
  })
})

describe("mode-lowered template (SPEC R13)", () => {
  it("renders one line that names both modes", () => {
    const out = testRender("mode-lowered.tmpl.md", { from: "none", to: "ask" }).trim()
    expect(out.split("\n")).toHaveLength(1)
    expect(out).toContain("`ask`")
    expect(out).toContain("`none`")
    expect(out).not.toContain("%%")
  })
})
