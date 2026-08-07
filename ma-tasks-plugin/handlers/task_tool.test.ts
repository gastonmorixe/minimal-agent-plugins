/**
 * Task tool handler tests (core actions).
 * API-simplify suites live in `task_tool.api-simplify.test.ts` (max-lines split).
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

function ctx(input: Record<string, unknown>): TUIContext {
  return {
    trigger: { type: "tool", name: "Task", input, tool_use_id: "test_id" },
    packageDir: "/tmp/fake-package-dir",
    cwd: "/tmp/fake-cwd",
    env: { HOME: tmpHome, MINIMAL_AGENT_SESSION_ID: sid },
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

async function call(input: Record<string, unknown>): Promise<ToolResult> {
  const r = await taskToolHandler(ctx(input))
  if (r.kind !== "tool_result") throw new Error(`expected tool_result, got ${r.kind}`)
  return r
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("validation", () => {
  test("rejects unknown action", async () => {
    const r = await call({ action: "bogus" })
    expect(r.kind).toBe("tool_result")
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/`action` must be one of/)
  })
  test("rejects missing required field", async () => {
    const r = await call({ action: "add" })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/`title` is required/)
  })
  test("rejects empty title", async () => {
    const r = await call({ action: "add", title: "   " })
    expect(r.is_error).toBe(true)
  })
  test("rejects non-string id (other than positive int)", async () => {
    const r1 = await call({ action: "done", id: 0 })
    expect(r1.is_error).toBe(true)
    const r2 = await call({ action: "done", id: "" })
    expect(r2.is_error).toBe(true)
  })
  test("rejects empty array for titles or order", async () => {
    const r1 = await call({ action: "add_many", titles: [] })
    expect(r1.is_error).toBe(true)
    const r2 = await call({ action: "reorder", order: [] })
    expect(r2.is_error).toBe(true)
  })
  test("rejects add_many without tasks, titles, or items", async () => {
    const r = await call({ action: "add_many" })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/tasks/)
    expect(r.content).toMatch(/titles/)
    expect(r.content).toMatch(/items/)
  })
  test("rejects add_many with both titles and items", async () => {
    const r = await call({
      action: "add_many",
      titles: ["a"],
      items: [{ title: "b" }],
    })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/mutually exclusive/)
  })
  test("rejects add_many with both tasks and titles", async () => {
    const r = await call({
      action: "add_many",
      tasks: [{ title: "a" }],
      titles: ["b"],
    })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/mutually exclusive/)
  })
  test("rejects add_many with both tasks and items", async () => {
    const r = await call({
      action: "add_many",
      tasks: [{ title: "a" }],
      items: [{ title: "b" }],
    })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/mutually exclusive/)
  })
  test("rejects items combined with parent", async () => {
    const r = await call({
      action: "add_many",
      parent: 1,
      items: [{ title: "a", children: ["b"] }],
    })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/parent.*(?:tasks|items)|(?:tasks|items).*parent/)
    expect(r.content).toMatch(/top-level|subtasks.*children/)
  })
  test("rejects empty items array", async () => {
    const r = await call({ action: "add_many", items: [] })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/`items`/)
  })
  test("rejects items entry without title", async () => {
    const r = await call({ action: "add_many", items: [{ children: ["x"] }] })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/title/)
  })
  test("accepts empty children array on items entry (treated as absent)", async () => {
    const r = await call({ action: "add_many", items: [{ title: "a", children: [] }] })
    expect(r.is_error).toBeFalsy()
    // Should create one task (the parent) with no children.
    const store = new TaskStore(sid, { home: tmpHome })
    const tasks = store.list()
    expect(tasks.length).toBe(1)
    expect(tasks[0].title).toBe("a")
    expect(tasks[0].parent).toBeNull()
  })
  test("rejects non-string children on items entry", async () => {
    const r = await call({
      action: "add_many",
      items: [{ title: "a", children: [{ title: "nested" }] }],
    })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/children/)
  })
  test("rejects unknown keys on items entry", async () => {
    const r = await call({
      action: "add_many",
      items: [{ title: "a", status: "done" }],
    })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/unknown key "status"|only accepts/)
  })
  test("rejects after with add_many", async () => {
    const r = await call({
      action: "add_many",
      titles: ["a"],
      after: 1,
    })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/`after`/)
  })
  test("rejects items on non-add_many actions", async () => {
    const r = await call({ action: "list", items: [{ title: "x" }] })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/items.*add_many|only valid for action="add_many"/)
  })
  test("rejects more than 26 children on items before any write", async () => {
    const kids = Array.from({ length: 27 }, (_, i) => `c${i}`)
    const r = await call({
      action: "add_many",
      items: [{ title: "parent", children: kids }],
    })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/max 26|26 subtasks/)
    const store = new TaskStore(sid, { home: tmpHome })
    expect(store.list()).toEqual([])
  })
  test("treats titles:null as absent (add_many fires XOR error, not titles-type error)", async () => {
    const r = await call({ action: "add_many", titles: null })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/tasks/)
    expect(r.content).toMatch(/titles|items/)
    expect(r.content).not.toMatch(/non-empty array/)
  })
  test("treats items:null as absent (add_many fires XOR error, not items-type error)", async () => {
    const r = await call({ action: "add_many", items: null })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/tasks/)
    expect(r.content).toMatch(/titles|items/)
    expect(r.content).not.toMatch(/non-empty array/)
  })
  test("treats id:null as absent on done (fires required-field error, not id-type error)", async () => {
    const r = await call({ action: "done", id: null })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/`id` is required/)
    expect(r.content).not.toMatch(/non-empty string/)
  })
  test("treats title:null as absent on add (fires required-field error, not title-type error)", async () => {
    const r = await call({ action: "add", title: null })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/`title` is required/)
    expect(r.content).not.toMatch(/non-empty string/)
  })
  test("treats order:null as absent on reorder (fires required-field error, not order-type error)", async () => {
    const r = await call({ action: "reorder", order: null })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/`order` is required/)
    expect(r.content).not.toMatch(/non-empty array/)
  })
  test("rejects titles with non-string element (number)", async () => {
    const r = await call({ action: "add_many", titles: [1] })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/every entry in `titles` must be a non-empty string/)
  })
  test("rejects titles with non-string element (object)", async () => {
    const r = await call({ action: "add_many", titles: [{ title: "x" }] })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/every entry in `titles` must be a non-empty string/)
  })
  test("rejects titles with empty string element", async () => {
    const r = await call({ action: "add_many", titles: [""] })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/every entry in `titles` must be a non-empty string/)
  })
  test("rejects titles with whitespace-only element", async () => {
    const r = await call({ action: "add_many", titles: ["   "] })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/every entry in `titles` must be a non-empty string/)
  })
  test("rejects items entry that is null", async () => {
    const r = await call({ action: "add_many", items: [null] })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/items.*object/)
  })
  test("rejects items with null children array", async () => {
    const r = await call({
      action: "add_many",
      items: [{ title: "a", children: null }],
    })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/children/)
  })
  test("rejects bad status value", async () => {
    const r = await call({ action: "status", id: 1, status: "pending" })
    expect(r.is_error).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Session-id plumbing
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Session-id plumbing
// ---------------------------------------------------------------------------

describe("session id", () => {
  test("returns an error when sid is missing", async () => {
    const r = await taskToolHandler({
      ...ctx({ action: "list" }),
      env: { HOME: tmpHome, MINIMAL_AGENT_SESSION_ID: "" },
    })
    if (r.kind !== "tool_result") throw new Error(`expected tool_result, got ${r.kind}`)
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/session id/)
  })
})

// ---------------------------------------------------------------------------
// coerce stringified arrays + hallucinated ids
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

describe("add", () => {
  test("creates a task and splits model columnar content from TUI display", async () => {
    const r = await call({ action: "add", title: "hello" })
    expect(r.is_error).toBeUndefined()
    expect(r.content).toContain("OK added")
    expect(r.content).toContain("action=add")
    expect(r.content).toMatch(/#[0-9a-f]{6}\s+todo/)
    expect(r.content).toContain("todo      hello")
    expect(r.content).not.toContain("╭")
    expect(r.content).not.toContain("✔")
    expect(r.display).toContain("hello")
    expect(r.displayHeader).toContain("added")
    expect(r.display).not.toContain("╭")
  })
  test("supports parent for subtasks", async () => {
    const r1 = await call({ action: "add", title: "parent" })
    const id = extractFirstHash(r1.content!)
    const r2 = await call({ action: "add", title: "child", parent: `#${id}` })
    expect(r2.is_error).toBeUndefined()
    expect(r2.content).toContain("child")
    // The new subtask id should be the parent id + alpha suffix and should
    // render indented under the parent (hash-only, no position coord).
    expect(r2.content).toContain(`  #${id}a  todo      child`)
  })
  test("returns error for missing parent", async () => {
    const r = await call({ action: "add", title: "x", parent: "#deadbe" })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/parent.*not found/)
  })
  test("supports the after parameter (insert position)", async () => {
    await call({ action: "add", title: "first" })
    await call({ action: "add", title: "second" })
    await call({ action: "add", title: "middle", after: 1 })
    const r = await call({ action: "list" })
    const lines = r.content!.split("\n").filter((l) => /^\s*#[0-9a-f]{6,7}\b/.test(l))
    expect(lines[0]).toContain("first")
    expect(lines[1]).toContain("middle")
    expect(lines[2]).toContain("second")
  })
  test("after: null is treated as absent (no error)", async () => {
    await call({ action: "add", title: "first" })
    const r = await call({ action: "add", title: "second", after: null })
    expect(r.is_error).toBeUndefined()
  })
  test("after accepts a hash string", async () => {
    const r1 = await call({ action: "add", title: "first" })
    const id = extractFirstHash(r1.content!)
    const r2 = await call({ action: "add", title: "second", after: `#${id}` })
    expect(r2.is_error).toBeUndefined()
    const lines = r2.content!.split("\n").filter((l) => /^\s*#[0-9a-f]{6,7}\b/.test(l))
    expect(lines[0]).toContain("first")
    expect(lines[1]).toContain("second")
  })
})

// ---------------------------------------------------------------------------
// add_many
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// add_many
// ---------------------------------------------------------------------------

describe("add_many", () => {
  test("creates each task", async () => {
    const r = await call({ action: "add_many", titles: ["one", "two", "three"] })
    expect(r.is_error).toBeUndefined()
    const store = new TaskStore(sid, { home: tmpHome })
    expect(store.list().map((t) => t.title)).toEqual(["one", "two", "three"])
    expect(r.displayHeader).toContain("added 3 tasks")
  })
  test("supports a shared parent", async () => {
    const r1 = await call({ action: "add", title: "parent" })
    const id = extractFirstHash(r1.content!)
    await call({ action: "add_many", titles: ["c1", "c2"], parent: `#${id}` })
    const store = new TaskStore(sid, { home: tmpHome })
    expect(store.list()).toHaveLength(3)
    expect(store.list()[1].parent).toBe(id)
    expect(store.list()[2].parent).toBe(id)
  })
  test("items creates parents and children in one call", async () => {
    const r = await call({
      action: "add_many",
      items: [{ title: "First task", children: ["Subtask of first"] }, { title: "Second task" }],
    })
    expect(r.is_error).toBeUndefined()
    expect(r.displayHeader).toContain("added 3 tasks")
    const store = new TaskStore(sid, { home: tmpHome })
    const tasks = store.list()
    expect(tasks).toHaveLength(3)
    expect(tasks.map((t) => t.title)).toEqual(["First task", "Subtask of first", "Second task"])
    const parent = tasks[0]
    const child = tasks[1]
    const sibling = tasks[2]
    expect(parent.parent).toBeNull()
    expect(child.parent).toBe(parent.id)
    expect(child.id).toBe(`${parent.id}a`)
    expect(sibling.parent).toBeNull()
    // Model content indents the subtask under its parent (hash-only).
    expect(r.content).toContain("Subtask of first")
    expect(r.content).toMatch(/\s+#\w+a\s+todo\s+Subtask of first/)
  })
  test("tasks (preferred) creates parents and children in one call", async () => {
    const r = await call({
      action: "add_many",
      tasks: [{ title: "Phase", children: ["a", "b"] }, { title: "Ship" }],
    })
    expect(r.is_error).toBeUndefined()
    expect(r.content).toContain("OK added_many")
    expect(r.displayHeader).toContain("added 4 tasks")
    const store = new TaskStore(sid, { home: tmpHome })
    const tasks = store.list()
    expect(tasks).toHaveLength(4)
    const phase = tasks.find((t) => t.title === "Phase")!
    expect(phase.parent).toBeNull()
    expect(tasks.filter((t) => t.parent === phase.id).map((t) => t.title)).toEqual(["a", "b"])
    expect(tasks.find((t) => t.title === "Ship")!.parent).toBeNull()
  })
  test("items with only top-level entries (no children) works like flat titles", async () => {
    const r = await call({
      action: "add_many",
      items: [{ title: "alpha" }, { title: "beta" }],
    })
    expect(r.is_error).toBeUndefined()
    const store = new TaskStore(sid, { home: tmpHome })
    expect(store.list().map((t) => t.title)).toEqual(["alpha", "beta"])
    expect(store.list().every((t) => t.parent === null)).toBe(true)
  })
  test("items can put children under more than one parent", async () => {
    const r = await call({
      action: "add_many",
      items: [
        { title: "Phase 1", children: ["1a work", "1b work"] },
        { title: "Phase 2", children: ["2a work"] },
      ],
    })
    expect(r.is_error).toBeUndefined()
    expect(r.displayHeader).toContain("added 5 tasks")
    const store = new TaskStore(sid, { home: tmpHome })
    const tasks = store.list()
    expect(tasks).toHaveLength(5)
    const p1 = tasks.find((t) => t.title === "Phase 1")!
    const p2 = tasks.find((t) => t.title === "Phase 2")!
    const kids1 = tasks.filter((t) => t.parent === p1.id).map((t) => t.title)
    const kids2 = tasks.filter((t) => t.parent === p2.id).map((t) => t.title)
    expect(kids1).toEqual(["1a work", "1b work"])
    expect(kids2).toEqual(["2a work"])
  })
  test("flat titles+parent preflight rejects overflow without partial write", async () => {
    const r1 = await call({ action: "add", title: "parent" })
    const id = extractFirstHash(r1.content!)
    // Fill 26 children first.
    const full = Array.from({ length: 26 }, (_, i) => `k${i}`)
    const ok = await call({ action: "add_many", titles: full, parent: `#${id}` })
    expect(ok.is_error).toBeUndefined()
    const before = new TaskStore(sid, { home: tmpHome }).list().length
    const overflow = await call({
      action: "add_many",
      titles: ["one-too-many"],
      parent: `#${id}`,
    })
    expect(overflow.is_error).toBe(true)
    expect(overflow.content).toMatch(/max 26|subtasks/)
    expect(new TaskStore(sid, { home: tmpHome }).list()).toHaveLength(before)
  })
})

// ---------------------------------------------------------------------------
// status / start / done
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// update / remove / reorder / clear / list
// ---------------------------------------------------------------------------

describe("update", () => {
  test("changes title and renders the diff (old → new) in the display", async () => {
    await call({ action: "add", title: "before" })
    const r = await call({ action: "update", id: 1, title: "after" })
    expect(r.is_error).toBeUndefined()
    // Both the old and new titles appear, with an arrow between them.
    // The display lets the user SEE what changed instead of silently swapping.
    expect(r.display).toContain("before")
    expect(r.display).toContain("after")
    expect(r.display).toContain("→")
    // The store itself reflects only the post-state (no stale title on disk).
    const store = new TaskStore(sid, { home: tmpHome })
    expect(store.list()[0].title).toBe("after")
  })
  test("no diff overlay when the title is unchanged (avoid 'x → x' noise)", async () => {
    await call({ action: "add", title: "same" })
    const r = await call({ action: "update", id: 1, title: "same" })
    expect(r.is_error).toBeUndefined()
    expect(r.display).toContain("same")
    expect(r.display).not.toContain("→")
  })
  test("error for unknown id", async () => {
    const r = await call({ action: "update", id: "#deadbe", title: "x" })
    expect(r.is_error).toBe(true)
  })
  test("rejects update with neither title nor status", async () => {
    await call({ action: "add", title: "x" })
    const r = await call({ action: "update", id: 1 })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/at least one of.*title.*status/)
  })
  test("update with status only delegates to doStatus (marked_doing)", async () => {
    await call({ action: "add", title: "x" })
    const r = await call({ action: "update", id: 1, status: "doing" })
    expect(r.is_error).toBeUndefined()
    expect(r.content).toContain("action=update")
    expect(r.content).toContain("OK marked_doing")
    expect(r.content).toMatch(/^OK /)
    expect(r.content).not.toContain("<ma::agent::")
    expect(r.content).not.toContain("doing     x")
    const store = new TaskStore(sid, { home: tmpHome })
    expect(store.list()[0].status).toBe("doing")
  })
  test("updates a subtask by its visible child-row coordinate", async () => {
    await call({
      action: "add_many",
      items: [
        { title: "Phase", children: ["first child", "second child", "third child"] },
        { title: "Second phase", children: ["other child"] },
      ],
    })

    const r = await call({ action: "update", id: "1c", status: "done" })
    expect(r.is_error).toBeUndefined()
    expect(r.content).toContain("action=update")
    expect(r.content).toContain("OK marked_done")

    const store = new TaskStore(sid, { home: tmpHome })
    const parent = store.resolve(1)!
    expect(store.resolve(`${parent.id}c`)!.status).toBe("done")
    expect(store.resolve("2a")!.status).toBe("todo")
  })
  test("update with both title and status applies both", async () => {
    await call({ action: "add", title: "old title" })
    const r = await call({
      action: "update",
      id: 1,
      title: "new title",
      status: "doing",
    })
    expect(r.is_error).toBeUndefined()
    expect(r.content).toContain("OK updated")
    expect(r.content).toContain("new title")
    // Display shows the title diff.
    expect(r.display).toContain("old title")
    expect(r.display).toContain("new title")
    expect(r.display).toContain("→")
    const store = new TaskStore(sid, { home: tmpHome })
    const t = store.list()[0]
    expect(t.title).toBe("new title")
    expect(t.status).toBe("doing")
  })
  test("update with status=canceled and reason", async () => {
    await call({ action: "add", title: "x" })
    const r = await call({
      action: "update",
      id: 1,
      status: "canceled",
      reason: "no longer needed",
    })
    expect(r.is_error).toBeUndefined()
    expect(r.content).toContain("OK marked_canceled")
    expect(r.display).toContain("no longer needed")
    expect(r.content).toContain('reason="no longer needed"')
    expect(r.content).not.toMatch(/\n1\s+#/)
  })
  test("update with status=done on already-done task is a hard error", async () => {
    await call({ action: "add", title: "solo" })
    await call({ action: "done", id: 1 })
    const r = await call({ action: "update", id: 1, status: "done" })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/already done/i)
  })
  test("update with title+status=done on last task triggers ALL DONE", async () => {
    await call({ action: "add", title: "x" })
    await call({ action: "add", title: "y" })
    await call({ action: "done", id: 1 })
    const r = await call({
      action: "update",
      id: 2,
      title: "y done",
      status: "done",
    })
    expect(r.is_error).toBeUndefined()
    expect(r.displayHeader).toContain("ALL DONE")
    const store = new TaskStore(sid, { home: tmpHome })
    expect(store.list().every((t) => t.status === "done")).toBe(true)
  })
})

describe("remove", () => {
  test("removes the task from disk", async () => {
    await call({ action: "add", title: "x" })
    const r = await call({ action: "remove", id: 1 })
    expect(r.is_error).toBeUndefined()
    const store = new TaskStore(sid, { home: tmpHome })
    expect(store.list()).toEqual([])
  })
  test("keeps a ghost-removed tombstone in the rendered display so the user sees WHAT was removed", async () => {
    await call({ action: "add", title: "alpha" })
    await call({ action: "add", title: "beta" })
    await call({ action: "add", title: "gamma" })
    const r = await call({ action: "remove", id: 2 })
    expect(r.is_error).toBeUndefined()
    // The removed task's title still appears in the display body (tombstone).
    expect(r.display).toContain("beta")
    // The other tasks are still there too.
    expect(r.display).toContain("alpha")
    expect(r.display).toContain("gamma")
    // Closer reflects post-state (2 todo, not 3).
    expect(r.displayFooter).toContain("2 todo")
  })
  test("removing a parent ghosts the whole subtree (cascade)", async () => {
    const parent = await call({ action: "add", title: "parent" })
    const pid = /#([0-9a-f]{6})/.exec(parent.content!)![1]
    await call({ action: "add", title: "child A", parent: `#${pid}` })
    await call({ action: "add", title: "child B", parent: `#${pid}` })
    const r = await call({ action: "remove", id: `#${pid}` })
    expect(r.is_error).toBeUndefined()
    // Parent + both children appear as ghost rows in the display.
    expect(r.display).toContain("parent")
    expect(r.display).toContain("child A")
    expect(r.display).toContain("child B")
    // But the store is empty.
    const store = new TaskStore(sid, { home: tmpHome })
    expect(store.list()).toEqual([])
  })
})

describe("reorder", () => {
  test("rearranges top-level tasks", async () => {
    const r1 = await call({ action: "add", title: "1" })
    const r2 = await call({ action: "add", title: "2" })
    const r3 = await call({ action: "add", title: "3" })
    const id1 = extractFirstHash(r1.content!)
    void r2
    const id3 = extractFirstHash(r3.content!)
    const r = await call({ action: "reorder", order: [`#${id3}`, `#${id1}`] })
    expect(r.is_error).toBeUndefined()
    expect(r.displayHeader).toContain("reordered")
  })
})

describe("clear", () => {
  test("wipes all when no doing tasks", async () => {
    await call({ action: "add", title: "x" })
    const r = await call({ action: "clear" })
    expect(r.is_error).toBeUndefined()
    expect(r.displayHeader).toContain("cleared")
  })
  test("refuses when a task is doing (no force)", async () => {
    await call({ action: "add", title: "x", status: "doing" })
    const r = await call({ action: "clear" })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/refusing to clear/)
  })
  test("force: true overrides the refusal", async () => {
    await call({ action: "add", title: "x", status: "doing" })
    const r = await call({ action: "clear", force: true })
    expect(r.is_error).toBeUndefined()
    expect(r.content).toContain("OK cleared")
    expect(r.content).toContain("_No tasks._")
  })
})

describe("list", () => {
  test("renders the current state without mutating", async () => {
    await call({ action: "add", title: "x" })
    const before = new TaskStore(sid, { home: tmpHome }).list()
    const r = await call({ action: "list" })
    expect(r.is_error).toBeUndefined()
    // Header content is action-specific; for `list` with N tasks it
    // includes the count summary. The "Tasks" brand lives on the CLI
    // path only (`renderBlock`); the agent path delegates identity to
    // the manifest's icon/label via host chrome.
    expect(r.displayHeader).toContain("1 task")
    const after = new TaskStore(sid, { home: tmpHome }).list()
    expect(after).toEqual(before)
  })
  test("empty state shows 'no tasks'", async () => {
    const r = await call({ action: "list" })
    expect(r.is_error).toBeUndefined()
    expect(r.displayHeader).toContain("no tasks")
  })
})

// ---------------------------------------------------------------------------
// Model-facing columnar content
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// JSON format
// ---------------------------------------------------------------------------

describe("format: json", () => {
  test("returns parseable JSON in content with rendered ANSI in display", async () => {
    await call({ action: "add", title: "hello" })
    const r = await call({ action: "list", format: "json" })
    expect(r.is_error).toBeUndefined()
    expect(() => JSON.parse(r.content!)).not.toThrow()
    const parsed = JSON.parse(r.content!) as {
      stats: { total: number }
      tasks: { title: string }[]
    }
    expect(parsed.stats.total).toBe(1)
    expect(parsed.tasks[0].title).toBe("hello")
    // Display always has ANSI regardless of format.
    expect(r.display).toMatch(/\x1b\[/)
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractFirstHash(content: string): string {
  const fromId = /\bid=#([0-9a-f]{6,7})\b/.exec(content)
  if (fromId) return fromId[1]
  const legacy = /\bid="([0-9a-f]{6,7})"/.exec(content)
  if (legacy) return legacy[1]
  const m = /#([0-9a-f]{6,7})\b/.exec(content)
  if (!m) throw new Error(`no hash found in: ${content}`)
  return m[1]
}
