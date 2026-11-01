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
/** How long a test polls for a job to finish. Under load the runner can take seconds. */
const POLL_DEADLINE_MS = 15_000
/** The test timeout must be longer than the poll deadline, or the deadline never applies. */
const TEST_TIMEOUT_MS = 20_000

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

  test(
    "emits a completion digest when a job finishes",
    async () => {
      await bgRun(runCtx("echo finished-now"))
      // Only a heartbeat pass reconciles the job and injects the digest. A fixed
      // sleep plus a fixed count of short polls (about 1.4 s in all) failed under
      // load: the runner had not finished yet. Poll to a deadline instead, and
      // run one heartbeat pass on each poll.
      const emits: Array<{ channel: string; payload: unknown }> = []
      let injected = false
      const start = Date.now()
      for (let i = 0; !injected && Date.now() - start < POLL_DEADLINE_MS; i++) {
        await heartbeat(slotCtx(emits, i))
        injected = emits.some((e) => e.channel === "prompt.inject")
        if (!injected) await Bun.sleep(50)
      }
      expect(injected).toBe(true)
      const digest = emits.find((e) => e.channel === "prompt.inject")
      expect(JSON.stringify(digest?.payload)).toContain("j1")
      expect(store().get("j1")?.status.kind).toBe("exited")
    },
    TEST_TIMEOUT_MS,
  )

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
