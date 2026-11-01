/**
 * Integration tests for the four tool handlers end-to-end. These build a real
 * TUIContext pointed at a tmp sessions dir, run actual (fast) jobs through the
 * real runner, and assert on the model-facing content + the persisted index.
 *
 * The registry is a module singleton, so each test resets it to stay isolated.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { resetRegistryForTests } from "../lib/registry.ts"
import { BgJobStore } from "../lib/store.ts"

import bgLogs from "./bg_logs.ts"
import bgRun from "./bg_run.ts"
import bgStatus from "./bg_status.ts"
import bgStop from "./bg_stop.ts"

const PKG = join(import.meta.dir, "..")
const SID = "test-session"
/** How long a test polls for a job to finish. Under load the runner can take seconds. */
const POLL_DEADLINE_MS = 15_000
/** The test timeout must be longer than the poll deadline, or the deadline never applies. */
const TEST_TIMEOUT_MS = 20_000

let sessionsRoot: string
beforeEach(() => {
  resetRegistryForTests()
  sessionsRoot = mkdtempSync(join(tmpdir(), "bghandlers-"))
})
afterEach(() => {
  rmSync(sessionsRoot, { recursive: true, force: true })
})

function ctx(toolInput: Record<string, unknown>, cwd = sessionsRoot) {
  return {
    trigger: { type: "tool" as const, name: "X", input: toolInput },
    packageDir: PKG,
    cwd,
    env: {
      ...process.env,
      MINIMAL_AGENT_HOME: sessionsRoot, // sessions dir -> <root>/sessions
    } as Record<string, string>,
    abort: new AbortController().signal,
    stdout: process.stdout,
    stdin: process.stdin,
    stderr: process.stderr,
    agent: { sessionId: SID, pid: process.pid, model: "test", version: "0.0.0" },
  }
}

function store(): BgJobStore {
  return new BgJobStore(SID, { sessionsDir: join(sessionsRoot, "sessions") })
}

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true
    await Bun.sleep(50)
  }
  return pred()
}

/** Poll until a job reaches a terminal state, driving reconcile each tick. */
async function waitTerminal(id: string, timeoutMs = POLL_DEADLINE_MS): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await bgStatus(ctx({ id })) // a status call runs the reconcile pass
    const s = store().get(id)?.status.kind
    if (s && s !== "running") return true
    await Bun.sleep(50)
  }
  return store().get(id)?.status.kind !== "running"
}

function contentOf(r: { content: string }): string {
  return r.content
}

describe("BackgroundRun", () => {
  test("starts a job and persists a running record", async () => {
    const res = await bgRun(ctx({ command: "echo hello" }))
    expect(res.kind).toBe("tool_result")
    if (res.kind === "tool_result") {
      expect(res.is_error).toBeFalsy()
      expect(contentOf(res)).toContain("Started background job j1")
    }
    const recs = store().all()
    expect(recs.length).toBe(1)
    expect(String(recs[0].id)).toBe("j1")
  })

  test("rejects empty command", async () => {
    const res = await bgRun(ctx({ command: "   " }))
    if (res.kind === "tool_result") expect(res.is_error).toBe(true)
  })

  test("honors a custom timeout string", async () => {
    await bgRun(ctx({ command: "echo hi", timeout: "30s" }))
    expect(store().all()[0].timeoutMs).toBe(30_000)
  })
})

describe("BackgroundStatus", () => {
  test(
    "reconciles a finished job to exited",
    async () => {
      await bgRun(ctx({ command: "echo done" }))
      // Only a status call runs the reconcile pass. A fixed sleep and then one
      // status call failed under load: the job was still running at that one
      // pass, and nothing reconciled it later. Drive a pass on each poll.
      expect(await waitTerminal("j1")).toBe(true)
      const res = await bgStatus(ctx({ id: "j1" }))
      expect(res.kind).toBe("tool_result")
      if (res.kind === "tool_result") expect(res.content).toContain("j1")
      expect(store().get("j1")?.status.kind).toBe("exited")
    },
    TEST_TIMEOUT_MS,
  )

  test("reports all jobs when no id", async () => {
    await bgRun(ctx({ command: "echo a" }))
    await bgRun(ctx({ command: "echo b" }))
    const res = await bgStatus(ctx({}))
    if (res.kind === "tool_result") {
      expect(res.content).toContain("background job")
      expect(res.content).toContain("j1")
      expect(res.content).toContain("j2")
    }
  })

  test("unknown id errors", async () => {
    const res = await bgStatus(ctx({ id: "j99" }))
    if (res.kind === "tool_result") expect(res.is_error).toBe(true)
  })
})

describe("BackgroundLogs", () => {
  test(
    "returns captured output after completion",
    async () => {
      await bgRun(ctx({ command: "echo log-line-here" }))
      expect(await waitTerminal("j1")).toBe(true)
      const res = await bgLogs(ctx({ id: "j1" }))
      if (res.kind === "tool_result") {
        expect(res.content).toContain("log-line-here")
        expect(res.content).toContain("byte cursor")
      }
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "body renders on display lines, summary on the footer",
    async () => {
      await bgRun(ctx({ command: "echo body-visible-in-display" }))
      expect(await waitTerminal("j1")).toBe(true)
      const res = await bgLogs(ctx({ id: "j1" }))
      if (res.kind === "tool_result") {
        // Regression: display used to be only the dim summary, dropping the body
        // in the terminal even though content carried it. The body belongs on the
        // │ display lines; the summary belongs on the ╰ footer.
        const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "")
        expect(res.display).toBeDefined()
        const display = stripAnsi(res.display ?? "")
        expect(display).toContain("body-visible-in-display")
        expect(display).not.toContain("shown")

        expect(res.displayFooter).toBeDefined()
        const footer = stripAnsi(res.displayFooter ?? "")
        expect(footer).toContain("shown")
        expect(footer).toContain("cursor")
      }
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "grep filters log lines",
    async () => {
      await bgRun(ctx({ command: "printf 'a\\nb\\nerror x\\nc\\n'" }))
      // A fixed sleep failed under load: the runner had not written the log yet.
      expect(await waitTerminal("j1")).toBe(true)
      const res = await bgLogs(ctx({ id: "j1", grep: "error" }))
      if (res.kind === "tool_result") {
        expect(res.content).toContain("error x")
        expect(res.content).not.toContain("\nb\n")
      }
    },
    TEST_TIMEOUT_MS,
  )

  test("unknown id errors", async () => {
    const res = await bgLogs(ctx({ id: "nope" }))
    if (res.kind === "tool_result") expect(res.is_error).toBe(true)
  })
})

describe("BackgroundStop", () => {
  test("stops a running job", async () => {
    await bgRun(ctx({ command: "sleep 30" }))
    expect(await waitFor(() => store().get("j1")?.status.kind === "running", 2000)).toBe(true)
    const res = await bgStop(ctx({ id: "j1" }))
    if (res.kind === "tool_result") {
      expect(res.is_error).toBeFalsy()
      expect(res.content).toContain("Stopped job j1")
    }
    expect(store().get("j1")?.status.kind).toBe("stopped")
  }, 10000)

  test(
    "stop on an already-finished job is a no-op",
    async () => {
      await bgRun(ctx({ command: "echo quick" }))
      expect(await waitTerminal("j1")).toBe(true)
      const res = await bgStop(ctx({ id: "j1" }))
      if (res.kind === "tool_result") {
        expect(res.content).toContain("already")
      }
    },
    TEST_TIMEOUT_MS,
  )

  test("stop all with no jobs reports nothing to stop", async () => {
    const res = await bgStop(ctx({}))
    if (res.kind === "tool_result") expect(res.content).toContain("Nothing to stop")
  })
})
