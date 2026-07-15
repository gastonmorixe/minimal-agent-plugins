/**
 * `Task` tool — the model-facing CRUD interface for per-session tasks.
 *
 * Dispatch shape mirrors `MemoryTool` exactly: one tool, action switch,
 * per-action validation. Every action returns the post-mutation task
 * body in `display`, with `displayHeader` and `displayFooter` letting
 * the host tool frame own the box glyphs.
 *
 * ## Actions
 *
 * - `add`         — append a new task (optionally as a subtask via `parent`).
 * - `add_many`    — bulk append (one call, full plan). Accepts flat `titles`
 *                   or a depth-2 `items` tree (`{title, children?}`).
 * - `update`      — change a task's title.
 * - `status`      — set status to todo/doing/done/canceled.
 * - `start`       — sugar for status=doing (keeps other doing tasks as doing).
 * - `done`        — sugar for status=done.
 * - `remove`      — delete a task (cascades to subtasks).
 * - `reorder`     — reorder top-level tasks.
 * - `list`        — render the current state without mutating.
 * - `clear`       — wipe all tasks (refuses if any is `doing`, override with `force`).
 *
 * ## Id resolution
 *
 * Every `id`-taking action accepts:
 *  - `"#a7b3c4"` / `"a7b3c4"` (top-level)
 *  - `"#a7b3c4a"` / `"a7b3c4a"` (subtask)
 *  - `"3"` or `3` (1-indexed top-level position)
 *
 * @module tasks/handlers/task_tool
 */

import type { TUIContext, TUIResult } from "../lib/host-types.ts"
import { renderTasksAgentBlock, type TaskModelMeta } from "../lib/model-render.ts"
import { isTaskStatus, MAX_SUBTASKS_PER_PARENT, type Task, type TaskStatus } from "../lib/parse.ts"
import { type RenderAction, renderToolDisplay } from "../lib/render.ts"
import { buildViews, TaskStore, TaskStoreError, type View } from "../lib/store.ts"

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

type Action =
  | "add"
  | "add_many"
  | "update"
  | "status"
  | "start"
  | "done"
  | "remove"
  | "reorder"
  | "list"
  | "clear"

const VALID_ACTIONS = new Set<Action>([
  "add",
  "add_many",
  "update",
  "status",
  "start",
  "done",
  "remove",
  "reorder",
  "list",
  "clear",
])

const VALID_FILTERS = new Set(["all", "active", "done", "canceled"])
const VALID_FORMATS = new Set(["text", "json"])

/** One top-level node for tree-shaped `add_many` (`items`). */
interface AddManyItem {
  title: string
  /** Optional subtask titles (depth 2 only: strings, not nested objects). */
  children?: string[]
}

interface ParsedInput {
  action: Action
  id?: string | number
  title?: string
  titles?: string[]
  /** Tree form for `add_many`. Mutually exclusive with `titles`. */
  items?: AddManyItem[]
  parent?: string | number
  after?: string | number
  status?: TaskStatus
  reason?: string
  order?: (string | number)[]
  filter?: "all" | "active" | "done" | "canceled"
  query?: string
  format?: "text" | "json"
  parallel?: boolean
  force?: boolean
}

type Validation = { ok: true; value: ParsedInput } | { ok: false; error: string }

function isIdRef(v: unknown): v is string | number {
  if (typeof v === "number") return Number.isInteger(v) && v >= 1
  if (typeof v !== "string") return false
  const trimmed = v.trim()
  return trimmed.length > 0
}

function validateInput(raw: Record<string, unknown>): Validation {
  if (typeof raw.action !== "string" || !VALID_ACTIONS.has(raw.action as Action)) {
    return { ok: false, error: `\`action\` must be one of: ${[...VALID_ACTIONS].join(", ")}` }
  }
  const action = raw.action as Action

  const out: ParsedInput = { action }

  // id (string or integer position)
  if (raw.id !== undefined) {
    if (!isIdRef(raw.id)) {
      return { ok: false, error: "`id` must be a non-empty string or positive integer" }
    }
    out.id = raw.id as string | number
  }

  // title
  if (raw.title !== undefined) {
    if (typeof raw.title !== "string" || raw.title.trim().length === 0) {
      return { ok: false, error: "`title` must be a non-empty string" }
    }
    out.title = raw.title
  }

  // titles
  if (raw.titles !== undefined) {
    if (!Array.isArray(raw.titles) || raw.titles.length === 0) {
      return { ok: false, error: "`titles` must be a non-empty array of strings" }
    }
    if (!raw.titles.every((s) => typeof s === "string" && s.trim().length > 0)) {
      return { ok: false, error: "every entry in `titles` must be a non-empty string" }
    }
    out.titles = raw.titles as string[]
  }

  // items (tree-shaped add_many: top-level + optional string children)
  if (raw.items !== undefined) {
    if (!Array.isArray(raw.items) || raw.items.length === 0) {
      return { ok: false, error: "`items` must be a non-empty array of objects" }
    }
    const items: AddManyItem[] = []
    for (let i = 0; i < raw.items.length; i++) {
      const entry = raw.items[i]
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        return { ok: false, error: `every entry in \`items\` must be an object (index ${i})` }
      }
      const rec = entry as Record<string, unknown>
      if (typeof rec.title !== "string" || rec.title.trim().length === 0) {
        return {
          ok: false,
          error: `every entry in \`items\` must have a non-empty string \`title\` (index ${i})`,
        }
      }
      const item: AddManyItem = { title: rec.title }
      if (rec.children !== undefined) {
        if (!Array.isArray(rec.children)) {
          return {
            ok: false,
            error: `\`items[${i}].children\` must be an array of strings when present`,
          }
        }
        if (rec.children.length === 0) {
          return {
            ok: false,
            error: `\`items[${i}].children\` must be non-empty when present (omit it instead)`,
          }
        }
        if (!rec.children.every((s) => typeof s === "string" && s.trim().length > 0)) {
          return {
            ok: false,
            error: `every entry in \`items[${i}].children\` must be a non-empty string`,
          }
        }
        // Preflight max children (a–z) so we never create a parent then fail mid-write.
        if (rec.children.length > MAX_SUBTASKS_PER_PARENT) {
          return {
            ok: false,
            error:
              `\`items[${i}].children\` has ${rec.children.length} entries; ` +
              `max ${MAX_SUBTASKS_PER_PARENT} subtasks per parent`,
          }
        }
        // Depth-2 only: children are titles, not nested objects.
        item.children = rec.children as string[]
      }
      // Mirror manifest additionalProperties:false — only title + children.
      for (const key of Object.keys(rec)) {
        if (key !== "title" && key !== "children") {
          return {
            ok: false,
            error:
              `\`items[${i}]\` only accepts \`title\` and optional \`children\` (string[]); ` +
              `unknown key "${key}"`,
          }
        }
      }
      items.push(item)
    }
    out.items = items
  }

  // parent
  if (raw.parent !== undefined && raw.parent !== null) {
    if (!isIdRef(raw.parent)) {
      return { ok: false, error: "`parent` must be a non-empty string or positive integer" }
    }
    out.parent = raw.parent as string | number
  }

  // after
  if (raw.after !== undefined) {
    if (!isIdRef(raw.after)) {
      return { ok: false, error: "`after` must be a non-empty string or positive integer" }
    }
    out.after = raw.after as string | number
  }

  // status
  if (raw.status !== undefined) {
    if (!isTaskStatus(raw.status)) {
      return { ok: false, error: `\`status\` must be one of: todo, doing, done, canceled` }
    }
    out.status = raw.status
  }

  // reason
  if (raw.reason !== undefined) {
    if (typeof raw.reason !== "string") {
      return { ok: false, error: "`reason` must be a string" }
    }
    out.reason = raw.reason
  }

  // order
  if (raw.order !== undefined) {
    if (!Array.isArray(raw.order) || raw.order.length === 0) {
      return { ok: false, error: "`order` must be a non-empty array of ids" }
    }
    if (!raw.order.every((r) => isIdRef(r))) {
      return {
        ok: false,
        error: "every entry in `order` must be a non-empty string or positive integer",
      }
    }
    out.order = raw.order as (string | number)[]
  }

  // filter
  if (raw.filter !== undefined) {
    if (typeof raw.filter !== "string" || !VALID_FILTERS.has(raw.filter)) {
      return { ok: false, error: `\`filter\` must be one of: ${[...VALID_FILTERS].join(", ")}` }
    }
    out.filter = raw.filter as ParsedInput["filter"]
  }

  // query
  if (raw.query !== undefined) {
    if (typeof raw.query !== "string") {
      return { ok: false, error: "`query` must be a string" }
    }
    out.query = raw.query
  }

  // format
  if (raw.format !== undefined) {
    if (typeof raw.format !== "string" || !VALID_FORMATS.has(raw.format)) {
      return { ok: false, error: `\`format\` must be one of: text, json` }
    }
    out.format = raw.format as "text" | "json"
  }

  // parallel
  if (raw.parallel !== undefined) {
    if (typeof raw.parallel !== "boolean") {
      return { ok: false, error: "`parallel` must be a boolean" }
    }
    out.parallel = raw.parallel
  }

  // force
  if (raw.force !== undefined) {
    if (typeof raw.force !== "boolean") {
      return { ok: false, error: "`force` must be a boolean" }
    }
    out.force = raw.force
  }

  // Per-action required-field check.
  const need = REQUIRED_FIELDS[action]
  for (const f of need) {
    if (out[f] === undefined) {
      return { ok: false, error: `\`${f}\` is required for action="${action}"` }
    }
  }

  // items is only meaningful for add_many (schema is flat; reject misuse).
  if (out.items !== undefined && action !== "add_many") {
    return {
      ok: false,
      error: `\`items\` is only valid for action="add_many" (got "${action}")`,
    }
  }

  // add_many: titles XOR items. parent only with flat titles. after not supported.
  if (action === "add_many") {
    const hasTitles = out.titles !== undefined
    const hasItems = out.items !== undefined
    if (!hasTitles && !hasItems) {
      return {
        ok: false,
        error:
          "`add_many` requires either `titles` (flat) or `items` (tree with optional children)",
      }
    }
    if (hasTitles && hasItems) {
      return {
        ok: false,
        error: '`titles` and `items` are mutually exclusive for action="add_many"',
      }
    }
    if (hasItems && out.parent !== undefined) {
      return {
        ok: false,
        error:
          "`parent` cannot be combined with `items` (the tree defines parents; use `children` instead)",
      }
    }
    if (out.after !== undefined) {
      return {
        ok: false,
        error: '`after` is only valid for action="add" (not add_many)',
      }
    }
  }

  return { ok: true, value: out }
}

const REQUIRED_FIELDS: Record<Action, readonly (keyof ParsedInput)[]> = {
  add: ["title"],
  // add_many: custom titles XOR items check above (not a single required field).
  add_many: [],
  update: ["id", "title"],
  status: ["id", "status"],
  start: ["id"],
  done: ["id"],
  remove: ["id"],
  reorder: ["order"],
  list: [],
  clear: [],
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore(sid: string | null, env: Record<string, string>): TaskStore | null {
  if (sid === null || sid.trim().length === 0) return null
  return new TaskStore(sid, env.HOME ? { home: env.HOME } : {})
}

function modelMeta(action: RenderAction, inputAction?: string, targetHash?: string): TaskModelMeta {
  const meta: TaskModelMeta = {}
  if (inputAction) meta.action = inputAction
  if (targetHash) meta.id = targetHash
  switch (action.kind) {
    case "added":
    case "started":
    case "updated":
    case "removed":
      meta.result = action.kind
      meta.id = action.hash
      break
    case "marked_done":
    case "marked_doing":
    case "marked_todo":
    case "marked_canceled":
      meta.result = action.kind
      meta.id = action.hash
      break
    case "added_many":
    case "reordered":
    case "cleared":
    case "all_done":
    case "list":
      meta.result = action.kind
      break
    default:
      void (action satisfies never)
  }
  return meta
}

function renderResult(
  store: TaskStore,
  action: RenderAction,
  format: "text" | "json" = "text",
  viewsOverride?: readonly View[],
  inputAction?: string,
  targetHash?: string,
): { content: string; display: string; displayHeader: string; displayFooter: string } {
  // `viewsOverride` lets the handler inject augmented views (ghost rows
  // for `remove`, diff overlays for `update`) so the user sees WHAT
  // changed rather than only the post-state. Stats are always
  // post-mutation — the overlay is purely visual residue.
  const views = viewsOverride ?? store.views()
  const stats = store.stats()
  const displayParts = renderToolDisplay(views, stats, { ansi: true, action })
  const tasks = store.list()
  if (format === "json") {
    return {
      content: JSON.stringify({ stats, tasks }, null, 2),
      display: displayParts.body,
      displayHeader: displayParts.header,
      displayFooter: displayParts.footer,
    }
  }
  return {
    content: renderTasksAgentBlock(tasks, stats, modelMeta(action, inputAction, targetHash)),
    display: displayParts.body,
    displayHeader: displayParts.header,
    displayFooter: displayParts.footer,
  }
}

function ok(
  store: TaskStore,
  action: RenderAction,
  format?: "text" | "json",
  viewsOverride?: readonly View[],
  inputAction?: string,
  targetHash?: string,
): TUIResult {
  const rendered = renderResult(
    store,
    action,
    format ?? "text",
    viewsOverride,
    inputAction,
    targetHash,
  )
  return {
    kind: "tool_result",
    content: rendered.content,
    display: rendered.display,
    displayHeader: rendered.displayHeader,
    displayFooter: rendered.displayFooter,
    // The renderer already emits the trailing ` · YYYY-MM-DD HH:MM:SS`
    // chrome inside the displayHeader (so the date+year is always
    // visible on every task block). Suppress the agent's automatic
    // `· HH:MM:SS` suffix so the time isn't duplicated.
    suppressToolTime: true,
  }
}

/**
 * Build views from the PRE-removal task list, with `ghost: "removed"`
 * stamped on the rows that no longer exist post-mutation. The result
 * has the deleted task(s) re-injected at their original position with
 * the original numbering, so the renderer can show "row 3 was here, X'd
 * out" rather than silently collapsing.
 */
function viewsWithGhostRemoved(
  beforeTasks: readonly Task[],
  removedIds: ReadonlySet<string>,
): View[] {
  // `buildViews` returns a fresh `View[]` with fresh `View` objects every
  // call (see `lib/store.ts`), so we can mutate in place. The previous
  // shape `(v) => { ...v, ghost: "removed" as const }` inside `.map`
  // tripped oxlint's `no-map-spread` (one fresh allocation per element
  // is wasteful when the source array isn't shared). One pass, no
  // extra allocation, identical semantics.
  const views = buildViews(beforeTasks)
  for (const v of views) {
    if (removedIds.has(v.task.id)) v.ghost = "removed"
  }
  return views
}

function err(message: string): TUIResult {
  return { kind: "tool_result", content: `Task: ${message}`, is_error: true }
}

// ---------------------------------------------------------------------------
// Default export — tool dispatch
// ---------------------------------------------------------------------------

/**
 * Tool handler for `Task`: routes the action (add, add_many, start, done,
 * status, remove, reorder, list, clear) to the task store and renders the
 * post-mutation list.
 */
export default async function taskToolHandler(ctx: TUIContext): Promise<TUIResult> {
  if (ctx.trigger.type !== "tool") {
    return err("wrong trigger type (expected tool)")
  }
  const v = validateInput(ctx.trigger.input)
  if (!v.ok) return err(v.error)
  const input = v.value

  const sid = ctx.env.MINIMAL_AGENT_SESSION_ID?.trim() || null
  const store = makeStore(sid, ctx.env)
  if (store === null) {
    return err(
      `Task: a session id is required, but none is plumbed through ` +
        `(MINIMAL_AGENT_SESSION_ID is empty).`,
    )
  }

  // Defensive: never write inside the plugin tree.
  if (store.path.startsWith(`${ctx.packageDir}/`)) {
    return err(`refused write under packageDir (${store.path})`)
  }

  try {
    switch (input.action) {
      case "add":
        return doAdd(store, input)
      case "add_many":
        return doAddMany(store, input)
      case "update":
        return doUpdate(store, input)
      case "status":
        return doStatus(store, input)
      case "start":
        return doStart(store, input)
      case "done":
        return doDone(store, input)
      case "remove":
        return doRemove(store, input)
      case "reorder":
        return doReorder(store, input)
      case "list":
        return doList(store, input)
      case "clear":
        return doClear(store, input)
      default: {
        return err(`unhandled action ${String(input.action satisfies never)}`)
      }
    }
  } catch (e) {
    if (e instanceof TaskStoreError) return err(e.message.replace(/^TaskStore[.\s]*/, ""))
    const msg = e instanceof Error ? e.message : String(e)
    return err(msg)
  }
}

// ---------------------------------------------------------------------------
// Per-action implementations
// ---------------------------------------------------------------------------

function doAdd(store: TaskStore, input: ParsedInput): TUIResult {
  const task = store.add(
    {
      title: input.title!,
      parent: input.parent === undefined ? null : (store.resolve(input.parent)?.id ?? null),
      status: input.status,
    },
    input.after,
  )
  if (input.parent !== undefined && task.parent === null) {
    // Parent reference didn't resolve. Remove the task and surface the error.
    store.remove(task.id)
    return err(`parent "${input.parent}" not found`)
  }
  return ok(store, { kind: "added", hash: task.id }, input.format, undefined, input.action)
}

function doAddMany(store: TaskStore, input: ParsedInput): TUIResult {
  // Tree form: create each top-level parent, then its string children under it.
  // children.length preflight lives in validateInput (before any write).
  if (input.items !== undefined) {
    const created: ReturnType<TaskStore["add"]>[] = []
    for (const item of input.items) {
      const parent = store.add({ title: item.title })
      created.push(parent)
      if (item.children !== undefined && item.children.length > 0) {
        created.push(...store.addMany(item.children, { parent: parent.id }))
      }
    }
    return ok(
      store,
      { kind: "added_many", count: created.length },
      input.format,
      undefined,
      input.action,
    )
  }

  // Flat form: optional shared parent for every title.
  let parentId: string | null = null
  if (input.parent !== undefined) {
    const parent = store.resolve(input.parent)
    if (parent === null) return err(`parent "${input.parent}" not found`)
    if (parent.parent !== null) {
      return err(`parent "${input.parent}" is a subtask; depth-2 nesting is not allowed`)
    }
    parentId = parent.id
    // Preflight: existing kids + new titles must fit a–z (avoid partial write).
    const existingKids = store.list().filter((t) => t.parent === parentId).length
    const incoming = input.titles!.length
    if (existingKids + incoming > MAX_SUBTASKS_PER_PARENT) {
      return err(
        `parent "#${parentId}" would have ${existingKids + incoming} subtasks ` +
          `(${existingKids} existing + ${incoming} new); max ${MAX_SUBTASKS_PER_PARENT}`,
      )
    }
  }
  const tasks = store.addMany(input.titles!, parentId ? { parent: parentId } : {})
  return ok(
    store,
    { kind: "added_many", count: tasks.length },
    input.format,
    undefined,
    input.action,
  )
}

function doUpdate(store: TaskStore, input: ParsedInput): TUIResult {
  // Capture the old title BEFORE the mutation so the renderer can show
  // `<old struck through>  →  <new>` inline instead of silently swapping
  // the title.
  const before = store.resolve(input.id!)
  const oldTitle = before?.title ?? null
  const updated = store.update(input.id!, input.title!)
  if (updated === null) return err(`id "${input.id}" not found`)
  const views = store.views()
  // Skip the diff overlay when nothing actually changed (whitespace-only
  // edit, or update to the same string) — showing `x  →  x` is noise.
  const augmented: readonly View[] =
    oldTitle !== null && oldTitle !== updated.title
      ? views.map((v) => (v.task.id === updated.id ? { ...v, diff: { oldTitle } } : v))
      : views
  return ok(store, { kind: "updated", hash: updated.id }, input.format, augmented, input.action)
}

function doStatus(store: TaskStore, input: ParsedInput): TUIResult {
  const target = store.resolve(input.id!)
  if (target === null) return err(`id "${input.id}" not found`)
  const updated = store.setStatus(target.id, input.status!, input.reason)
  if (updated === null) return err(`id "${input.id}" not found`)
  // "ALL DONE" when every row is done. Parent↔child rollup means finishing
  // the last open child can complete the whole plan too, so check stats
  // regardless of whether the target was top-level or a subtask.
  if (input.status === "done") {
    const s = store.stats()
    if (s.total > 0 && s.done === s.total) {
      return ok(store, { kind: "all_done" }, input.format, undefined, input.action, updated.id)
    }
  }
  const action: RenderAction =
    input.status === "done"
      ? { kind: "marked_done", hash: updated.id }
      : input.status === "doing"
        ? { kind: "marked_doing", hash: updated.id }
        : input.status === "canceled"
          ? { kind: "marked_canceled", hash: updated.id }
          : { kind: "marked_todo", hash: updated.id }
  return ok(store, action, input.format, undefined, input.action)
}

function doStart(store: TaskStore, input: ParsedInput): TUIResult {
  const target = store.resolve(input.id!)
  if (target === null) return err(`id "${input.id}" not found`)
  const updated = store.start(target.id, { parallel: input.parallel })
  if (updated === null) return err(`id "${input.id}" not found`)
  return ok(store, { kind: "started", hash: updated.id }, input.format, undefined, input.action)
}

function doDone(store: TaskStore, input: ParsedInput): TUIResult {
  const target = store.resolve(input.id!)
  if (target === null) return err(`id "${input.id}" not found`)
  const updated = store.done(target.id)
  if (updated === null) return err(`id "${input.id}" not found`)
  // Same as doStatus: rollup can complete the plan via a last-child done.
  const s = store.stats()
  if (s.total > 0 && s.done === s.total) {
    return ok(store, { kind: "all_done" }, input.format, undefined, input.action, updated.id)
  }
  return ok(store, { kind: "marked_done", hash: updated.id }, input.format, undefined, input.action)
}

function doRemove(store: TaskStore, input: ParsedInput): TUIResult {
  // Snapshot pre-mutation tasks so we can re-inject the just-removed
  // task(s) as ghost rows in the rendered output. The user sees the
  // tombstone (red ✘ + red strikethrough title) instead of a silent
  // disappearance.
  const beforeTasks = store.list()
  const target = store.resolve(input.id!)
  if (target === null) return err(`id "${input.id}" not found`)
  const removed = store.remove(target.id)
  const removedIds = new Set(removed.map((t) => t.id))
  const augmented = viewsWithGhostRemoved(beforeTasks, removedIds)
  return ok(store, { kind: "removed", hash: target.id }, input.format, augmented, input.action)
}

function doReorder(store: TaskStore, input: ParsedInput): TUIResult {
  store.reorder(input.order!)
  return ok(store, { kind: "reordered" }, input.format, undefined, input.action)
}

function doList(store: TaskStore, input: ParsedInput): TUIResult {
  // Filter/query are applied for VIEW only — the underlying store is
  // untouched. Currently `list` always renders the full set (filtering is
  // a future refinement); we still validate the field so the model isn't
  // surprised by silent ignores.
  void input.filter
  void input.query
  return ok(store, { kind: "list" }, input.format, undefined, input.action)
}

function doClear(store: TaskStore, input: ParsedInput): TUIResult {
  const before = store.stats().total
  store.clear(input.force ?? false)
  return ok(store, { kind: "cleared", count: before }, input.format, undefined, input.action)
}
