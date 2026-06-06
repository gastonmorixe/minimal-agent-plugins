/**
 * Integration test for the heartbeat slot: it should reconcile a finished job
 * and emit a `prompt.inject` completion digest on the bus, and render a widget
 * while a job is running.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { resetRegistryForTests } from "../lib/registry.ts"
import { BgJobStore } from "../lib/store.ts"

import bgRun from "./bg_run.ts"
import heartbeat from "./heartbeat.ts"

const PKG = join(import.meta.dir, "..")
const SID = "hb-session"

let root: string
beforeEach(() => {
  resetRegistryForTests()
  root = mkdtempSync(join(tmpdir(), "bghb-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function env(): Record<string, string> {
  return { ...process.env, MINIMAL_AGENT_HOME: root } as Record<string, string>
}

function runCtx(command: string) {
  return {
    trigger: { type: "tool" as const, name: "BackgroundRun", input: { command } },
    packageDir: PKG,
    cwd: root,
    env: env(),
    abort: new AbortController().signal,
    stdout: process.stdout,
    stdin: process.stdin,
    stderr: process.stderr,
    agent: { sessionId: SID, pid: process.pid, model: "t", version: "0" },
  }
}

function slotCtx(emits: Array<{ channel: string; payload: unknown }>, tick = 0) {
  return {
    packageDir: PKG,
    cwd: root,
    env: env(),
    abort: new AbortController().signal,
    stderr: process.stderr,
    tick,
    emit: (channel: string, payload?: unknown) => emits.push({ channel, payload }),
    agent: { sessionId: SID, pid: process.pid, model: "t", version: "0" },
  }
}

function store(): BgJobStore {
  return new BgJobStore(SID, { sessionsDir: join(root, "sessions") })
}

describe("heartbeat", () => {
  test("disabled by env returns null", async () => {
    const out = await heartbeat({
      ...slotCtx([]),
      env: { ...env(), MINIMAL_AGENT_DISABLE_BGJOBS: "1" },
    })
    expect(out).toBeNull()
  })

  test("emits a completion digest when a job finishes", async () => {
    await bgRun(runCtx("echo finished-now"))
    await Bun.sleep(400) // let the job exit + sidecar settle

    const emits: Array<{ channel: string; payload: unknown }> = []
    // Tick until the digest is injected (or a bounded number of tries).
    let injected = false
    for (let i = 0; i < 40 && !injected; i++) {
      await heartbeat(slotCtx(emits, i))
      injected = emits.some((e) => e.channel === "prompt.inject")
      if (!injected) await Bun.sleep(25)
    }
    expect(injected).toBe(true)
    const digest = emits.find((e) => e.channel === "prompt.inject")
    expect(JSON.stringify(digest?.payload)).toContain("j1")
    expect(store().get("j1")?.status.kind).toBe("exited")
  })

  test("renders a widget while a job runs, null when idle", async () => {
    // idle first
    const idle = await heartbeat(slotCtx([]))
    expect(idle).toBeNull()

    await bgRun(runCtx("sleep 2"))
    const running = await heartbeat(slotCtx([], 3))
    expect(typeof running).toBe("string")
    expect(running ?? "").toContain("running")
  }, 10000)
})
