/**
 * Handler-level integration: drive the CronCreate / CronList / CronDelete
 * tool handlers with a constructed context and a redirected store dir,
 * asserting the full create → list → delete flow + validation + the
 * disable gate.
 *
 * @module schedule/integration.test
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import cronCreate from "./handlers/cron_create.ts"
import cronDelete from "./handlers/cron_delete.ts"
import cronList from "./handlers/cron_list.ts"
import cronReschedule from "./handlers/cron_reschedule.ts"
import { due, nextFireMs } from "./lib/scheduler.ts"
import { type CronEntry, CronStore } from "./lib/store.ts"

/**
 * Local structural mirror of the host's `tool_result` TUIResult variant.
 * Plugins must not import src/ (plugin-decoupling invariant I1); the
 * handler results are structurally compatible with this shape.
 */
type ToolResult = {
  kind: "tool_result"
  content: string
  is_error?: boolean
  display?: string
  displayFooter?: string
}

/** Narrow a handler result to the `tool_result` variant (throws otherwise). */
function asTool(r: { kind: string }): ToolResult {
  if (r.kind !== "tool_result") throw new Error(`expected tool_result, got ${r.kind}`)
  return r as ToolResult
}

let dir: string
const SID = "integ-session"

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ma-sched-integ-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Minimal TUIContext for a tool call. */
function ctx(input: Record<string, unknown>, env: Record<string, string> = {}) {
  return {
    trigger: { type: "tool" as const, name: "X", input, tool_use_id: "t1" },
    packageDir: "/tmp",
    cwd: "/tmp",
    env: { MINIMAL_AGENT_CRON_DIR: dir, ...env },
    abort: new AbortController().signal,
    stdout: process.stdout,
    stdin: process.stdin,
    stderr: process.stderr,
    log: { info() {}, warn() {}, error() {}, debug() {} } as never,
    agent: { sessionId: SID, pid: 1, model: "m", version: "0" },
  }
}

describe("CronCreate", () => {
  it("creates from an interval and persists", async () => {
    const r = asTool(await cronCreate(ctx({ every: "5m", prompt: "check deploy" })))
    expect(r.is_error).toBeUndefined()
    expect(r.content).toContain("Scheduled task")
    expect(new CronStore(SID, { dir }).count()).toBe(1)
  })

  it("creates from a raw cron", async () => {
    const r = asTool(await cronCreate(ctx({ cron: "0 9 * * 1-5", prompt: "morning report" })))
    expect(r.is_error).toBeUndefined()
    const e = new CronStore(SID, { dir }).load()[0]
    expect(e?.cron).toBe("0 9 * * 1-5")
  })

  it("creates a one-shot with a future fire time", async () => {
    const r = asTool(await cronCreate(ctx({ cron: "30 14 15 3 *", prompt: "push", recurs: false })))
    expect(r.is_error).toBeUndefined()
    const e = new CronStore(SID, { dir }).load()[0]
    expect(e?.recurs).toBe(false)
    expect(typeof e?.nextAtMs).toBe("number")
  })

  it("rejects missing prompt / bad cron / no schedule", async () => {
    expect(asTool(await cronCreate(ctx({ every: "5m" }))).is_error).toBe(true)
    expect(asTool(await cronCreate(ctx({ cron: "not cron", prompt: "p" }))).is_error).toBe(true)
    expect(asTool(await cronCreate(ctx({ prompt: "p" }))).is_error).toBe(true)
  })

  it("honors the disable gate", async () => {
    const r = asTool(
      await cronCreate(ctx({ every: "5m", prompt: "p" }, { MINIMAL_AGENT_DISABLE_CRON: "1" })),
    )
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("disabled")
  })
})

describe("CronList + CronDelete", () => {
  it("lists created tasks and deletes by id", async () => {
    await cronCreate(ctx({ every: "5m", prompt: "task one" }))
    await cronCreate(ctx({ cron: "0 9 * * *", prompt: "task two" }))

    const listed = asTool(await cronList(ctx({})))
    expect(listed.content).toContain("task one")
    expect(listed.content).toContain("task two")

    const id = new CronStore(SID, { dir }).load()[0]?.id as string
    const del = asTool(await cronDelete(ctx({ id })))
    expect(del.is_error).toBeUndefined()
    expect(del.content).toContain("Canceled")
    expect(new CronStore(SID, { dir }).count()).toBe(1)

    // Deleting an unknown id errors.
    const bad = asTool(await cronDelete(ctx({ id: "zzzzzzzz" })))
    expect(bad.is_error).toBe(true)
  })

  it("lists empty cleanly", async () => {
    const listed = asTool(await cronList(ctx({})))
    expect(listed.content).toContain("No scheduled tasks")
  })
})

describe("CronReschedule", () => {
  it("nextAtMs alone keeps a cron task on its cron cadence", async () => {
    await cronCreate(ctx({ cron: "*/5 * * * *", prompt: "poll" }))
    const before = new CronStore(SID, { dir }).load()[0] as CronEntry
    const at = Date.now() + 10 * 60_000
    const r = asTool(await cronReschedule(ctx({ id: before.id, nextAtMs: at })))
    expect(r.is_error).toBeUndefined()
    expect(r.content).toContain("back on its schedule")

    const e = new CronStore(SID, { dir }).load()[0] as CronEntry
    expect(e).toMatchObject({ pace: "fixed", cron: "*/5 * * * *", nextAtMs: at })
    expect(e.intervalMs).toBeUndefined()

    // It fires once at nextAtMs, then the next fire comes from the cron.
    const d = due([e], at)
    expect(d.fire.map((x) => x.id)).toEqual([e.id])
    const after = d.mutated?.[0] as CronEntry
    expect(after.pace).toBe("fixed")
    expect(after.nextAtMs).toBeUndefined()
    const next = nextFireMs(after, at + 1) as number
    expect(new Date(next).getMinutes() % 5).toBe(0)
    expect(next - at).toBeLessThanOrEqual(5 * 60_000)
  })

  it("every switches to the dynamic pace and re-arms by the new interval", async () => {
    await cronCreate(ctx({ cron: "*/5 * * * *", prompt: "poll" }))
    const id = (new CronStore(SID, { dir }).load()[0] as CronEntry).id
    const t0 = Date.now()
    const r = asTool(await cronReschedule(ctx({ id, every: "30s" })))
    expect(r.is_error).toBeUndefined()

    let e = new CronStore(SID, { dir }).load()[0] as CronEntry
    expect(e).toMatchObject({ pace: "dynamic", intervalMs: 30_000, label: "30s" })
    expect(e.nextAtMs as number).toBeGreaterThanOrEqual(t0 + 30_000)

    const start = e.nextAtMs as number
    const fires: number[] = []
    for (let t = start; fires.length < 3; t += 1000) {
      const d = due([e], t)
      if (d.fire.length > 0) fires.push(t)
      if (d.mutated) e = d.mutated[0] as CronEntry
    }
    expect(fires).toEqual([start, start + 30_000, start + 60_000])
  })

  it("nextAtMs on a dynamic task keeps its own interval", async () => {
    await cronCreate(ctx({ every: "20s", prompt: "tail" }))
    const id = (new CronStore(SID, { dir }).load()[0] as CronEntry).id
    const at = Date.now() + 120_000
    await cronReschedule(ctx({ id, nextAtMs: at }))
    const e = new CronStore(SID, { dir }).load()[0] as CronEntry
    expect(e).toMatchObject({ pace: "dynamic", intervalMs: 20_000, nextAtMs: at })
    expect(due([e], at).mutated?.[0]?.nextAtMs).toBe(at + 20_000)
  })
})
