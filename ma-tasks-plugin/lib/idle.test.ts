import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { IDLE_THRESHOLD_MS, markIdleEnd, markIdleStart, overlapMs, subtractGaps } from "./idle.ts"
import { createTasksMeta } from "./parse.ts"
import { formatDuration, listTotalElapsedMs, taskActiveMs } from "./render.ts"
import { TaskStore } from "./store.ts"

const MIN = 60_000
const HOUR = 60 * MIN
const T0 = new Date(2026, 10, 4, 18, 0, 0).getTime()

describe("idle gap helpers", () => {
  test("subtractGaps removes the overlap only", () => {
    const gaps = [[T0 + 10 * MIN, T0 + 20 * HOUR]] as const
    expect(subtractGaps(T0, T0 + 20 * HOUR + 5 * MIN, gaps)).toBe(15 * MIN)
    expect(subtractGaps(T0 + 30 * MIN, T0 + 40 * MIN, gaps)).toBe(0)
    expect(subtractGaps(T0, T0 + 5 * MIN, gaps)).toBe(5 * MIN)
  })

  test("overlapMs clamps to the window", () => {
    expect(overlapMs(0, 10, 5, 20)).toBe(5)
    expect(overlapMs(0, 10, 11, 20)).toBe(0)
  })

  test("a short pause below the threshold is not a gap", () => {
    let meta = createTasksMeta()
    meta = markIdleStart(meta, T0)
    meta = markIdleEnd(meta, T0 + IDLE_THRESHOLD_MS - 1)
    expect(meta.idle_gaps).toEqual([])
    expect(meta.idle_since).toBeNull()
  })

  test("a pause at or above the threshold becomes a gap", () => {
    let meta = createTasksMeta()
    meta = markIdleStart(meta, T0)
    meta = markIdleEnd(meta, T0 + IDLE_THRESHOLD_MS)
    expect(meta.idle_gaps).toEqual([[T0, T0 + IDLE_THRESHOLD_MS]])
  })
})

describe("render math with gaps", () => {
  test("listTotalElapsedMs skips the idle gap", () => {
    const t = {
      id: "1",
      parent: null,
      status: "done" as const,
      title: "x",
      created_at: "",
      done_at: new Date(T0 + 20 * HOUR + 5 * MIN).toISOString(),
      reason: null,
      started_at: new Date(T0).toISOString(),
      last_resumed_at: null,
      active_ms: 15 * MIN,
    }
    const gaps = [[T0 + 10 * MIN, T0 + 20 * HOUR]] as const
    expect(formatDuration(listTotalElapsedMs([t], T0 + 21 * HOUR))).toBe("20h 05m")
    expect(formatDuration(listTotalElapsedMs([t], T0 + 21 * HOUR, gaps))).toBe("15m 00s")
  })

  test("taskActiveMs of a doing task skips the idle gap", () => {
    const t = {
      id: "1",
      parent: null,
      status: "doing" as const,
      title: "x",
      created_at: "",
      done_at: null,
      reason: null,
      started_at: new Date(T0).toISOString(),
      last_resumed_at: new Date(T0).toISOString(),
      active_ms: 0,
    }
    const gaps = [[T0 + 10 * MIN, T0 + 20 * HOUR]] as const
    expect(taskActiveMs(t, T0 + 20 * HOUR + 5 * MIN, gaps)).toBe(15 * MIN)
  })
})

describe("TaskStore with idle gaps (the user-reported bug)", () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(process.cwd(), ".tmp-idle-"))
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  test("work, stop for 20h, resume: active_ms counts only working time", () => {
    let now = T0
    const store = new TaskStore("sid-idle", { home, now: () => new Date(now) })
    const task = store.add({ title: "work" })
    store.start(task.id)
    now = T0 + 10 * MIN
    store.markTurnEnd()
    now = T0 + 20 * HOUR
    store.markTurnStart()
    now = T0 + 20 * HOUR + 5 * MIN
    const done = store.done(task.id)
    expect(done?.active_ms).toBe(15 * MIN)
    expect(store.idleGaps(now)).toEqual([[T0 + 10 * MIN, T0 + 20 * HOUR]])
  })

  test("a task still doing after the gap shows live time without the gap", () => {
    let now = T0
    const store = new TaskStore("sid-idle2", { home, now: () => new Date(now) })
    const task = store.add({ title: "work" })
    store.start(task.id)
    now = T0 + 10 * MIN
    store.markTurnEnd()
    now = T0 + 20 * HOUR
    store.markTurnStart()
    now = T0 + 20 * HOUR + 5 * MIN
    const live = store.list()[0]
    expect(taskActiveMs(live, now, store.idleGaps(now))).toBe(15 * MIN)
  })

  test("an open gap (turn ended, still idle) is excluded from live time", () => {
    let now = T0
    const store = new TaskStore("sid-idle3", { home, now: () => new Date(now) })
    const task = store.add({ title: "work" })
    store.start(task.id)
    now = T0 + 10 * MIN
    store.markTurnEnd()
    now = T0 + 20 * HOUR
    const live = store.list()[0]
    expect(taskActiveMs(live, now, store.idleGaps(now))).toBe(10 * MIN)
  })

  test("a short break keeps counting (below threshold)", () => {
    let now = T0
    const store = new TaskStore("sid-idle4", { home, now: () => new Date(now) })
    const task = store.add({ title: "work" })
    store.start(task.id)
    now = T0 + 5 * MIN
    store.markTurnEnd()
    now = T0 + 15 * MIN
    store.markTurnStart()
    now = T0 + 20 * MIN
    expect(store.done(task.id)?.active_ms).toBe(20 * MIN)
  })

  test("markTurnEnd on a session with no task file does not create one", () => {
    const store = new TaskStore("sid-none", { home })
    store.markTurnEnd()
    expect(store.hasFile()).toBe(false)
  })
})
