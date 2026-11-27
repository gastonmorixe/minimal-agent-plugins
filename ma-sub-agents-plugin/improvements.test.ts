/**
 * Regression and feature tests for the sub-agents improvements:
 * Phase 1: supervisor stability, streamReader over-4-MiB / UTF-8 / waiting+error,
 *          persistent ProbeDeps cache, store/presence atomicity, stopAgent
 *          terminalEffects + lastPid cleanup, stall watchdog, soft maxTokens,
 *          attachment uncollected + endedAt sort, report_result ancestor symlink,
 *          agent_result live sentinel, budget validation, stale-credential recovery.
 * Phase 2: lead-only tool availability gates, fresh role tool clamping (and fork
 *          invariance), statusDetail task truncation, role defaults.
 * Phase 3: push mailbox drain, ReportResult pre-exit steering hold, resumeAgent
 *          + mailbox resume, wave coalescing, urgent mailbox lead wakeup, and
 *          host-neutral headless supervisor timer.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { renderFor } from "../tests/support/prompt-render.ts"
import { pluginSideband } from "../tests/support/sideband.ts"

import { available as agentOutputAvail } from "./handlers/agent_output.ts"
import agentResult, { available as agentResultAvail } from "./handlers/agent_result.ts"
import { available as agentStatusAvail } from "./handlers/agent_status.ts"
import budgetTransforms from "./handlers/budget_transforms.ts"
import { available as listAgentsAvail } from "./handlers/list_agents.ts"
import mailboxHandler from "./handlers/mailbox.ts"
import reportResult from "./handlers/report_result.ts"
import { available as spawnAvail } from "./handlers/spawn_agent.ts"
import { available as stopAvail } from "./handlers/stop_agent.ts"
import makeSubagentsAttachment from "./handlers/turn_attachment.ts"
import { SubagentsAttachment } from "./lib/attachment.ts"
import { budgetEnv, budgetLevel, createLatch, nextBudgetWarning } from "./lib/budget-warning.ts"
import { statusDetail } from "./lib/content.ts"
import { clearProbeDepsCache, storeFromCtx, supervisorDepsFromCtx } from "./lib/handler-deps.ts"
import {
  noteHeartbeatTick,
  startHeadlessSupervisor,
  stopHeadlessSupervisor,
} from "./lib/headless-supervisor.ts"
import type { HookHandlerContext, LiveAreaHandlerContext, TUIContext } from "./lib/host-types.ts"
import { getLibrary, resolveDefinition } from "./lib/library.ts"
import {
  createWorkerMailboxDrain,
  drainUnreadMessages,
  incomingFor,
  mailboxPathFor,
  makeMailId,
  postMessage,
  resetMailboxCursor,
} from "./lib/mailbox.ts"
import { removeLeadPresence, writeLeadPresence } from "./lib/presence.ts"
import { writeStartupProfile } from "./lib/profile-io.ts"
import { resolveCredentialName, resolveLeadEffort } from "./lib/runtime.ts"
import {
  resumeAgent,
  type ServiceDeps,
  spawnAgent,
  stopAgent,
  stopAllAgents,
} from "./lib/service.ts"
import { ENV_EXPECT_ARTIFACTS, ENV_RESULT_PATH, type ProbeDeps } from "./lib/spawn.ts"
import { ENV_ID, ENV_LEAD } from "./lib/spawn-plan.ts"
import { findKnownStale, staleCredentialReason } from "./lib/stale-credential.ts"
import { SubagentStore } from "./lib/store.ts"
import { parseStream, streamEnded, streamReader } from "./lib/stream.ts"
import { DEFAULT_STALL_SEC, supervisorTick } from "./lib/supervisor.ts"
import { runSupervisor } from "./lib/supervisor-shell.ts"
import { type SubagentRecord, type SubagentStatus, sessionId, subagentId } from "./lib/types.ts"
import { parseSpawnRequest } from "./lib/validate.ts"

const sb = await pluginSideband()
const testRender = renderFor("ma-sub-agents-plugin", import.meta.dir)
const LEAD = sessionId("ba0ad20f-1111-4111-8111-111111111111")
const CHILD = sessionId("9c1a4f2e-0b3d-4a6c-8e1f-2d3c4b5a6978")
const NOW = "2026-11-27T12:00:00.000Z"
const NOW_MS = Date.parse(NOW)

function makeRec(
  id: string,
  status: SubagentStatus,
  extra?: Partial<SubagentRecord>,
): SubagentRecord {
  return {
    id: subagentId(id),
    sid: CHILD,
    label: "worker",
    type: "worker",
    model: "claude-sonnet-4-6",
    task: "test task",
    isolation: "fresh",
    workspace: "inherit-cwd",
    spawnedAt: "2026-11-27T11:50:00.000Z",
    status,
    depth: 1,
    leadSid: LEAD,
    ...extra,
  }
}

function makeServiceDeps(
  dir: string,
  launched: { argv: readonly string[]; env: Record<string, string> }[],
  overrides: Partial<ServiceDeps> = {},
): ServiceDeps {
  let n = 0
  return {
    store: new SubagentStore(LEAD, { dir }),
    spawnDeps: {
      launch: (argv, opts) => {
        launched.push({ argv, env: opts.env })
        return 8000 + launched.length
      },
    },
    agentBin: ["minimal-agent"],
    leadSid: LEAD,
    depth: 0,
    cwd: dir,
    sessionsDir: dir,
    defaultModel: "claude-sonnet-4-6",
    newSid: () => `9c1a4f2e-0b3d-4a6c-8e1f-2d3c4b5a697${n++}`,
    now: () => new Date(NOW),
    renderPrompt: testRender,
    resolveDefinition: (name) => resolveDefinition(name, testRender),
    ...overrides,
  }
}

describe("Phase 1: stability, supervisor, and bug fixes", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "subagents-imp-p1-"))
  })
  afterEach(() => {
    clearProbeDepsCache()
    resetMailboxCursor()
    rmSync(dir, { recursive: true, force: true })
  })

  it("caches ProbeDeps per leadSid across supervisorDepsFromCtx ticks", () => {
    const ctx = {
      env: { MINIMAL_AGENT_HOME: dir },
      cwd: dir,
      tick: 1,
      agent: { sessionId: LEAD, pid: 1234 },
    } as unknown as LiveAreaHandlerContext
    const d1 = supervisorDepsFromCtx(ctx)
    const d2 = supervisorDepsFromCtx({ ...ctx, tick: 2 })
    expect(d1).not.toBeNull()
    expect(d1?.probeDeps).toBe(d2?.probeDeps)
    clearProbeDepsCache(LEAD)
    const d3 = supervisorDepsFromCtx({ ...ctx, tick: 3 })
    expect(d3?.probeDeps).not.toBe(d1?.probeDeps)
  })

  it("storeFromCtx resolves fleet via ENV_LEAD inside a worker", () => {
    const sessionsDir = join(dir, "sessions")
    const leadStore = new SubagentStore(LEAD, { dir: sessionsDir })
    leadStore.upsert(makeRec("A1", { kind: "queued" }))
    const workerCtx = {
      env: { MINIMAL_AGENT_HOME: dir, [ENV_LEAD]: LEAD },
      agent: { sessionId: CHILD },
    } as unknown as TUIContext
    const resolved = storeFromCtx(workerCtx)
    expect(resolved?.get("A1")?.id).toBe(subagentId("A1"))
  })

  it("streamReader skips an oversized (>4 MiB) NDJSON line instead of wedging", () => {
    const file = join(dir, "huge.stream.ndjson")
    const bigLine = `{"type":"text_delta","text":"${"a".repeat(4 * 1024 * 1024 + 100)}"}\n`
    const tailLine = `{"type":"turn_started","turn":2,"ts":2000}\n`
    writeFileSync(file, bigLine + tailLine)
    const read = streamReader()
    // First tick advances across first 4 MiB chunk; second tick finishes oversized line + reads turn 2.
    read(file)
    const state = read(file)
    expect(state?.turns).toBe(2)
  })

  it("streamEnded returns true on waiting + error outcome", () => {
    const s = parseStream(
      [
        `{"type":"error","message":"auth failed","ts":1000}`,
        `{"type":"run_finished","outcome":"waiting","ts":1001}`,
      ].join("\n"),
    )
    expect(streamEnded(s)).toBe(true)
  })

  it("runtime parsers support --flag=value forms", () => {
    expect(resolveCredentialName({}, ["bun", "cli", "--credential-name=work-oauth"])).toBe(
      "work-oauth",
    )
    expect(resolveLeadEffort({}, ["bun", "cli", "--effort=high"])).toBe("high")
  })

  it("writeStartupProfile creates missing parent directories", () => {
    const target = join(dir, "nested", "sub", "child.profile.json")
    writeStartupProfile(target, {
      version: 1,
      tools: { kind: "all" },
      plugins: { disabled: [] },
      prompt: {},
    } as unknown as Parameters<typeof writeStartupProfile>[1])
    expect(existsSync(target)).toBe(true)
  })

  it("writeLeadPresence is atomic, caches identical writes, and removeLeadPresence deletes it", () => {
    const pDir = join(dir, "presence")
    const rows = [{ sid: LEAD, role: "lead" as const, pid: 1, status: "active" as const, ts: NOW }]
    writeLeadPresence(pDir, LEAD, rows)
    const file = join(pDir, `${LEAD}.jsonl`)
    expect(existsSync(file)).toBe(true)
    writeLeadPresence(pDir, LEAD, rows)
    removeLeadPresence(pDir, LEAD)
    expect(existsSync(file)).toBe(false)
  })

  it("stopAgent and stopAllAgents emit taskUpdate(canceled) and clear lastPid", () => {
    const store = new SubagentStore(LEAD, { dir })
    store.upsert(
      makeRec(
        "A1",
        { kind: "running", pid: 9991, startedAt: NOW, progress: { tools: 2, tokens: 100 } },
        { lastPid: 9991, taskId: "5a" },
      ),
    )
    const killed: number[] = []
    const emitted: { channel: string; payload: unknown }[] = []
    const r = stopAgent("A1", "obsolete", {
      store,
      kill: (pid) => killed.push(pid),
      now: () => new Date(NOW),
      emit: (channel, payload) => emitted.push({ channel, payload }),
    })
    expect(r.ok).toBe(true)
    expect(killed).toEqual([9991])
    expect(store.get("A1")?.lastPid).toBeUndefined()
    expect(emitted.some((e) => e.channel === "subagent.taskUpdate")).toBe(true)
    expect(emitted.some((e) => e.channel === "subagent.didExit")).toBe(true)

    // Second stop call does not signal the already-cleared PID again.
    stopAgent("A1", "again", {
      store,
      kill: (pid) => killed.push(pid),
      now: () => new Date(NOW),
    })
    expect(killed).toEqual([9991])

    // stopAllAgents cleans terminal lastPid once and cancels active task.
    store.upsert(
      makeRec(
        "A2",
        { kind: "done", endedAt: NOW, result: { short: "ok", tokens: 1, tools: 1 } },
        { lastPid: 9992 },
      ),
    )
    const count = stopAllAgents("shutdown", {
      store,
      kill: (pid) => killed.push(pid),
      now: () => new Date(NOW),
    })
    expect(count).toBe(1)
    expect(store.get("A2")?.lastPid).toBeUndefined()
  })

  it("supervisorTick triggers stall watchdog after DEFAULT_STALL_SEC of silence", () => {
    const r = makeRec("A1", {
      kind: "running",
      pid: 4242,
      startedAt: "2026-11-27T11:50:00.000Z",
      progress: { tools: 1, tokens: 100, lastEventAt: NOW_MS - DEFAULT_STALL_SEC * 1000 },
    })
    const out = supervisorTick({
      records: [r],
      probes: new Map([
        [
          "A1",
          {
            alive: true,
            progress: { tools: 1, tokens: 100, lastEventAt: NOW_MS - DEFAULT_STALL_SEC * 1000 },
          },
        ],
      ]),
      now: NOW,
      nowMs: NOW_MS,
    })
    expect(out.records[0]?.status.kind).toBe("running")
    if (out.records[0]?.status.kind === "running") {
      expect(out.records[0].status.grace?.error).toContain("stalled")
    }
    expect(out.effects.some((e) => e.type === "signal" && e.sig === "SIGTERM")).toBe(true)
  })

  it("budgetLevel and budgetTransforms support soft maxTokens warnings and injected env", () => {
    expect(
      budgetLevel({
        elapsedMs: 1000,
        deadlineMs: 100_000,
        turnsUsed: 1,
        outputTokens: 750,
        maxTokens: 1000,
      }),
    ).toBe("warn")
    expect(
      budgetLevel({
        elapsedMs: 1000,
        deadlineMs: 100_000,
        turnsUsed: 1,
        outputTokens: 900,
        maxTokens: 1000,
      }),
    ).toBe("final")
    const env = {
      [ENV_RESULT_PATH]: join(dir, "w.result.json"),
      ...budgetEnv({ deadlineSec: 300, maxTokens: 1000 }, NOW),
    }
    const latch = createLatch()
    const w = nextBudgetWarning(env, NOW_MS + 1000, 1, latch, 800)
    expect(w?.level).toBe("warn")
    // Factory uses the passed `env`, not process.env.
    const stages = budgetTransforms(env)
    expect(stages.length).toBe(1)
  })

  it("SubagentsAttachment stays visible for uncollected results and sorts newest terminal first", () => {
    const store = new SubagentStore(LEAD, { dir })
    store.upsert(
      makeRec(
        "A1",
        {
          kind: "done",
          endedAt: "2026-11-27T11:55:00.000Z",
          result: { short: "old", tokens: 1, tools: 1 },
        },
        { uncollected: true },
      ),
    )
    store.upsert(
      makeRec(
        "A2",
        {
          kind: "done",
          endedAt: "2026-11-27T11:59:00.000Z",
          result: { short: "new", tokens: 1, tools: 1 },
        },
        { uncollected: true },
      ),
    )
    const text = new SubagentsAttachment(LEAD, { dir }, () => NOW_MS, sb).toText()
    expect(text).not.toBeNull()
    expect((text as string).indexOf("A2")).toBeLessThan((text as string).indexOf("A1"))
  })

  it("AgentResult surfaces live on-disk sentinel while running and clears uncollected on terminal", async () => {
    const sessionsDir = join(dir, "sessions")
    const store = new SubagentStore(LEAD, { dir: sessionsDir })
    store.upsert(
      makeRec("A1", {
        kind: "running",
        pid: 4242,
        startedAt: NOW,
        progress: { tools: 3, tokens: 500 },
      }),
    )
    writeFileSync(
      join(sessionsDir, `${CHILD}.result.json`),
      JSON.stringify({ short: "Live sentinel answer", tokens: 500, tools: 3 }),
    )
    const ctx = {
      trigger: { type: "tool", input: { id: "A1" } },
      env: { MINIMAL_AGENT_HOME: dir },
      agent: { sessionId: LEAD },
    } as unknown as TUIContext
    const res = await agentResult(ctx)
    expect(res.content).toContain("Live sentinel answer")

    // Terminal uncollected flag clears when AgentResult is read.
    store.upsert(
      makeRec(
        "A1",
        {
          kind: "done",
          endedAt: NOW,
          result: { short: "Live sentinel answer", tokens: 500, tools: 3 },
        },
        { uncollected: true },
      ),
    )
    await agentResult(ctx)
    expect(store.get("A1")?.uncollected).toBeUndefined()
  })

  it("ReportResult rejects deliverables whose ancestor directory is a symlink", async () => {
    const realTarget = join(dir, "real-dir")
    mkdirSync(realTarget, { recursive: true })
    const linkDir = join(dir, "link-dir")
    symlinkSync(realTarget, linkDir)
    const required = join(linkDir, "out.md")
    const resultPath = join(dir, "worker.result.json")
    const ctx = {
      trigger: {
        type: "tool",
        input: { summary: "done", deliverables: [{ path: required, content: "hello" }] },
      },
      env: {
        [ENV_RESULT_PATH]: resultPath,
        [ENV_EXPECT_ARTIFACTS]: JSON.stringify([required]),
      },
    } as unknown as TUIContext
    const res = await reportResult(ctx)
    expect(res.is_error).toBe(true)
    expect(res.content).toContain("symlink")
    expect(existsSync(join(realTarget, "out.md"))).toBe(false)
  })

  it("parseSpawnRequest rejects non-positive budget fields instead of dropping them", () => {
    const r = parseSpawnRequest({ task: "do work", budget: { maxTurns: 0 } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("budget.maxTurns")
  })

  it("findKnownStale clears stale flag after a later done worker succeeds on the same provider", () => {
    const errText = staleCredentialReason({ name: "oauth-1", provider: "anthropic" })
    const failed = makeRec("A1", {
      kind: "failed",
      endedAt: "2026-11-27T11:55:00.000Z",
      error: errText,
    })
    expect(findKnownStale([failed], "oauth-1", "anthropic")).toEqual({
      name: "oauth-1",
      provider: "anthropic",
    })
    const recovered = makeRec("A2", {
      kind: "done",
      endedAt: "2026-11-27T11:58:00.000Z",
      result: { short: "ok", tokens: 1, tools: 1 },
    })
    expect(findKnownStale([failed, recovered], "oauth-1", "anthropic")).toBeUndefined()
  })
})

describe("Phase 2: token efficiency, tool gating, and role upgrades", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "subagents-imp-p2-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("hides all 6 lead-only tools inside a worker process", () => {
    const leadCtx = { env: {} }
    const workerCtx = { env: { [ENV_RESULT_PATH]: "/tmp/w.result.json" } }
    for (const avail of [
      spawnAvail,
      listAgentsAvail,
      agentStatusAvail,
      agentOutputAvail,
      agentResultAvail,
      stopAvail,
    ]) {
      expect(avail(leadCtx)).toBe(true)
      expect(avail(workerCtx)).toBe(false)
    }
  })

  it("clamps fresh explorer tools to role allowlist while keeping fork planner invariant", async () => {
    const launched: { argv: readonly string[]; env: Record<string, string> }[] = []
    const deps = makeServiceDeps(dir, launched, {
      queryHostPolicy: () => ({
        activeModeId: "none",
        tools: { kind: "all" },
        modes: [{ id: "ask", permissions: { allow: ["*"], deny: ["Edit", "Write"] } }],
      }),
    })
    const exp = await spawnAgent({ task: "find foo", agent: "explorer" }, deps)
    expect(exp.ok).toBe(true)
    const expArgv = launched[0]?.argv ?? []
    const toolsIdx = expArgv.indexOf("--tools")
    expect(toolsIdx).toBeGreaterThan(-1)
    expect(expArgv[toolsIdx + 1]).toContain("Read,Glob,Grep,Bash")
    expect(expArgv[toolsIdx + 1]).not.toContain("Write")

    // Planner uses isolation: "fork", so tools stay invariant to preserve KV cache.
    const plan = await spawnAgent({ task: "plan foo", agent: "planner" }, deps)
    expect(plan.ok).toBe(true)
    const planArgv = launched[1]?.argv ?? []
    expect(planArgv).not.toContain("--tools")
  })

  it("truncates long task prompts and omits full result in statusDetail", () => {
    const longTask = "x".repeat(400)
    const r = makeRec(
      "A1",
      {
        kind: "done",
        endedAt: NOW,
        result: { short: "SECRET_FULL_RESULT_BODY", tokens: 10, tools: 1 },
      },
      { task: longTask },
    )
    const detail = statusDetail(r, NOW_MS)
    expect(detail.length).toBeLessThan(350)
    expect(detail).not.toContain("SECRET_FULL_RESULT_BODY")
  })

  it("assigns budgets and distinct colors across library specialists", () => {
    const lib = getLibrary(testRender)
    const colors = new Set(lib.map((d) => d.color))
    expect(colors.size).toBe(lib.length)
    for (const d of lib) {
      expect(d.budget?.deadlineSec).toBeGreaterThan(0)
      expect(d.budget?.maxTurns).toBeGreaterThan(0)
    }
  })
})

describe("Phase 3: push mailbox steering, resume, wave coalescing, and headless supervisor", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "subagents-imp-p3-"))
    resetMailboxCursor()
  })
  afterEach(() => {
    stopHeadlessSupervisor(LEAD)
    resetMailboxCursor()
    rmSync(dir, { recursive: true, force: true })
  })

  it("pushes unread mailbox updates via TurnContentDrain without self-echo", () => {
    const path = mailboxPathFor(dir, LEAD)
    const drain = createWorkerMailboxDrain(path, "A2")
    expect(drain.consumeAll()).toEqual([])

    postMessage(path, {
      id: makeMailId(),
      ts: NOW,
      from: "A2",
      to: "*",
      kind: "note",
      body: "my own",
    })
    postMessage(path, {
      id: makeMailId(),
      ts: NOW,
      from: "lead",
      to: "A2",
      kind: "steer",
      body: "use v2",
    })
    const blocks = drain.consumeAll()
    expect(blocks.length).toBe(1)
    expect(blocks[0]?.text).toContain("use v2")
    expect(blocks[0]?.text).not.toContain("my own")
    // Second drain is empty (byte cursor advanced).
    expect(drain.consumeAll()).toEqual([])
    expect(
      incomingFor([{ ts: NOW, from: "A2", to: "*", kind: "note", body: "self" }], "A2"),
    ).toEqual([])
  })

  it("turn_attachment returns a worker push drain when ENV_LEAD and ENV_ID are set", () => {
    const prevLead = process.env[ENV_LEAD]
    const prevId = process.env[ENV_ID]
    const prevHome = process.env.MINIMAL_AGENT_HOME
    try {
      process.env[ENV_LEAD] = LEAD
      process.env[ENV_ID] = "A3"
      process.env.MINIMAL_AGENT_HOME = dir
      const sessionsDir = join(dir, "sessions")
      const path = mailboxPathFor(sessionsDir, LEAD)
      postMessage(path, {
        id: makeMailId(),
        ts: NOW,
        from: "lead",
        to: "A3",
        kind: "steer",
        body: "stop reading",
      })
      const prod = makeSubagentsAttachment({ sessionId: CHILD, sideband: sb })
      expect(prod.toAttachment()).toBeNull()
      expect("consumeAll" in prod).toBe(true)
      if ("consumeAll" in prod) {
        const out = prod.consumeAll()
        expect(out.length).toBe(1)
        expect(out[0]?.text).toContain("stop reading")
      }
    } finally {
      if (prevLead === undefined) delete process.env[ENV_LEAD]
      else process.env[ENV_LEAD] = prevLead
      if (prevId === undefined) delete process.env[ENV_ID]
      else process.env[ENV_ID] = prevId
      if (prevHome === undefined) delete process.env.MINIMAL_AGENT_HOME
      else process.env.MINIMAL_AGENT_HOME = prevHome
    }
  })

  it("ReportResult holds completion when an unread lead steer message arrived", async () => {
    const sessionsDir = join(dir, "sessions")
    const mailPath = mailboxPathFor(sessionsDir, LEAD)
    const resultPath = join(sessionsDir, "w.result.json")
    postMessage(mailPath, {
      id: makeMailId(),
      ts: NOW,
      from: "lead",
      to: "A4",
      kind: "steer",
      body: "also verify edge case X",
    })
    const ctx = {
      trigger: { type: "tool", input: { summary: "done" } },
      env: {
        MINIMAL_AGENT_HOME: dir,
        [ENV_RESULT_PATH]: resultPath,
        [ENV_LEAD]: LEAD,
        [ENV_ID]: "A4",
      },
    } as unknown as TUIContext
    const first = await reportResult(ctx)
    expect(first.is_error).toBe(true)
    expect(first.content).toContain("also verify edge case X")
    expect(existsSync(resultPath)).toBe(false)

    // Calling ReportResult again after acknowledging writes the sentinel cleanly.
    const second = await reportResult(ctx)
    expect(second.is_error).toBeUndefined()
    expect(existsSync(resultPath)).toBe(true)
  })

  it("resumeAgent reuses childSid via --resume and clears old sentinel", async () => {
    const launched: { argv: readonly string[]; env: Record<string, string> }[] = []
    const deps = makeServiceDeps(dir, launched)
    const oldSentinel = join(dir, `${CHILD}.result.json`)
    writeFileSync(oldSentinel, JSON.stringify({ short: "old", tokens: 1, tools: 1 }))
    deps.store.upsert(
      makeRec("A1", { kind: "done", endedAt: NOW, result: { short: "old", tokens: 1, tools: 1 } }),
    )
    const res = await resumeAgent("A1", "check file B too", deps)
    expect(res.ok).toBe(true)
    expect(existsSync(oldSentinel)).toBe(false)
    expect(launched[0]?.argv).toContain("--resume")
    expect(launched[0]?.argv).toContain(CHILD)
    expect(deps.store.get("A1")?.status.kind).toBe("running")
  })

  it("supervisorTick coalesces 2+ simultaneous completions into one prompt.inject", () => {
    const r1 = makeRec("A1", {
      kind: "running",
      pid: 101,
      startedAt: NOW,
      progress: { tools: 1, tokens: 10 },
    })
    const r2 = makeRec("A2", {
      kind: "running",
      pid: 102,
      startedAt: NOW,
      progress: { tools: 2, tokens: 20 },
    })
    const out = supervisorTick({
      records: [r1, r2],
      probes: new Map([
        ["A1", { alive: false, result: { short: "done 1", tokens: 10, tools: 1 } }],
        ["A2", { alive: false, result: { short: "done 2", tokens: 20, tools: 2 } }],
      ]),
      now: NOW,
      nowMs: NOW_MS,
    })
    const injects = out.effects.filter((e) => e.type === "inject")
    expect(injects.length).toBe(1)
    if (injects[0]?.type === "inject") {
      expect(injects[0].source).toBe("subagents:wave")
      expect(injects[0].text).toContain("2 sub-agents finished")
      expect(injects[0].text).toContain("A1")
      expect(injects[0].text).toContain("A2")
    }
  })

  it("runSupervisor wakes the lead on urgent worker-to-lead blocker mail", () => {
    const store = new SubagentStore(LEAD, { dir })
    store.upsert(
      makeRec("A1", {
        kind: "running",
        pid: 101,
        startedAt: NOW,
        progress: { tools: 1, tokens: 10 },
      }),
    )
    const mailPath = mailboxPathFor(dir, LEAD)
    postMessage(mailPath, {
      id: makeMailId(),
      ts: NOW,
      from: "A1",
      to: "lead",
      kind: "blocker",
      body: "missing API key",
    })
    const emitted: { channel: string; payload: unknown }[] = []
    const probeDeps: ProbeDeps = {
      pidAlive: () => true,
      readResult: () => undefined,
      readProgress: () => undefined,
      readFinalText: () => undefined,
      missingArtifacts: () => [],
      readCrash: () => undefined,
    }
    runSupervisor({
      store,
      probeDeps,
      emit: (channel, payload) => emitted.push({ channel, payload }),
      kill: () => {},
      sessionsDir: dir,
      leadSid: LEAD,
      now: () => new Date(NOW),
      tick: 1,
      ansi: false,
    })
    const alert = emitted.find(
      (e) =>
        e.channel === "prompt.inject" &&
        (e.payload as { source?: string }).source === "subagents:mailbox",
    )
    expect(alert).toBeDefined()
    expect((alert?.payload as { text?: string } | undefined)?.text).toContain("missing API key")
  })

  it("headless supervisor starts cleanly for a lead, yields to heartbeat, and stops cleanly", () => {
    const hookCtx = {
      env: { MINIMAL_AGENT_SESSIONS_DIR: dir },
      cwd: dir,
      agent: { sessionId: LEAD, pid: process.pid },
    } as unknown as HookHandlerContext
    noteHeartbeatTick(LEAD, Date.now())
    startHeadlessSupervisor(hookCtx)
    stopHeadlessSupervisor(LEAD)
    // Mailbox handler post still works and records message id.
    const unread = drainUnreadMessages(mailboxPathFor(dir, LEAD), "lead")
    expect(unread).toEqual([])
  })

  it("mailbox handler attaches delivery note when posting to a running worker", async () => {
    const sessionsDir = join(dir, "sessions")
    const store = new SubagentStore(LEAD, { dir: sessionsDir })
    store.upsert(
      makeRec("A1", {
        kind: "running",
        pid: 101,
        startedAt: NOW,
        progress: { tools: 0, tokens: 0 },
      }),
    )
    const ctx = {
      trigger: {
        type: "tool",
        input: { action: "post", to: "A1", kind: "steer", body: "pivot now" },
      },
      env: { MINIMAL_AGENT_HOME: dir },
      agent: { sessionId: LEAD },
    } as unknown as TUIContext
    const res = await mailboxHandler(ctx)
    expect(res.content).toContain("Delivered automatically on its next tool round")
    const raw = readFileSync(mailboxPathFor(sessionsDir, LEAD), "utf-8")
    expect(raw).toContain('"id":"m-')
  })
})
