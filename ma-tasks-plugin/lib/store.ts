/**
 * Per-session task store. One instance per session, backed by a JSONL
 * file at `~/.minimal-agent/sessions/<sid>.tasks.jsonl`.
 *
 * The store is the only module that touches disk. Everything above it
 * (renderer, handler, attachment) reasons in terms of {@link Task}
 * objects and store-returned views. Below it: {@link parse.ts} is pure
 * (id generation, JSONL).
 *
 * ## Accumulating `doing` state
 *
 * `start(id)` flips a task to `doing` and leaves every other `doing` task
 * alone. Started work stays started until it is explicitly `done`,
 * `canceled`, or set back to `todo` via `status`. Multiple top-level tasks
 * and sibling subtasks can be `doing` at once; the list is the history of
 * what has been begun, not a single-focus cursor.
 *
 * The optional `{parallel}` flag on `start` is accepted for API
 * compatibility and is a no-op (accumulation is always on).
 *
 * ## Parent ↔ child lifecycle rollup
 *
 * Starting or partially completing a child starts its parent. Finishing
 * the last open child completes the parent, and completing a parent
 * cascades to its open children. Canceled rows are never rewritten as
 * done, and a canceled parent is never revived. See
 * {@link TaskStore.setStatus}.
 *
 * ## Position numbering
 *
 * Top-level tasks get a 1-indexed `n` re-derived on every read. Subtasks
 * have `n: null` (their position is implied by parent + alpha suffix).
 * Numbers are NOT stored on disk — they shift on reorder/remove.
 *
 * ## Concurrency
 *
 * One writer per session by construction (the session id is unique).
 * Full-rewrite on every mutation is fine: the file is tiny (typical
 * plan is under 20 lines, never more than a few hundred).
 *
 * @module tasks/lib/store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { resolveSessionsDir } from "./agent-paths.ts"
import {
  createTasksMeta,
  isSubtaskId,
  localIsoSeconds,
  type NewTaskInput,
  parseTasksFile,
  serializeTasksFile,
  subtaskId,
  type Task,
  type TaskStatus,
  type TasksMeta,
} from "./parse.ts"

// ---------------------------------------------------------------------------
// Duration transitions (schema v2+)
// ---------------------------------------------------------------------------

/**
 * Apply a status transition to a task, accruing time-in-`doing` and
 * stamping the relevant ISO timestamps. Pure — returns the next task,
 * does NOT touch disk.
 *
 * The duration model has three fields (schema v2+):
 *  - `started_at` — set ONCE on first entry into `doing`, never overwritten.
 *  - `last_resumed_at` — set on EVERY entry into `doing`, cleared on every exit.
 *  - `active_ms` — cumulative time spent in `doing`. Bumped by
 *    `nowEpoch − Date.parse(last_resumed_at)` on every `doing → other`
 *    transition.
 *
 * Edge cases:
 *  - `doing → doing` is a no-op for timing (same as no transition).
 *  - `* → done` also stamps `done_at` (preserved from pre-v2 behavior).
 *  - `* → canceled` clears `reason` only if the caller doesn't preserve it.
 *  - When `last_resumed_at` is missing or unparseable on a
 *    `doing → other` transition (resumed v1 file, file corruption), no time is
 *    accrued — `active_ms` stays put. Better to lose a few seconds of
 *    history than to inject NaN into the counter.
 *
 * Exported for tests; the store uses it via {@link TaskStore.setStatus}
 * and {@link TaskStore.start}.
 */
export function applyStatusTransition(
  prev: Task,
  next: TaskStatus,
  nowIso: string,
  nowEpochMs: number,
  reason?: string | null,
): Task {
  let started_at = prev.started_at
  let last_resumed_at = prev.last_resumed_at
  let active_ms = prev.active_ms
  const wasDoing = prev.status === "doing"
  const willBeDoing = next === "doing"

  if (!wasDoing && willBeDoing) {
    // Enter `doing` from anywhere else: set started_at if first time,
    // and always set last_resumed_at to now.
    if (started_at === null) started_at = nowIso
    last_resumed_at = nowIso
  } else if (wasDoing && !willBeDoing) {
    // Leave `doing`: accrue the in-flight chunk into active_ms and
    // clear last_resumed_at. If last_resumed_at is somehow null /
    // unparseable, skip the accrual (defensive on resumed v1 data).
    if (last_resumed_at !== null) {
      const resumedMs = Date.parse(last_resumed_at)
      if (Number.isFinite(resumedMs) && nowEpochMs >= resumedMs) {
        active_ms += nowEpochMs - resumedMs
      }
    }
    last_resumed_at = null
  }
  // Same-status (doing → doing, todo → todo, etc.) — no timing change.

  return {
    ...prev,
    status: next,
    done_at: next === "done" ? (prev.done_at ?? nowIso) : null,
    reason: next === "canceled" ? reason?.trim() || prev.reason || null : null,
    started_at,
    last_resumed_at,
    active_ms,
  }
}

// ---------------------------------------------------------------------------
// View types
// ---------------------------------------------------------------------------

/**
 * A task plus the derived display position. Subtasks have `n: null`.
 * The renderer and attachment consume {@link View}, not raw {@link Task}.
 *
 * `ghost` and `diff` are one-shot overlays the handler may attach when
 * it wants the renderer to surface "what just changed" (rather than only
 * the post-state). The store itself never populates them.
 */
export interface View {
  task: Task
  /** 1-indexed display position for top-level tasks; `null` for subtasks. */
  n: number | null
  /** 0-indexed child position for subtasks (used by the renderer to pick `├` vs `╰`). `null` for top-level. */
  childIndex: number | null
  /** Total child count of this task's parent (used by the renderer to detect "last child"). `null` for top-level. */
  siblingCount: number | null
  /**
   * When set, this row is a one-shot "tombstone" for a task that no
   * longer exists in the store (just removed). Rendered with a red `✘`
   * icon and red strikethrough title so the user sees WHAT was removed,
   * not just that something was. The closer's stats still reflect the
   * post-mutation state — the ghost is purely visual.
   */
  ghost?: "removed"
  /**
   * When set, the title column renders as a diff:
   *
   * `<oldTitle struck through red>  →  <newTitle bold>`
   *
   * Used by `update` so the user sees WHAT changed, not just the new
   * title. The handler is responsible for skipping this when old===new.
   */
  diff?: { oldTitle: string }
}

/** Counts for the closer line and the attachment header. */
export interface Stats {
  total: number
  done: number
  doing: number
  todo: number
  canceled: number
}

// ---------------------------------------------------------------------------
// Path resolution + injection
// ---------------------------------------------------------------------------

/** Test/integration deps. Defaults read live env. */
export interface StoreDeps {
  /** Override the home directory. */
  home?: string
  /** Override the time source (passed through to {@link localIsoSeconds}). */
  now?: () => Date
  /** Deprecated v2 compatibility injection. Ordinal ids do not use randomness. */
  rand?: () => Buffer
  /** Test-only hook invoked after the temp file is complete but before rename. */
  beforeRename?: (tempPath: string) => void
}

export interface ReplaceTaskInput {
  title: string
  status?: TaskStatus
  children?: readonly Omit<ReplaceTaskInput, "children">[]
}

function resolveTasksPath(sid: string, deps: StoreDeps): string {
  const env = deps.home ? { HOME: deps.home } : process.env
  return join(resolveSessionsDir(env), `${sid}.tasks.jsonl`)
}

/**
 * Pure helper: derive views (with display positions + child-tree
 * metadata) from a flat task list in file order. The handler reuses
 * this to build augmented views from PRE-mutation tasks when a
 * just-removed task needs to be re-injected as a ghost row.
 */
export function buildViews(tasks: readonly Task[]): View[] {
  const out: View[] = []
  let n = 0
  const childrenByParent = new Map<string, Task[]>()
  for (const t of tasks) {
    if (t.parent !== null) {
      const arr = childrenByParent.get(t.parent) ?? []
      arr.push(t)
      childrenByParent.set(t.parent, arr)
    }
  }
  for (const t of tasks) {
    if (t.parent === null) {
      n += 1
      out.push({ task: t, n, childIndex: null, siblingCount: null })
    } else {
      const siblings = childrenByParent.get(t.parent) ?? []
      const childIndex = siblings.indexOf(t)
      out.push({ task: t, n: null, childIndex, siblingCount: siblings.length })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// TaskStore
// ---------------------------------------------------------------------------

/**
 * Custom error class for store-level "user gave us a bad reference".
 * Distinguishes from genuine I/O errors so the handler can return a
 * clean tool-result rather than a stack trace.
 */
export class TaskStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TaskStoreError"
  }
}

/**
 * Append-only JSONL-backed task store: owns task/subtask CRUD, status
 * transitions, ordering, and hash-or-position id resolution for one session.
 */
export class TaskStore {
  readonly path: string
  private readonly deps: StoreDeps

  constructor(sid: string, deps: StoreDeps = {}) {
    if (typeof sid !== "string" || sid.trim().length === 0) {
      throw new TaskStoreError(`TaskStore: sid must be a non-empty string`)
    }
    this.path = resolveTasksPath(sid, deps)
    this.deps = deps
  }

  // -------------------------------------------------------------------------
  // Read paths
  // -------------------------------------------------------------------------

  /** Read all tasks from disk in display order, initializing or migrating v3 atomically. */
  list(): Task[] {
    return this.readState().tasks
  }

  /** Return a defensive copy of the persisted v3 allocator metadata. */
  metadata(): TasksMeta {
    const meta = this.readState().meta
    return createTasksMeta({
      next_root: meta.next_root,
      next_child: meta.next_child,
      aliases: meta.aliases,
    })
  }

  /**
   * Build views with derived `n` (display position) and child-tree
   * metadata. The renderer and attachment consume this shape.
   *
   * Order: file order (which is display order). Numbers are re-derived
   * (1-indexed across top-level only) on every call.
   */
  views(): View[] {
    return buildViews(this.list())
  }

  /** Aggregate counts for headers. */
  stats(): Stats {
    const tasks = this.list()
    const s: Stats = {
      total: tasks.length,
      done: 0,
      doing: 0,
      todo: 0,
      canceled: 0,
    }
    for (const t of tasks) s[t.status] += 1
    return s
  }

  /**
   * Resolve an id reference into a task. Accepts a bare id, a `#`-prefixed
   * id, a positive integer (1-indexed top-level position), or an unprefixed
   * child-row coordinate such as `"1a"`. Returns `null` if no task matches.
   */
  resolve(ref: string | number): Task | null {
    const state = this.readState()
    return this.resolveFrom(ref, state.tasks, state.meta)
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  /**
   * Append a new task. Returns the created task. The id is freshly
   * generated; for subtasks the parent's children are scanned to pick
   * the next alpha suffix.
   *
   * `after` (top-level only): if set and resolves to a task, the new task
   * is inserted immediately after it instead of at the end. Ignored for
   * subtasks (children are always appended).
   */
  add(input: NewTaskInput, after?: string | number): Task {
    const status: TaskStatus = input.status ?? "todo"
    const created_at = localIsoSeconds(this.deps.now)
    const title = input.title.trim()
    if (title === "") {
      throw new TaskStoreError(`TaskStore.add: title cannot be empty`)
    }

    const state = this.readState()
    const tasks = state.tasks
    let id: string
    let canonicalParent: string | null = null

    if (input.parent !== undefined && input.parent !== null) {
      const parent = this.findParent(input.parent, tasks, state.meta)
      canonicalParent = parent.id
      const nextCounter =
        state.meta.next_child[parent.id] ?? this.nextChildCounter(parent.id, tasks)
      id = subtaskId(parent.id, nextCounter)
      state.meta.next_child[parent.id] = nextCounter + 1
    } else {
      id = String(state.meta.next_root++)
    }

    // Timing fields (schema v2). For the rare case of `add({status:
    // "doing"})` — opening straight into the running state — we stamp
    // started_at and last_resumed_at to created_at so the live elapsed
    // ticks from the same moment. Default `status: "todo"` (the only
    // common path) leaves the duration fields zeroed.
    const startedInDoing = status === "doing"
    const task: Task = {
      id,
      parent: canonicalParent,
      status,
      title,
      created_at,
      done_at: status === "done" ? created_at : null,
      reason: null,
      started_at: startedInDoing ? created_at : null,
      last_resumed_at: startedInDoing ? created_at : null,
      active_ms: 0,
    }

    // Insertion point.
    let insertAt = tasks.length
    if (task.parent === null && after !== undefined) {
      const anchor = this.resolveFrom(after, tasks, state.meta)
      if (anchor !== null && anchor.parent === null) {
        // Insert after the anchor AND after all of the anchor's existing
        // children, so subtasks stay clustered under their parent.
        const anchorIdx = tasks.indexOf(anchor)
        let lastInBlock = anchorIdx
        for (let i = anchorIdx + 1; i < tasks.length; i++) {
          if (tasks[i].parent === anchor.id) lastInBlock = i
          else if (tasks[i].parent === null) break
        }
        insertAt = lastInBlock + 1
      }
    } else if (task.parent !== null) {
      // Subtask: place right after the last existing sibling, or right
      // after the parent if no siblings yet.
      const parentIdx = tasks.findIndex((t) => t.id === task.parent)
      let lastSiblingIdx = parentIdx
      for (let i = parentIdx + 1; i < tasks.length; i++) {
        if (tasks[i].parent === task.parent) lastSiblingIdx = i
        else if (tasks[i].parent === null) break
      }
      insertAt = lastSiblingIdx + 1
    }

    const next = [...tasks.slice(0, insertAt), task, ...tasks.slice(insertAt)]
    this.writeState(state.meta, next)
    return task
  }

  /** Bulk variant of {@link add}, committed atomically in one rename. */
  addMany(titles: readonly string[], opts: { parent?: string | number } = {}): Task[] {
    const clean = titles.map((title) => title.trim())
    if (clean.some((title) => title === "")) {
      throw new TaskStoreError(`TaskStore.addMany: title cannot be empty`)
    }
    const state = this.readState()
    let parentId: string | null = null
    if (opts.parent !== undefined && opts.parent !== null) {
      const parent = this.resolveFrom(opts.parent, state.tasks, state.meta)
      if (parent === null)
        throw new TaskStoreError(`TaskStore.addMany: parent "${opts.parent}" not found`)
      if (parent.parent !== null) {
        throw new TaskStoreError(
          `TaskStore.addMany: parent "${opts.parent}" is itself a subtask (no nesting beyond depth 1)`,
        )
      }
      parentId = parent.id
    }
    const created_at = localIsoSeconds(this.deps.now)
    const out: Task[] = []
    let childCounter =
      parentId === null
        ? 0
        : (state.meta.next_child[parentId] ?? this.nextChildCounter(parentId, state.tasks))
    for (const title of clean) {
      const id =
        parentId === null ? String(state.meta.next_root++) : subtaskId(parentId, childCounter++)
      out.push({
        id,
        parent: parentId,
        status: "todo",
        title,
        created_at,
        done_at: null,
        reason: null,
        started_at: null,
        last_resumed_at: null,
        active_ms: 0,
      })
    }
    if (parentId === null) state.tasks.push(...out)
    else {
      state.meta.next_child[parentId] = childCounter
      const insertAt = this.endOfParentBlock(parentId, state.tasks)
      state.tasks.splice(insertAt, 0, ...out)
    }
    this.writeState(state.meta, state.tasks)
    return out
  }

  /** Replace the live board after complete preflight, allocating fresh ordinal ids. */
  replaceAll(inputs: readonly ReplaceTaskInput[]): Task[] {
    const prepared = inputs.map((input) => ({
      title: input.title.trim(),
      status: input.status ?? ("todo" as TaskStatus),
      children: (input.children ?? []).map((child) => ({
        title: child.title.trim(),
        status: child.status ?? ("todo" as TaskStatus),
      })),
    }))
    for (const input of prepared) {
      if (input.title === "" || input.children.some((child) => child.title === "")) {
        throw new TaskStoreError(`TaskStore.replaceAll: title cannot be empty`)
      }
      if (input.children.length > 26)
        throw new TaskStoreError(`TaskStore.replaceAll: too many children`)
    }
    const state = this.readState()
    const created_at = localIsoSeconds(this.deps.now)
    const tasks: Task[] = []
    const make = (id: string, parent: string | null, title: string, status: TaskStatus): Task => ({
      id,
      parent,
      title,
      status,
      created_at,
      done_at: status === "done" ? created_at : null,
      reason: null,
      started_at: status === "doing" ? created_at : null,
      last_resumed_at: status === "doing" ? created_at : null,
      active_ms: 0,
    })
    for (const input of prepared) {
      const rootId = String(state.meta.next_root++)
      tasks.push(make(rootId, null, input.title, input.status))
      input.children.forEach((child, index) => {
        tasks.push(make(subtaskId(rootId, index), rootId, child.title, child.status))
      })
      state.meta.next_child[rootId] = input.children.length
    }
    this.writeState(state.meta, tasks)
    return tasks
  }

  /** Edit a task's title. Returns the updated task or `null` if not found. */
  update(ref: string | number, title: string): Task | null {
    const trimmed = title.trim()
    if (trimmed === "") {
      throw new TaskStoreError(`TaskStore.update: title cannot be empty`)
    }
    const state = this.readState()
    const target = this.resolveFrom(ref, state.tasks, state.meta)
    if (target === null) return null
    const idx = state.tasks.indexOf(target)
    const updated: Task = { ...target, title: trimmed }
    state.tasks[idx] = updated
    this.writeState(state.meta, state.tasks)
    return updated
  }

  /**
   * Change a task's status. Delegates to {@link applyStatusTransition},
   * which:
   *  - stamps `done_at` when flipping TO `done` (and clears when flipping AWAY)
   *  - sets `reason` only when flipping TO `canceled`
   *  - stamps `started_at` on FIRST entry into `doing` (preserves on repeat)
   *  - stamps `last_resumed_at` on EVERY entry into `doing`, clears on exit
   *  - accrues `active_ms += now − last_resumed_at` on every `doing → other`
   *
   * ## Parent ↔ child lifecycle rollup
   *
   * The store keeps parent/child trees consistent in the same write (one
   * `nowPair` sample for the whole mutation):
   *
   *  - **Parent → done** cascades open children (`todo` / `doing`) to
   *    `done`. Children already `done` are left alone; `canceled`
   *    children stay `canceled` (abandoned work is not rewritten as
   *    finished).
   *  - **Child → doing** auto-starts a `todo` / `done` parent.
   *  - **Child → done or canceled** auto-promotes the parent to `done` when
   *    no sibling remains open (`todo` / `doing`). A canceled child remains
   *    visibly canceled, so a finished phase preserves its abandoned-work
   *    audit trail instead of being stranded in `doing`.
   *  - A `canceled` parent is never revived automatically.
   *
   * Child `todo` transitions stay explicit one-row mutations.
   */
  setStatus(ref: string | number, status: TaskStatus, reason?: string | null): Task | null {
    const state = this.readState()
    const tasks = state.tasks
    const target = this.resolveFrom(ref, tasks, state.meta)
    if (target === null) return null
    const idx = tasks.indexOf(target)
    const { nowIso, nowMs } = this.nowPair()

    const next = applyStatusTransition(target, status, nowIso, nowMs, reason)
    tasks[idx] = next

    if (status === "done") {
      this.applyDoneCascade(tasks, next, nowIso, nowMs)
    } else if (status === "canceled" && next.parent !== null) {
      this.applyChildTerminalRollup(tasks, next.parent, nowIso, nowMs)
    } else if (status === "doing" && next.parent !== null) {
      this.applyParentDoing(tasks, next.parent, nowIso, nowMs)
    }

    this.writeState(state.meta, tasks)
    // Re-read the target from the (possibly cascaded) array so the
    // returned Task reflects any parent-side rollup that rewrote it.
    return tasks.find((t) => t.id === next.id) ?? next
  }

  /**
   * In-place parent/child consistency for a just-applied `done`
   * transition. Mutates `tasks`; caller owns the write. See
   * {@link setStatus} for the cascade rules.
   */
  private applyDoneCascade(tasks: Task[], target: Task, nowIso: string, nowMs: number): void {
    if (target.parent === null) {
      // Parent done → cascade open children. Canceled stays canceled.
      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i]
        if (t.parent !== target.id) continue
        if (t.status === "done" || t.status === "canceled") continue
        tasks[i] = applyStatusTransition(t, "done", nowIso, nowMs)
      }
      return
    }

    this.applyChildTerminalRollup(tasks, target.parent, nowIso, nowMs)
  }

  /**
   * Promote a parent when all of its children reached a terminal state.
   * Canceled children remain canceled. They record abandoned scope without
   * leaving a phase permanently `doing` after the remaining work finishes.
   */
  private applyChildTerminalRollup(
    tasks: Task[],
    parentId: string,
    nowIso: string,
    nowMs: number,
  ): void {
    const parentIdx = tasks.findIndex((t) => t.id === parentId)
    if (parentIdx < 0) return
    const parent = tasks[parentIdx]
    if (parent.status === "canceled") return

    const hasOpenChild = tasks.some(
      (t) => t.parent === parent.id && (t.status === "todo" || t.status === "doing"),
    )
    if (!hasOpenChild) {
      tasks[parentIdx] = applyStatusTransition(parent, "done", nowIso, nowMs)
    } else {
      this.applyParentDoing(tasks, parent.id, nowIso, nowMs)
    }
  }

  /** Auto-start a parent unless it is already doing or explicitly canceled. */
  private applyParentDoing(tasks: Task[], parentId: string, nowIso: string, nowMs: number): void {
    const parentIdx = tasks.findIndex((t) => t.id === parentId)
    if (parentIdx < 0) return
    const parent = tasks[parentIdx]
    if (parent.status === "doing" || parent.status === "canceled") return
    tasks[parentIdx] = applyStatusTransition(parent, "doing", nowIso, nowMs)
  }

  /**
   * Atomic "start working on this task" — flips it to `doing`.
   *
   * Other tasks already in `doing` stay `doing`. `start` never demotes
   * siblings or peers; leave `doing` only via `done`, `canceled`, or an
   * explicit `status: "todo"`. That way the rendered list keeps every
   * previously started row as started until it is finished or abandoned.
   *
   * `opts.parallel` is accepted for API compatibility and ignored.
   */
  start(ref: string | number, _opts: { parallel?: boolean } = {}): Task | null {
    const state = this.readState()
    const tasks = state.tasks
    const target = this.resolveFrom(ref, tasks, state.meta)
    if (target === null) return null
    const { nowIso, nowMs } = this.nowPair()

    const idx = tasks.indexOf(target)
    const next = applyStatusTransition(target, "doing", nowIso, nowMs)
    tasks[idx] = next
    if (next.parent !== null) {
      this.applyParentDoing(tasks, next.parent, nowIso, nowMs)
    }
    this.writeState(state.meta, tasks)
    return next
  }

  /** Shorthand for `setStatus(ref, "done")`. */
  done(ref: string | number): Task | null {
    return this.setStatus(ref, "done")
  }

  /**
   * Remove a task and (cascading) any of its subtasks. Returns the
   * removed tasks (in file order) or `[]` if not found.
   */
  remove(ref: string | number): Task[] {
    const state = this.readState()
    const tasks = state.tasks
    const target = this.resolveFrom(ref, tasks, state.meta)
    if (target === null) return []
    const toRemove = new Set<string>([target.id])
    // Cascade subtasks.
    for (const t of tasks) {
      if (t.parent === target.id) toRemove.add(t.id)
    }
    const removed: Task[] = []
    const next: Task[] = []
    for (const t of tasks) {
      if (toRemove.has(t.id)) removed.push(t)
      else next.push(t)
    }
    this.writeState(state.meta, next)
    return removed
  }

  /**
   * Reorder TOP-LEVEL tasks. `order` is an array of ids (top-level only)
   * in the desired new order. Tasks not in `order` are appended at the
   * end in their previous relative order. Subtasks ride along with their
   * parent and keep their internal order.
   *
   * Returns the full new task list.
   */
  reorder(order: readonly (string | number)[]): Task[] {
    const state = this.readState()
    const tasks = state.tasks
    const resolved: string[] = []
    const seen = new Set<string>()
    for (const ref of order) {
      const t = this.resolveFrom(ref, tasks, state.meta)
      if (t === null) {
        throw new TaskStoreError(`TaskStore.reorder: id "${ref}" not found`)
      }
      if (t.parent !== null) {
        throw new TaskStoreError(
          `TaskStore.reorder: id "${ref}" is a subtask; reorder operates on top-level tasks only`,
        )
      }
      if (seen.has(t.id)) {
        throw new TaskStoreError(`TaskStore.reorder: duplicate id "${ref}" in order`)
      }
      resolved.push(t.id)
      seen.add(t.id)
    }
    // Group tasks by top-level id (each group: the top-level task + its subtasks in file order).
    const groups = new Map<string, Task[]>()
    let currentTop: string | null = null
    for (const t of tasks) {
      if (t.parent === null) {
        currentTop = t.id
        groups.set(currentTop, [t])
      } else if (currentTop !== null && t.parent === currentTop) {
        groups.get(currentTop)!.push(t)
      } else {
        // Orphaned subtask — shouldn't happen in well-formed files. Drop
        // it into the parent's group if we have one, else leave it
        // attached to the current top (best-effort).
        const arr = groups.get(t.parent) ?? groups.get(currentTop ?? "")
        if (arr !== undefined) arr.push(t)
      }
    }
    // Build the new order: requested ids first, then any top-level ids
    // not mentioned, in their previous relative order.
    const finalIds: string[] = [...resolved]
    for (const id of groups.keys()) {
      if (!seen.has(id)) finalIds.push(id)
    }
    const next: Task[] = []
    for (const id of finalIds) {
      const grp = groups.get(id)
      if (grp) next.push(...grp)
    }
    this.writeState(state.meta, next)
    return next
  }

  /**
   * Wipe ALL tasks for this session. If any task is `doing` and
   * `force !== true`, throws to protect against accidental loss of
   * in-flight state.
   */
  clear(force: boolean = false): number {
    const state = this.readState()
    const tasks = state.tasks
    if (!force && tasks.some((t) => t.status === "doing")) {
      throw new TaskStoreError(
        `TaskStore.clear: refusing to clear with tasks in "doing" state; pass force: true to override`,
      )
    }
    this.writeState(state.meta, [])
    return tasks.length
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private findParent(ref: string | number, tasks: readonly Task[], meta?: TasksMeta): Task {
    const parent = this.resolveFrom(ref, tasks, meta)
    if (parent === null) {
      throw new TaskStoreError(`TaskStore: parent "${ref}" not found`)
    }
    if (parent.parent !== null) {
      throw new TaskStoreError(
        `TaskStore: "${ref}" is itself a subtask; depth-2 nesting is not allowed`,
      )
    }
    return parent
  }

  /** Resolve against an already-loaded task list (saves a re-read). */
  private resolveFrom(ref: string | number, tasks: readonly Task[], meta?: TasksMeta): Task | null {
    if (typeof ref === "number") {
      if (!Number.isInteger(ref) || ref < 1) return null
      return tasks.find((task) => task.id === String(ref)) ?? null
    }
    const bare = ref.startsWith("#") ? ref.slice(1) : ref
    const direct = tasks.find((task) => task.id === bare)
    if (direct !== undefined) return direct
    const aliases = meta?.aliases ?? this.metadata().aliases
    const canonical = aliases[bare]
    return canonical === undefined ? null : (tasks.find((task) => task.id === canonical) ?? null)
  }

  private readState(): { meta: TasksMeta; tasks: Task[] } {
    if (!existsSync(this.path)) {
      const state = { meta: createTasksMeta(), tasks: [] as Task[] }
      this.writeState(state.meta, state.tasks)
      return state
    }
    const parsed = parseTasksFile(readFileSync(this.path, "utf8"))
    if (parsed.meta !== null) {
      const ordinalTasks = parsed.tasks.filter(
        (task) =>
          /^[1-9]\d*[a-z]?$/.test(task.id) &&
          (task.parent === null || /^[1-9]\d*$/.test(task.parent)),
      )
      const maxRoot = ordinalTasks.reduce(
        (max, task) => (task.parent === null ? Math.max(max, Number(task.id)) : max),
        0,
      )
      if (parsed.meta.next_root <= maxRoot) parsed.meta.next_root = maxRoot + 1
      for (const task of ordinalTasks) {
        if (task.parent === null) continue
        const suffix = task.id.charCodeAt(task.id.length - 1) - "a".charCodeAt(0) + 1
        parsed.meta.next_child[task.parent] = Math.max(
          parsed.meta.next_child[task.parent] ?? 0,
          suffix,
        )
      }
      return { meta: parsed.meta, tasks: ordinalTasks }
    }

    const aliases: Record<string, string> = {}
    const rootMap = new Map<string, string>()
    let nextRoot = 1
    for (const task of parsed.tasks) {
      if (task.parent === null) rootMap.set(task.id, String(nextRoot++))
    }
    const childCounts = new Map<string, number>()
    const tasks: Task[] = []
    for (const task of parsed.tasks) {
      const oldId = task.id
      if (task.parent === null) {
        const id = rootMap.get(oldId)!
        aliases[oldId] = id
        tasks.push({ ...task, id })
        continue
      }
      const parent = rootMap.get(task.parent)
      if (parent === undefined) continue
      const index = childCounts.get(task.parent) ?? 0
      childCounts.set(task.parent, index + 1)
      const id = subtaskId(parent, index)
      aliases[oldId] = id
      tasks.push({ ...task, id, parent })
    }
    const next_child = Object.fromEntries(
      [...childCounts].map(([legacyParent, next]) => [rootMap.get(legacyParent)!, next]),
    )
    const meta = createTasksMeta({ next_root: nextRoot, next_child, aliases })
    this.writeState(meta, tasks)
    return { meta, tasks }
  }

  private writeState(meta: TasksMeta, tasks: readonly Task[]): void {
    const dir = dirname(this.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const tempPath = `${this.path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
    try {
      writeFileSync(tempPath, serializeTasksFile(meta, tasks), "utf8")
      this.deps.beforeRename?.(tempPath)
      renameSync(tempPath, this.path)
    } catch (error) {
      rmSync(tempPath, { force: true })
      throw error
    }
  }

  private nextChildCounter(parentId: string, tasks: readonly Task[]): number {
    const suffixes = tasks
      .filter((task) => task.parent === parentId && isSubtaskId(task.id))
      .map((task) => task.id.charCodeAt(task.id.length - 1) - 97)
    return suffixes.length === 0 ? 0 : Math.max(...suffixes) + 1
  }

  private endOfParentBlock(parentId: string, tasks: readonly Task[]): number {
    const parentIndex = tasks.findIndex((task) => task.id === parentId)
    let end = parentIndex + 1
    while (end < tasks.length && tasks[end].parent === parentId) end++
    return end
  }

  /**
   * Resolve "now" exactly once into a paired ISO+epoch tuple. Using a
   * single sample for both representations avoids tiny millisecond
   * drift between the ISO timestamp stamped on `started_at` /
   * `last_resumed_at` and the epoch number fed to
   * {@link applyStatusTransition}'s accrual math (which has to subtract
   * `Date.parse(last_resumed_at)` from `nowMs` and would underflow by
   * 1ms if the two samples crossed a second boundary).
   *
   * Both come from the same injected `deps.now` (or wall clock).
   */
  private nowPair(): { nowIso: string; nowMs: number } {
    const nowDate = this.deps.now?.() ?? new Date()
    const nowMs = nowDate.getTime()
    // Hand the same Date back to localIsoSeconds so the ISO and epoch
    // are derived from one observation.
    const nowIso = localIsoSeconds(() => nowDate)
    return { nowIso, nowMs }
  }
}
