/**
 * A worker that boots with a credential name the auth store does not have any
 * more (the user logged out and in again, the store made new names). The
 * fleet failure reason must name the stale credential and tell the lead what
 * to do, not repeat the misleading "no credentials for provider" text.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { renderFor } from "../../tests/support/prompt-render.ts"

import { type ServiceDeps, spawnAgent } from "./service.ts"
import { extractCrashSignature, type ProbeDeps, probeWorker } from "./spawn.ts"
import { findKnownStale, staleCredentialReason } from "./stale-credential.ts"
import { SubagentStore } from "./store.ts"
import { createStreamState, parseStream } from "./stream.ts"
import { supervisorTick } from "./supervisor.ts"
import { type SubagentRecord, type SubagentStatus, sessionId, subagentId } from "./types.ts"

const testRender = renderFor("ma-sub-agents-plugin", `${import.meta.dirname}/..`)
const LEAD = sessionId("ba0ad20f-1111-4111-8111-111111111111")

const SID = "d0ea2058-1271-4ce8-8c8e-8cb895d8a56b"
const STALE = "anthropic-plan-oauth-2"

/** The stderr log of a real worker (2026-11-26) that got the stale name. */
const LOG = [
  `fatal: no usable credential "${STALE}" for provider "anthropic"`,
  "  Clear the credential name to use the default.",
  "  Sign in: minimal-agent provider anthropic login",
  "",
].join("\n")

/** The stream of the same worker: the old CLI text names no credential. */
const OLD_STREAM = [
  JSON.stringify({
    type: "error",
    message:
      'no credentials for provider "anthropic" (model "claude-opus-5-5"). Run minimal-agent provider anthropic login. No provider credentials found.',
    sessionId: SID,
    seq: 0,
    ts: 1795717696769,
  }),
  JSON.stringify({ type: "run_finished", outcome: "failed", sessionId: SID, seq: 1, ts: 1 }),
].join("\n")

/** A newer CLI writes the stderr summary as the stream message. */
const NEW_STREAM = [
  JSON.stringify({
    type: "error",
    message: `no usable credential "${STALE}" for provider "anthropic"`,
    sessionId: SID,
    seq: 0,
    ts: 1,
  }),
  JSON.stringify({ type: "run_finished", outcome: "failed", sessionId: SID, seq: 1, ts: 2 }),
].join("\n")

const TARGET = {
  pid: 1,
  resultPath: "/s/r.json",
  transcriptPath: "/s/t.jsonl",
  logPath: "/s/w.log",
  streamPath: "/s/w.stream.ndjson",
}

const never = (what: string) => () => {
  throw new Error(`must not ${what}`)
}

function deadProbe(over: Partial<ProbeDeps>): ProbeDeps {
  return { pidAlive: () => false, readResult: () => undefined, ...over }
}

const NOW = "2026-11-26T13:28:17.000Z"

function record(
  status: SubagentStatus = {
    kind: "running",
    pid: 1,
    startedAt: NOW,
    progress: { tools: 0, tokens: 0 },
  },
  id = "A1",
): SubagentRecord {
  return {
    id: subagentId(id),
    sid: sessionId(SID),
    label: "worker",
    type: "worker",
    model: "claude-opus-5-5",
    task: "t",
    isolation: "fresh",
    workspace: "inherit-cwd",
    spawnedAt: NOW,
    status,
    depth: 1,
    leadSid: LEAD,
  }
}

const runningRecord = (): SubagentRecord => record()

/** A failed worker of the fleet, with the given reason. */
const failed = (error: string, id = "A1"): SubagentRecord =>
  record({ kind: "failed", endedAt: NOW, error }, id)

describe("stale credential at worker boot", () => {
  it("names the stale credential from the log when the stream text does not", () => {
    const probe = probeWorker(
      TARGET,
      deadProbe({
        readStream: () => parseStream(OLD_STREAM),
        readCrash: () => extractCrashSignature(LOG),
      }),
    )
    expect(probe.runFailed).toContain(`"${STALE}"`)
    expect(probe.runFailed).toContain("is not stored any more")
    expect(probe.runFailed).toContain("Spawn again")
    expect(probe.runFailed).not.toContain("No provider credentials found")
  })

  it("names the stale credential from a newer stream text, with no log read", () => {
    const probe = probeWorker(
      TARGET,
      deadProbe({ readStream: () => parseStream(NEW_STREAM), readCrash: never("read the log") }),
    )
    expect(probe.runFailed?.startsWith(`credential "${STALE}" is not stored any more`)).toBe(true)
    expect(probe.runFailed).toContain('default "anthropic" credential')
    // The lead digest clips the reason at 160 characters: the next step must fit.
    expect((probe.runFailed ?? "").slice(0, 160)).toContain("Spawn again")
  })

  it("names the stale credential in the crash text when no stream line was written", () => {
    const probe = probeWorker(
      TARGET,
      deadProbe({
        readStream: () => createStreamState(),
        readCrash: () => extractCrashSignature(LOG),
      }),
    )
    expect(probe.runFailed).toBeUndefined()
    expect(probe.crash?.startsWith(`credential "${STALE}" is not stored any more`)).toBe(true)
  })

  it("puts the stale credential in the fleet status and in the lead digest", () => {
    const probe = probeWorker(
      TARGET,
      deadProbe({
        readStream: () => parseStream(OLD_STREAM),
        readCrash: () => extractCrashSignature(LOG),
      }),
    )
    const out = supervisorTick({
      records: [runningRecord()],
      probes: new Map([["A1", probe]]),
      now: NOW,
      nowMs: Date.parse(NOW),
    })
    const st = out.records[0]?.status
    expect(st?.kind).toBe("failed")
    expect(st?.kind === "failed" && st.error.startsWith(`credential "${STALE}"`)).toBe(true)
    const digest = out.effects.find((e) => e.type === "inject")
    expect(digest?.type === "inject" && digest.text).toContain(`credential "${STALE}"`)
  })

  it("keeps a credential failure that names no credential (the worker used the default)", () => {
    const text =
      'no credentials for provider "anthropic" (model "claude-opus-5-5"). Run minimal-agent provider anthropic login.'
    const probe = probeWorker(
      TARGET,
      deadProbe({
        readStream: () =>
          parseStream(
            [
              JSON.stringify({ type: "error", message: text, sessionId: SID, seq: 0, ts: 1 }),
              JSON.stringify({ type: "run_finished", outcome: "failed", sessionId: SID, seq: 1 }),
            ].join("\n"),
          ),
        readCrash: () =>
          extractCrashSignature(
            'fatal: no usable credentials for provider "anthropic" (model "claude-opus-5-5")',
          ),
      }),
    )
    expect(probe.runFailed).toBe(text)
  })

  it("keeps a failure that is not about a credential, and does not read the log", () => {
    const probe = probeWorker(
      TARGET,
      deadProbe({
        readStream: () =>
          parseStream(
            [
              JSON.stringify({ type: "error", message: "API 529: overloaded", seq: 0, ts: 1 }),
              JSON.stringify({ type: "run_finished", outcome: "failed", seq: 1, ts: 2 }),
            ].join("\n"),
          ),
        readCrash: never("read the log"),
      }),
    )
    expect(probe.runFailed).toBe("API 529: overloaded")
  })
})

describe("findKnownStale", () => {
  const reason = staleCredentialReason({ name: STALE, provider: "anthropic" })
  const hit = { name: STALE, provider: "anthropic" }

  it("finds a stale name in a failed record, for the same provider", () => {
    expect(findKnownStale([failed(reason)], STALE, "anthropic")).toEqual(hit)
    expect(findKnownStale([failed(reason)], STALE, undefined)).toEqual(hit)
  })

  it("does not match another name, another provider, or another failure", () => {
    expect(findKnownStale([failed(reason)], "anthropic-plan-oauth-3", "anthropic")).toBeUndefined()
    expect(findKnownStale([failed(reason)], STALE, "openai")).toBeUndefined()
    expect(findKnownStale([failed("API 529: overloaded")], STALE, "anthropic")).toBeUndefined()
    expect(findKnownStale([runningRecord()], STALE, "anthropic")).toBeUndefined()
  })

  it("reads a name with quotes and spaces back from the reason", () => {
    const odd = 'Anthropic Plan "work" (OAuth)'
    const r = staleCredentialReason({ name: odd, provider: "anthropic" })
    expect(findKnownStale([failed(r)], odd, "anthropic")).toEqual({
      name: odd,
      provider: "anthropic",
    })
  })
})

describe("spawnAgent with a stale inherited credential", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "subagents-stale-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function deps(over: Partial<ServiceDeps> = {}): ServiceDeps & {
    launched: string[][]
    envs: Record<string, string>[]
    warnings: string[]
  } {
    const launched: string[][] = []
    const envs: Record<string, string>[] = []
    const warnings: string[] = []
    let n = 0
    return {
      store: new SubagentStore(LEAD, { dir }),
      spawnDeps: {
        launch: (argv, opts) => {
          launched.push([...argv])
          envs.push(opts.env)
          return 6000 + launched.length
        },
      },
      agentBin: ["minimal-agent"],
      leadSid: LEAD,
      depth: 0,
      cwd: "/repo",
      sessionsDir: dir,
      defaultModel: "claude-opus-5-5",
      newSid: () => `9c1a4f2e-0b3d-4a6c-8e1f-2d3c4b5a69${String(++n).padStart(2, "0")}`,
      now: () => new Date(NOW),
      renderPrompt: testRender,
      resolveProvider: () => "anthropic",
      leadProvider: "anthropic",
      defaultCredentialName: STALE,
      // A live policy snapshot, so the only warning is the credential one.
      queryHostPolicy: () => ({ activeModeId: null, modes: [], tools: { kind: "all" } }),
      warn: (msg) => warnings.push(msg),
      launched,
      envs,
      warnings,
      ...over,
    }
  }

  /** Put one failed worker with the stale-credential reason in the fleet. */
  function seedStale(d: ServiceDeps): void {
    d.store.upsert({ ...failed(staleCredentialReason({ name: STALE, provider: "anthropic" })) })
  }

  it("drops the stale inherited name, warns, and records the fallback", async () => {
    const d = deps()
    seedStale(d)
    const r = await spawnAgent({ task: "work" }, d)
    expect(r.ok).toBe(true)
    expect(d.launched[0]).not.toContain("--credential-name")
    expect(d.launched[0]).not.toContain(STALE)
    // The lead env value cannot carry the stale name to the worker.
    expect(d.envs[0]?.MINIMAL_AGENT_CREDENTIAL_NAME).toBe("")
    expect(d.warnings).toEqual([
      `The sub-agent does not get \`--credential-name ${STALE}\` from the lead, because that name is not stored at this time. It uses the default \`anthropic\` auth. To stop this message, set the lead to a stored name.`,
    ])
    expect(r.ok && r.value.credentialFallback).toEqual({ from: STALE, provider: "anthropic" })
  })

  it("keeps a stored inherited name (no failure in the fleet names it)", async () => {
    const d = deps()
    d.store.upsert(failed("API 529: overloaded"))
    const r = await spawnAgent({ task: "work" }, d)
    expect(r.ok).toBe(true)
    const argv = d.launched[0] ?? []
    expect(argv[argv.indexOf("--credential-name") + 1]).toBe(STALE)
    expect(d.envs[0]).not.toHaveProperty("MINIMAL_AGENT_CREDENTIAL_NAME")
    expect(d.warnings).toEqual([])
    expect(r.ok && r.value.credentialFallback).toBeUndefined()
  })

  it("keeps an explicit per-spawn credential as is, also a known stale one", async () => {
    const d = deps()
    seedStale(d)
    const r = await spawnAgent({ task: "work", credentialName: STALE }, d)
    expect(r.ok).toBe(true)
    const argv = d.launched[0] ?? []
    expect(argv[argv.indexOf("--credential-name") + 1]).toBe(STALE)
    expect(r.ok && r.value.credentialFallback).toBeUndefined()
  })

  it("keeps an explicit per-spawn credential that differs from the lead", async () => {
    const d = deps()
    const r = await spawnAgent({ task: "work", credentialName: "work-account" }, d)
    expect(r.ok).toBe(true)
    const argv = d.launched[0] ?? []
    expect(argv[argv.indexOf("--credential-name") + 1]).toBe("work-account")
  })
})
