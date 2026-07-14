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
  test("rejects add_many without titles or items", async () => {
    const r = await call({ action: "add_many" })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/titles.*items|items.*titles/)
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
  test("rejects items combined with parent", async () => {
    const r = await call({
      action: "add_many",
      parent: 1,
      items: [{ title: "a", children: ["b"] }],
    })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/parent.*items|items.*parent/)
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
  test("rejects empty children array on items entry", async () => {
    const r = await call({ action: "add_many", items: [{ title: "a", children: [] }] })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/children/)
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
  test("rejects bad status value", async () => {
    const r = await call({ action: "status", id: 1, status: "pending" })
    expect(r.is_error).toBe(true)
  })
})

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
// add
// ---------------------------------------------------------------------------

describe("add", () => {
  test("creates a task and splits model columnar content from TUI display", async () => {
    const r = await call({ action: "add", title: "hello" })
    expect(r.is_error).toBeUndefined()
    expect(r.content).toContain(`<ma::agent::tasks action="add" result="added"`)
    expect(r.content).toContain("1  #")
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
    // render in columnar format with parent-number + suffix letter.
    expect(r2.content).toContain(`1a  #${id}a  todo      child`)
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
    const lines = r.content!.split("\n").filter((l) => l.includes("#"))
    expect(lines[0]).toContain("first")
    expect(lines[1]).toContain("middle")
    expect(lines[2]).toContain("second")
  })
})

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
    // Model content shows nested numbering for the subtask.
    expect(r.content).toContain("Subtask of first")
    expect(r.content).toMatch(/1a\s+#\w+a\s+todo\s+Subtask of first/)
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

describe("status / start / done", () => {
  test("model content includes action/result/id attrs for a status transition", async () => {
    await call({ action: "add", title: "x" })
    const r = await call({ action: "status", id: 1, status: "doing" })
    expect(r.is_error).toBeUndefined()
    expect(r.content).toContain(`action="status"`)
    expect(r.content).toContain(`result="marked_doing"`)
    expect(r.content).toContain(`id="`)
    expect(r.content).toContain("1  #")
    expect(r.content).toContain("doing     x")
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
    expect(r.content).toContain("1  #")
    expect(r.content).toContain("canceled  x (user redirected)")
  })
  test("start enforces single-doing discipline by default", async () => {
    await call({ action: "add", title: "one" })
    await call({ action: "add", title: "two" })
    await call({ action: "start", id: 1 })
    const r = await call({ action: "start", id: 2 })
    expect(r.is_error).toBeUndefined()
    const store = new TaskStore(sid, { home: tmpHome })
    const doings = store.list().filter((t) => t.status === "doing")
    expect(doings).toHaveLength(1)
    expect(doings[0].title).toBe("two")
  })
  test("start parallel:true allows multiple doings", async () => {
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
    expect(store.list().find((t) => t.id === parent.id)!.status).toBe("todo")
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
})

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
    expect(r.content).toContain(`result="cleared"`)
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

describe("model-facing content", () => {
  test("escapes tag-sensitive title text inside the <ma::agent::tasks> body", async () => {
    const r = await call({ action: "add", title: 'use <x> & "quotes"' })
    expect(r.is_error).toBeUndefined()
    expect(r.content).toContain('use &lt;x&gt; &amp; "quotes"')
    expect(r.content).toContain("</ma::agent::tasks>")
  })

  test("default text content is not the TUI display without ANSI", async () => {
    const r = await call({ action: "add_many", titles: ["one", "two"] })
    expect(r.is_error).toBeUndefined()
    expect(r.content).toContain(`<ma::agent::tasks action="add_many" result="added_many"`)
    expect(r.content).toContain("1  #")
    expect(r.content).toContain("todo      one")
    expect(r.content).toContain("2  #")
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

function extractFirstHash(content: string): string {
  const target = /\bid="([0-9a-f]{6,7})"/.exec(content)
  if (target) return target[1]
  const m = /#([0-9a-f]{6,7})/.exec(content)
  if (!m) throw new Error(`no hash found in: ${content}`)
  return m[1]
}
