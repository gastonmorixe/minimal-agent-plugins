/**
 * Task tool tests for the API-simplify rollout (coerce, hard-error re-done,
 * compact acks, hash-only model content).
 * Split from `task_tool.test.ts` to stay under the repo max-lines lint budget.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { TUIContext, TUIResult } from "../lib/host-types.ts"
import { TaskStore } from "../lib/store.ts"

import taskToolHandler from "./task_tool.ts"

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

let tmpHome: string
const sid = "task-tool-test-sid"

function ctx(input: Record<string, unknown>, env: Record<string, string> = {}): TUIContext {
  return {
    trigger: { type: "tool", name: "Task", input, tool_use_id: "test_id" },
    packageDir: "/tmp/fake-package-dir",
    cwd: "/tmp/fake-cwd",
    env: { HOME: tmpHome, MINIMAL_AGENT_SESSION_ID: sid, ...env },
    abort: new AbortController().signal,
    stdout: process.stdout,
    stdin: process.stdin,
    stderr: process.stderr,
    log: { info() {}, warn() {}, error() {}, debug() {} } as never,
  }
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "tasks-handler-"))
})

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true })
})

type ToolResult = Extract<TUIResult, { kind: "tool_result" }>

async function call(
  input: Record<string, unknown>,
  env: Record<string, string> = {},
): Promise<ToolResult> {
  const r = await taskToolHandler(ctx(input, env))
  if (r.kind !== "tool_result") throw new Error(`expected tool_result, got ${r.kind}`)
  return r
}

// ---------------------------------------------------------------------------
// coerce stringified arrays + hallucinated ids
// ---------------------------------------------------------------------------

describe("coerce stringified JSON arrays", () => {
  test("add_many accepts stringified items (session 1c59e35a smoking gun)", async () => {
    const items = JSON.stringify([
      { title: "Phase 1: Inventory source material", children: ["a", "b"] },
      { title: "Phase 2: Ship" },
    ])
    const r = await call({ action: "add_many", items })
    expect(r.is_error).toBeUndefined()
    expect(r.content).toContain("OK added_many")
    expect(r.content).toContain("coerced=items")
    expect(r.content).toContain("Phase 1")
    expect(r.content).toContain("Phase 2")
    const store = new TaskStore(sid, { home: tmpHome })
    expect(store.list().filter((t) => t.parent === null)).toHaveLength(2)
  })

  test("add_many accepts stringified titles", async () => {
    const r = await call({
      action: "add_many",
      titles: JSON.stringify(["one", "two"]),
    })
    expect(r.is_error).toBeUndefined()
    expect(r.content).toContain("coerced=titles")
    expect(r.content).toContain("todo      one")
  })

  test("rejects stringified items that are not an array", async () => {
    const r = await call({
      action: "add_many",
      items: JSON.stringify({ title: "x" }),
    })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/stringified non-array|parsed to object/)
  })
})

describe("hallucinated digit ids", () => {
  test("long digit string gets a made-up-number hint", async () => {
    await call({ action: "add", title: "x" })
    const r = await call({ action: "done", id: "76310000000" })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/not found/)
    expect(r.content).toMatch(/current id/)
  })

  test("6-digit invented id also hints at #hash from board", async () => {
    await call({ action: "add", title: "x" })
    const r = await call({ action: "done", id: "864232" })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/not found.*current id/)
  })
})

describe("plain-text mutation results", () => {
  test("done (not all_done) returns a compact OK ack by default", async () => {
    await call({
      action: "add_many",
      items: [{ title: "Phase", children: ["a", "b"] }],
    })
    await call({ action: "add", title: "other" }) // keep plan open
    const store = new TaskStore(sid, { home: tmpHome })
    const parent = store.list().find((t) => t.parent === null && t.title === "Phase")!
    await call({ action: "done", id: `#${parent.id}a` })
    const r = await call({ action: "done", id: `#${parent.id}b` })
    expect(r.is_error).toBeUndefined()
    expect(r.content).toContain("OK marked_done")
    expect(r.content).toContain(`parent_auto_done=${parent.id}`)
    expect(r.content).toMatch(/^OK /)
    expect(r.content).not.toContain("<ma::agent::")
    expect(r.content).not.toContain("Phase")
    expect(store.list().find((t) => t.id === parent.id)!.status).toBe("done")
  })

  test("full-results env includes the updated board for start, done, and status", async () => {
    const env = { MINIMAL_AGENT_TASKS_FULL_RESULTS: "1" }
    await call({ action: "add_many", tasks: [{ title: "Phase", children: ["work"] }] }, env)

    const started = await call({ action: "start", id: "1a" }, env)
    expect(started.content).toMatch(/^OK started[^\n]*\n/)
    expect(started.content).toContain("1   doing     Phase")
    expect(started.content).toContain("1a  doing     work")

    const status = await call({ action: "status", id: "1a", status: "todo" }, env)
    expect(status.content).toMatch(/^OK marked_todo[^\n]*\n/)
    expect(status.content).toContain("1a  todo      work")

    const done = await call({ action: "done", id: "1a" }, env)
    expect(done.content).toMatch(/^OK all_done[^\n]*\n/)
    expect(done.content).toContain("1   done      Phase")
    expect(done.content).toContain("1a  done      work")
  })

  test("full-results env also includes tasks in JSON status results", async () => {
    const env = { MINIMAL_AGENT_TASKS_FULL_RESULTS: "1" }
    await call({ action: "add", title: "work" }, env)
    const started = await call({ action: "start", id: 1, format: "json" }, env)
    const parsedStart = JSON.parse(started.content) as {
      result: string
      tasks: { id: string }[]
    }
    expect(parsedStart.result).toBe("started")
    expect(parsedStart.tasks.map((task) => task.id)).toEqual(["1"])

    const done = await call({ action: "done", id: 1, format: "json" }, env)
    const parsedDone = JSON.parse(done.content) as {
      result: string
      id: string
      tasks: { status: string }[]
    }
    expect(parsedDone).toMatchObject({ result: "all_done", id: "1" })
    expect(parsedDone.tasks.map((task) => task.status)).toEqual(["done"])
  })

  test("compact terminal status results omit the board in text and JSON", async () => {
    await call({ action: "add", title: "work" })
    const text = await call({ action: "status", id: 1, status: "done" })
    expect(text.content).toMatch(/^OK all_done[^\n]*$/)
    expect(text.content).not.toContain("done      work")

    await call({ action: "status", id: 1, status: "todo" })
    const json = await call({ action: "done", id: 1, format: "json" })
    const parsed = JSON.parse(json.content) as Record<string, unknown>
    expect(parsed).toMatchObject({ result: "all_done", id: "1" })
    expect(parsed).not.toHaveProperty("tasks")
  })

  test("values other than exactly 1 keep compact results", async () => {
    await call({ action: "add", title: "work" })
    const result = await call(
      { action: "start", id: 1 },
      { MINIMAL_AGENT_TASKS_FULL_RESULTS: "true" },
    )
    expect(result.content).not.toContain("doing     work")
  })
})

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// status / start / done
// ---------------------------------------------------------------------------

describe("status / start / done", () => {
  test("model content includes action/result/id attrs for a status transition", async () => {
    await call({ action: "add", title: "x" })
    const r = await call({ action: "status", id: 1, status: "doing" })
    expect(r.is_error).toBeUndefined()
    expect(r.content).toContain("action=status")
    expect(r.content).toContain("OK marked_doing")
    expect(r.content).toContain("id=")
    // Plain OK ack: no harness tags, no columnar board dump.
    expect(r.content).toMatch(/^OK /)
    expect(r.content).not.toContain("<ma::agent::")
    expect(r.content).not.toContain("doing     x")
    expect(r.content).not.toMatch(/\n1\s+#/)
    // Human TUI still shows the board.
    expect(r.display).toContain("x")
  })
  test("status sets the new state", async () => {
    await call({ action: "add", title: "x" })
    const r = await call({ action: "status", id: 1, status: "doing" })
    expect(r.is_error).toBeUndefined()
    expect(r.displayHeader).toContain("marked doing")
  })
  test("status=canceled records the reason", async () => {
    await call({ action: "add", title: "x" })
    const r = await call({
      action: "status",
      id: 1,
      status: "canceled",
      reason: "user redirected",
    })
    expect(r.is_error).toBeUndefined()
    expect(r.displayHeader).toContain("canceled")
    expect(r.display).toContain("user redirected")
    expect(r.content).toContain("OK marked_canceled")
    expect(r.content).toContain(`reason="user redirected"`)
    expect(r.content).not.toMatch(/\n1\s+#/)
  })
  test("start keeps previously started tasks as doing", async () => {
    await call({ action: "add", title: "one" })
    await call({ action: "add", title: "two" })
    await call({ action: "start", id: 1 })
    const r = await call({ action: "start", id: 2 })
    expect(r.is_error).toBeUndefined()
    const store = new TaskStore(sid, { home: tmpHome })
    const doings = store.list().filter((t) => t.status === "doing")
    expect(doings).toHaveLength(2)
    expect(doings.map((t) => t.title).sort()).toEqual(["one", "two"])
  })
  test("starting a subtask auto-starts its parent in tool output", async () => {
    await call({
      action: "add_many",
      items: [{ title: "Phase", children: ["child"] }],
    })
    const store = new TaskStore(sid, { home: tmpHome })
    const parent = store.list().find((t) => t.parent === null)!
    const r = await call({ action: "start", id: `#${parent.id}a` })
    expect(r.is_error).toBeUndefined()
    expect(store.list().find((t) => t.id === parent.id)!.status).toBe("doing")
    expect(r.content).toContain("OK started")
    expect(r.content).toContain(`id=${parent.id}a`)
    expect(r.content).toMatch(/^OK /)
    expect(r.content).not.toContain("<ma::agent::")
    // Human display still shows both parent + child as doing.
    expect(r.display).toContain("Phase")
    expect(r.display).toContain("child")
  })

  test("start parallel:true still accumulates (compat no-op)", async () => {
    await call({ action: "add", title: "one" })
    await call({ action: "add", title: "two" })
    await call({ action: "start", id: 1 })
    await call({ action: "start", id: 2, parallel: true })
    const store = new TaskStore(sid, { home: tmpHome })
    expect(store.list().filter((t) => t.status === "doing")).toHaveLength(2)
  })
  test("done is sugar for status=done", async () => {
    await call({ action: "add", title: "x" })
    // Add a second task so completing #1 doesn't trigger the 'ALL DONE' verb,
    // which has its own dedicated test below.
    await call({ action: "add", title: "y" })
    const r = await call({ action: "done", id: 1 })
    expect(r.is_error).toBeUndefined()
    expect(r.displayHeader).toContain("marked done")
  })
  test("done on the LAST remaining task triggers 'ALL DONE' verb", async () => {
    await call({ action: "add", title: "one" })
    await call({ action: "add", title: "two" })
    await call({ action: "done", id: 1 })
    const r = await call({ action: "done", id: 2 })
    expect(r.is_error).toBeUndefined()
    expect(r.displayHeader).toContain("ALL DONE")
  })

  test("last child done auto-promotes parent and can trigger ALL DONE", async () => {
    // Single parent + two children: finishing both children should roll the
    // parent up and leave the whole plan done → ALL DONE verb.
    await call({
      action: "add_many",
      items: [{ title: "Phase", children: ["a", "b"] }],
    })
    const store = new TaskStore(sid, { home: tmpHome })
    const parent = store.list().find((t) => t.parent === null)!
    await call({ action: "done", id: `#${parent.id}a` })
    expect(store.list().find((t) => t.id === parent.id)!.status).toBe("doing")
    const r = await call({ action: "done", id: `#${parent.id}b` })
    expect(r.is_error).toBeUndefined()
    expect(store.list().find((t) => t.id === parent.id)!.status).toBe("done")
    expect(r.displayHeader).toContain("ALL DONE")
  })

  test("parent done cascades open children", async () => {
    await call({
      action: "add_many",
      items: [{ title: "Phase", children: ["a", "b"] }],
    })
    // Keep a second top-level task so we don't hit ALL DONE and can assert
    // the cascade verb is still "marked done".
    await call({ action: "add", title: "other" })
    const store = new TaskStore(sid, { home: tmpHome })
    const parent = store.list().find((t) => t.title === "Phase")!
    const r = await call({ action: "done", id: `#${parent.id}` })
    expect(r.is_error).toBeUndefined()
    const kids = store.list().filter((t) => t.parent === parent.id)
    expect(kids).toHaveLength(2)
    expect(kids.every((t) => t.status === "done")).toBe(true)
  })

  test("re-done of already-done id is a hard error", async () => {
    await call({ action: "add", title: "solo" })
    const first = await call({ action: "done", id: 1 })
    expect(first.is_error).toBeUndefined()
    expect(first.content).toContain("OK all_done")
    expect(first.content).not.toContain("done      solo")

    const store = new TaskStore(sid, { home: tmpHome })
    const before = store.list()[0]!
    const second = await call({ action: "done", id: 1 })
    expect(second.is_error).toBe(true)
    expect(second.content).toMatch(/already done/i)
    expect(second.content).toContain(before.id)

    const after = new TaskStore(sid, { home: tmpHome }).list()[0]!
    expect(after.done_at).toBe(before.done_at)
    expect(after.active_ms).toBe(before.active_ms)
    expect(after.status).toBe("done")
  })

  test("Lisa path: last-child all_done then parent re-done is a hard error (auto-promoted)", async () => {
    // Repro of acee5759 dual ALL DONE frames: model done last child then
    // also done the parent in the same turn. Parent was already promoted.
    await call({
      action: "add_many",
      items: [{ title: "Phase", children: ["a", "b"] }],
    })
    const store = new TaskStore(sid, { home: tmpHome })
    const parent = store.list().find((t) => t.parent === null)!
    await call({ action: "done", id: `#${parent.id}a` })
    const lastChild = await call({ action: "done", id: `#${parent.id}b` })
    expect(lastChild.displayHeader).toContain("ALL DONE")
    expect(store.list().find((t) => t.id === parent.id)!.status).toBe("done")

    const parentAgain = await call({ action: "done", id: `#${parent.id}` })
    expect(parentAgain.is_error).toBe(true)
    expect(parentAgain.content).toMatch(/already done/i)
    expect(parentAgain.content).toMatch(/auto-promoted/i)
    expect(parentAgain.content).toContain(parent.id)
  })

  test("status→done on already-done id is a hard error", async () => {
    await call({ action: "add", title: "x" })
    await call({ action: "done", id: 1 })
    const r = await call({ action: "status", id: 1, status: "done" })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/already done/i)
  })

  test("already_done format:json is still a hard error (not soft JSON)", async () => {
    await call({ action: "add", title: "x" })
    await call({ action: "done", id: 1 })
    const r = await call({ action: "done", id: 1, format: "json" })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/already done/i)
    expect(() => JSON.parse(r.content!)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// update / remove / reorder / clear / list
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Model-facing columnar content
// ---------------------------------------------------------------------------

describe("model-facing content", () => {
  test("escapes tag-sensitive title text in plain tool content", async () => {
    const r = await call({ action: "add", title: 'use <x> & "quotes"' })
    expect(r.is_error).toBeUndefined()
    expect(r.content).toContain('use &lt;x&gt; &amp; "quotes"')
    expect(r.content).not.toContain("<ma::agent::")
  })

  test("default text content is not the TUI display without ANSI", async () => {
    const r = await call({ action: "add_many", titles: ["one", "two"] })
    expect(r.is_error).toBeUndefined()
    expect(r.content).toContain("OK added_many")
    expect(r.content).toContain("action=add_many")
    expect(r.content).toMatch(/^1\s+todo\s+one/m)
    expect(r.content).toContain("todo      one")
    expect(r.content).toMatch(/^2\s+todo\s+two/m)
    expect(r.content).toContain("todo      two")
    expect(r.content).not.toContain("+ added")
    expect(r.content).not.toContain("0 done · 0 doing")
    expect(r.displayHeader).toContain("added 2 tasks")
    expect(r.displayFooter).toContain("2 todo")
  })
})

// ---------------------------------------------------------------------------
// JSON format
// ---------------------------------------------------------------------------

describe("add_many and replace_plan policy", () => {
  test("top-level add_many is strictly additive", async () => {
    await call({ action: "add_many", titles: ["old A", "old B"] })
    const r = await call({
      action: "add_many",
      tasks: [{ title: "New phase", children: ["step"] }],
    })
    expect(r.is_error).toBeUndefined()
    expect(r.content).toContain("old A")
    expect(r.content).toContain("New phase")
    const store = new TaskStore(sid, { home: tmpHome })
    expect(store.list().map((x) => x.title)).toEqual(["old A", "old B", "New phase", "step"])
  })

  test("replace_plan explicitly and atomically replaces the board", async () => {
    await call({ action: "add_many", titles: ["old A", "old B"] })
    const r = await call({
      action: "replace_plan",
      tasks: [{ title: "New phase", children: ["step"] }],
    })
    expect(r.is_error).toBeUndefined()
    expect(r.content).toMatch(/^OK replaced_plan .*\breplaced=2\b/)
    expect(r.content).not.toContain("old A")
    expect(new TaskStore(sid, { home: tmpHome }).list().map((x) => x.title)).toEqual([
      "New phase",
      "step",
    ])
  })

  test("parent-scoped add_many does not replace the board", async () => {
    await call({ action: "add", title: "parent" })
    const store = new TaskStore(sid, { home: tmpHome })
    const parent = store.list()[0]!
    await call({
      action: "add_many",
      titles: ["kid"],
      parent: `#${parent.id}`,
    })
    expect(new TaskStore(sid, { home: tmpHome }).list().map((x) => x.title)).toEqual([
      "parent",
      "kid",
    ])
  })
})
