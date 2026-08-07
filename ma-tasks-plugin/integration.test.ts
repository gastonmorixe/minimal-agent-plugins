/**
 * End-to-end integration tests for the tasks plugin.
 *
 * Exercises the full closing-the-loop flow WITHOUT importing host code, so
 * the plugin's own suite stays repo-portable (the decoupling contract):
 *
 *   1. The plugin's `manifest.json` declares the `Task` tool (with its icon
 *      and color) and the per-turn `tasks_snapshot` attachment.
 *   2. A `Task({action: "add_many", ...})` is dispatched by invoking the
 *      handler's default export directly → handler appends to disk via
 *      `TaskStore` → returns the rendered list in `tool_result.display`.
 *   3. A fresh `TasksAttachment` for the same session id sees the committed
 *      state, ready to inject on the next user turn.
 *   4. A `Task({action: "done", id: 1})` flips the first task and the
 *      attachment reflects it.
 *
 * The host loader's discovery/dispatch wiring (manifest → module resolve →
 * dispatch) is host-internal and covered by the host's own loader-contract
 * tests; here we cover the plugin's handler + store + attachment seams, which
 * is what must keep working when this directory lives in its own repo.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import taskToolHandler from "./handlers/task_tool.ts"
import { TasksAttachment } from "./lib/attachment.ts"
import type { TUIContext, TUIResult } from "./lib/host-types.ts"
import { TaskStore } from "./lib/store.ts"

const MANIFEST = JSON.parse(readFileSync(join(import.meta.dir, "manifest.json"), "utf-8")) as {
  tuis: { trigger: { tool?: { name?: string } }; icon?: string; color?: string }[]
  turnAttachments?: { id: string }[]
}

let tmpHome: string

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "tasks-integration-"))
})

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true })
})

/** A minimal TUIContext good enough to dispatch the Task tool handler. */
function ctx(sid: string, input: Record<string, unknown>): TUIContext {
  return {
    trigger: { type: "tool", name: "Task", input, tool_use_id: "tu" },
    packageDir: "/tmp/fake-package-dir",
    cwd: "/tmp/fake-cwd",
    env: { HOME: tmpHome, MINIMAL_AGENT_SESSION_ID: sid },
    abort: new AbortController().signal,
    stdout: process.stdout,
    stdin: process.stdin,
    stderr: process.stderr,
    log: { info() {}, warn() {}, error() {}, debug() {} } as never,
  } as unknown as TUIContext
}

type ToolResult = Extract<TUIResult, { kind: "tool_result" }>

async function dispatch(sid: string, input: Record<string, unknown>): Promise<ToolResult> {
  const r = await taskToolHandler(ctx(sid, input))
  if (r.kind !== "tool_result") throw new Error(`expected tool_result, got ${r.kind}`)
  return r
}

describe("tasks plugin — full handler → store → attachment loop", () => {
  it("manifest declares the Task tool and the tasks snapshot attachment", () => {
    const task = MANIFEST.tuis.find((t) => t.trigger.tool?.name === "Task")
    expect(task).toBeDefined()
    // The cosmetic icon + color flow into the host tool frame (toolPresentation).
    expect(task?.icon).toBe("◉")
    expect(task?.color).toBe("lime")
    expect(MANIFEST.turnAttachments?.some((a) => a.id === "tasks_snapshot")).toBe(true)
  })

  it("add_many → store on disk → attachment reflects it", async () => {
    const sid = "11111111-aaaa-bbbb-cccc-dddddddddddd"

    // --- Dispatch add_many through the handler ---
    const addResult = await dispatch(sid, {
      action: "add_many",
      titles: ["plan step 1", "plan step 2", "plan step 3"],
    })
    expect(addResult.is_error).toBeFalsy()
    expect(addResult.displayHeader).toContain("added 3 tasks")
    expect(addResult.content).toContain("plan step 1")
    expect(addResult.content).toContain("plan step 3")

    // --- File on disk has the tasks ---
    const store = new TaskStore(sid, { home: tmpHome })
    const tasks = store.list()
    expect(tasks).toHaveLength(3)
    expect(tasks.map((t) => t.title)).toEqual(["plan step 1", "plan step 2", "plan step 3"])

    // --- A fresh TasksAttachment sees the committed state ---
    const att = new TasksAttachment(sid, { home: tmpHome })
    const text = att.toText()
    expect(text).not.toBeNull()
    expect(text!).toContain("<ma::agent::tasks")
    expect(text!).toContain(`total="3"`)
    expect(text!).toContain("plan step 1")
  })

  it("a new plan replaces a fully completed plan so a fresh tree is addressable", async () => {
    const sid = "66666666-aaaa-bbbb-cccc-dddddddddddd"

    await dispatch(sid, {
      action: "add_many",
      items: [
        { title: "Old phase 1", children: ["old 1a", "old 1b"] },
        { title: "Old phase 2", children: ["old 2a", "old 2b"] },
      ],
    })
    await dispatch(sid, { action: "done", id: 1 })
    await dispatch(sid, { action: "done", id: 2 })

    const addResult = await dispatch(sid, {
      action: "replace_plan",
      items: [
        { title: "New phase 1", children: ["new 1a", "new 1b", "new 1c"] },
        { title: "New phase 2", children: ["new 2a", "new 2b", "new 2c"] },
        { title: "New phase 3", children: ["new 3a"] },
      ],
    })
    expect(addResult.is_error).toBeFalsy()
    expect(addResult.content).not.toContain("Old phase")
    // Model board is hash-only (no POS / 2c coords in content).
    expect(addResult.content).toContain("New phase 1")
    expect(addResult.content).toContain("new 2c")
    expect(addResult.content).toMatch(/^3\s+todo/m)

    const replacementRoots = new TaskStore(sid, { home: tmpHome })
      .list()
      .filter((task) => task.parent === null)
    const secondRoot = replacementRoots[1]!
    const startResult = await dispatch(sid, { action: "start", id: `${secondRoot.id}c` })
    expect(startResult.is_error).toBeFalsy()

    const store = new TaskStore(sid, { home: tmpHome })
    expect(
      store
        .list()
        .filter((task) => task.parent === null)
        .map((task) => task.title),
    ).toEqual(["New phase 1", "New phase 2", "New phase 3"])
    expect(store.resolve(`${secondRoot.id}c`)?.title).toBe("new 2c")
    expect(store.resolve(`${secondRoot.id}c`)?.status).toBe("doing")
  })

  it("add_many extends while replace_plan explicitly replaces", async () => {
    const sid = "77777777-aaaa-bbbb-cccc-dddddddddddd"
    await dispatch(sid, { action: "add_many", titles: ["done", "still open"] })
    const extended = await dispatch(sid, { action: "add_many", titles: ["new work"] })
    expect(extended.content).toContain("still open")
    expect(new TaskStore(sid, { home: tmpHome }).list().map((task) => task.title)).toEqual([
      "done",
      "still open",
      "new work",
    ])

    const replaced = await dispatch(sid, { action: "replace_plan", titles: ["fresh plan"] })
    expect(replaced.content).toMatch(/OK replaced_plan .*\breplaced=3\b/)
    expect(new TaskStore(sid, { home: tmpHome }).list().map((task) => task.title)).toEqual([
      "fresh plan",
    ])
  })

  it("done flips a task and the attachment reflects the new status", async () => {
    const sid = "22222222-aaaa-bbbb-cccc-dddddddddddd"

    await dispatch(sid, { action: "add_many", titles: ["first", "second"] })

    const doneResult = await dispatch(sid, { action: "done", id: 1 })
    expect(doneResult.is_error).toBeFalsy()
    expect(doneResult.displayHeader).toContain("marked done")

    // Attachment sees done=1, todo=1.
    const text = new TasksAttachment(sid, { home: tmpHome }).toText()!
    expect(text).toContain(`done="1"`)
    expect(text).toContain(`todo="1"`)
    expect(text).toContain("done")
  })

  it("all-done verb fires when the LAST top-level task is completed", async () => {
    const sid = "33333333-aaaa-bbbb-cccc-dddddddddddd"

    await dispatch(sid, { action: "add", title: "the only task" })
    const r = await dispatch(sid, { action: "done", id: 1 })
    expect(r.displayHeader).toContain("ALL DONE")
  })

  it("subtasks use the parent's canonical id", async () => {
    const sid = "44444444-aaaa-bbbb-cccc-dddddddddddd"

    const parentR = await dispatch(sid, { action: "add", title: "parent" })
    const parentId = /\bid=([1-9]\d*)\b/.exec(parentR.content!)![1]

    await dispatch(sid, { action: "add", title: "child A", parent: parentId })
    await dispatch(sid, { action: "add", title: "child B", parent: parentId })

    const text = new TasksAttachment(sid, { home: tmpHome }).toText()!
    expect(text).toContain(`  ${parentId}a  todo      child A`)
    expect(text).toContain(`  ${parentId}b  todo      child B`)
    expect(text).toContain(parentId)
    expect(text).toContain("parent")
    expect(text).toContain("child A")
    expect(text).toContain("child B")
  })

  it("clear refuses with a doing task; force overrides", async () => {
    const sid = "55555555-aaaa-bbbb-cccc-dddddddddddd"

    await dispatch(sid, { action: "add", title: "x" })
    await dispatch(sid, { action: "start", id: 1 })

    const refused = await dispatch(sid, { action: "clear" })
    expect(refused.is_error).toBe(true)
    expect(refused.content).toMatch(/refusing to clear/)

    const forced = await dispatch(sid, { action: "clear", force: true })
    expect(forced.is_error).toBeFalsy()

    const store = new TaskStore(sid, { home: tmpHome })
    expect(store.list()).toEqual([])
  })
})
