/* eslint-disable max-lines -- cohesive Task validation and action dispatch surface */
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
 * - `add_many`    — bulk append. Prefers `tasks` (`{title, children?}[]`);
 *                   aliases: `items` (same), flat `titles`.
 * - `replace_plan`— explicitly replace the whole board with a bulk plan.
 * - `update`      — change a task's title and/or status. At least one of
 *                   `title` or `status` must be provided.
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
 * Every `id`-taking action accepts the canonical id shown by the board:
 * ordinal roots such as `3`, and child ids such as `3a`. The store alone
 * retains silent compatibility with legacy persisted references.
 *
 * @module tasks/handlers/task_tool
 */

import { coerceJsonArray } from "../lib/coerce-json-array.ts"
import type { TUIContext, TUIResult } from "../lib/host-types.ts"
import {
  renderTasksToolContent,
  type TaskModelMeta,
  type TaskToolMeta,
} from "../lib/model-render.ts"
import { isTaskStatus, MAX_SUBTASKS_PER_PARENT, type Task, type TaskStatus } from "../lib/parse.ts"
import { type RenderAction, renderToolDisplay } from "../lib/render.ts"
import { tasksFullResults } from "../lib/result-verbosity.ts"
import { renderStatusResult } from "../lib/status-result.ts"
import { buildViews, TaskStore, TaskStoreError, type View } from "../lib/store.ts"

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

type Action =
  | "add"
  | "add_many"
  | "replace_plan"
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
  "replace_plan",
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

/** One top-level node for tree-shaped `add_many` (`tasks` / `items`). */
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
  /**
   * Primary tree form for `add_many`: `{title, children?}[]`.
   * Aliases: `items` (same shape), `titles` (flat string[] → no children).
   * At most one of `tasks` / `items` / `titles`.
   */
  tasks?: AddManyItem[]
  /** @deprecated Alias of `tasks`. Prefer `tasks`. */
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
  fullResults?: boolean
  /** Fields that arrived as JSON strings and were coerced to arrays. */
  coerced?: string[]
}

type Validation = { ok: true; value: ParsedInput } | { ok: false; error: string }

function isIdRef(v: unknown): v is string | number {
  if (typeof v === "number") return Number.isInteger(v) && v >= 1
  if (typeof v !== "string") return false
  const trimmed = v.trim()
  return trimmed.length > 0
}

type TreeParse =
  | { ok: true; items: AddManyItem[]; coerced: string[] }
  | { ok: false; error: string }

/** Parse `tasks` / `items` tree arrays (including stringified JSON). */
function parseAddManyTree(rawValue: unknown, field: "tasks" | "items"): TreeParse {
  const c = coerceJsonArray(rawValue, field)
  if (!c.ok) return { ok: false, error: c.error }
  if (c.value.length === 0) {
    return {
      ok: false,
      error: `\`${field}\` must be a non-empty array of objects`,
    }
  }
  const coerced: string[] = []
  if (c.coerced) coerced.push(field)
  const items: AddManyItem[] = []
  for (let i = 0; i < c.value.length; i++) {
    const entry = c.value[i]
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return {
        ok: false,
        error: `every entry in \`${field}\` must be an object (index ${i})`,
      }
    }
    const rec = entry as Record<string, unknown>
    if (typeof rec.title !== "string" || rec.title.trim().length === 0) {
      return {
        ok: false,
        error: `every entry in \`${field}\` must have a non-empty string \`title\` (index ${i})`,
      }
    }
    const item: AddManyItem = { title: rec.title }
    if (rec.children !== undefined) {
      const kids = coerceJsonArray(rec.children, `${field}[${i}].children`)
      if (!kids.ok) return { ok: false, error: kids.error }
      if (kids.coerced) coerced.push(`${field}[${i}].children`)
      // Silently ignore empty children arrays (treat as absent).
      if (kids.value.length > 0) {
        if (!kids.value.every((s) => typeof s === "string" && s.trim().length > 0)) {
          return {
            ok: false,
            error: `every entry in \`${field}[${i}].children\` must be a non-empty string`,
          }
        }
        // Preflight max children (a–z) so we never create a parent then fail mid-write.
        if (kids.value.length > MAX_SUBTASKS_PER_PARENT) {
          return {
            ok: false,
            error:
              `\`${field}[${i}].children\` has ${kids.value.length} entries; ` +
              `max ${MAX_SUBTASKS_PER_PARENT} subtasks per parent`,
          }
        }
        // Depth-2 only: children are titles, not nested objects.
        item.children = kids.value as string[]
      }
    }
    // Mirror manifest additionalProperties:false — only title + children.
    for (const key of Object.keys(rec)) {
      if (key !== "title" && key !== "children") {
        return {
          ok: false,
          error:
            `\`${field}[${i}]\` only accepts \`title\` and optional \`children\` (string[]); ` +
            `unknown key "${key}"`,
        }
      }
    }
    items.push(item)
  }
  return { ok: true, items, coerced }
}

function validateInput(raw: Record<string, unknown>): Validation {
  if (typeof raw.action !== "string" || !VALID_ACTIONS.has(raw.action as Action)) {
    return {
      ok: false,
      error: `\`action\` must be one of: ${[...VALID_ACTIONS].join(", ")}`,
    }
  }
  const action = raw.action as Action

  const out: ParsedInput = { action }

  // id (string or integer position)
  if (raw.id !== undefined && raw.id !== null) {
    if (!isIdRef(raw.id)) {
      return {
        ok: false,
        error: "`id` must be a non-empty string or positive integer",
      }
    }
    out.id = raw.id as string | number
  }

  // title
  if (raw.title !== undefined && raw.title !== null) {
    if (typeof raw.title !== "string" || raw.title.trim().length === 0) {
      return { ok: false, error: "`title` must be a non-empty string" }
    }
    out.title = raw.title
  }

  const coerced: string[] = []

  // titles (coerce stringified JSON arrays from tool-calling models)
  if (raw.titles !== undefined && raw.titles !== null) {
    const c = coerceJsonArray(raw.titles, "titles")
    if (!c.ok) return { ok: false, error: c.error }
    if (c.value.length === 0) {
      return {
        ok: false,
        error: "`titles` must be a non-empty array of strings",
      }
    }
    if (!c.value.every((s) => typeof s === "string" && s.trim().length > 0)) {
      return {
        ok: false,
        error: "every entry in `titles` must be a non-empty string",
      }
    }
    if (c.coerced) coerced.push("titles")
    out.titles = c.value as string[]
  }

  // tasks (primary tree) + items (alias). Same shape: top-level + optional string children.
  if (raw.tasks !== undefined && raw.tasks !== null) {
    const parsed = parseAddManyTree(raw.tasks, "tasks")
    if (!parsed.ok) return { ok: false, error: parsed.error }
    coerced.push(...parsed.coerced)
    out.tasks = parsed.items
  }
  if (raw.items !== undefined && raw.items !== null) {
    const parsed = parseAddManyTree(raw.items, "items")
    if (!parsed.ok) return { ok: false, error: parsed.error }
    coerced.push(...parsed.coerced)
    out.items = parsed.items
  }

  // parent
  if (raw.parent !== undefined && raw.parent !== null) {
    if (!isIdRef(raw.parent)) {
      return {
        ok: false,
        error: "`parent` must be a non-empty string or positive integer",
      }
    }
    out.parent = raw.parent as string | number
  }

  // after
  if (raw.after !== undefined && raw.after !== null) {
    if (!isIdRef(raw.after)) {
      return {
        ok: false,
        error: "`after` must be a non-empty string or positive integer",
      }
    }
    out.after = raw.after as string | number
  }

  // status
  if (raw.status !== undefined) {
    if (!isTaskStatus(raw.status)) {
      return {
        ok: false,
        error: `\`status\` must be one of: todo, doing, done, canceled`,
      }
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

  // order (coerce stringified JSON arrays)
  if (raw.order !== undefined && raw.order !== null) {
    const c = coerceJsonArray(raw.order, "order")
    if (!c.ok) return { ok: false, error: c.error }
    if (c.value.length === 0) {
      return { ok: false, error: "`order` must be a non-empty array of ids" }
    }
    if (!c.value.every((r) => isIdRef(r))) {
      return {
        ok: false,
        error: "every entry in `order` must be a non-empty string or positive integer",
      }
    }
    if (c.coerced) coerced.push("order")
    out.order = c.value as (string | number)[]
  }

  // filter
  if (raw.filter !== undefined) {
    if (typeof raw.filter !== "string" || !VALID_FILTERS.has(raw.filter)) {
      return {
        ok: false,
        error: `\`filter\` must be one of: ${[...VALID_FILTERS].join(", ")}`,
      }
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
      return {
        ok: false,
        error: `\`${f}\` is required for action="${action}"`,
      }
    }
  }

  // update: at least one of title or status must be provided.
  if (action === "update" && out.title === undefined && out.status === undefined) {
    return {
      ok: false,
      error:
        "`update` requires at least one of `title` or `status` " +
        '(did you mean `action="status"`?)',
    }
  }

  // tasks / items are only meaningful for bulk creation actions.
  const isBulkAction = action === "add_many" || action === "replace_plan"
  if (out.tasks !== undefined && !isBulkAction) {
    return {
      ok: false,
      error: `\`tasks\` is only valid for action="add_many" (got "${action}")`,
    }
  }
  if (out.items !== undefined && !isBulkAction) {
    return {
      ok: false,
      error: `\`items\` is only valid for action="add_many" (got "${action}")`,
    }
  }

  // Bulk actions require exactly one of tasks | items | titles.
  // add_many permits parent only with flat titles. replace_plan is top-level only.
  if (isBulkAction) {
    const hasTitles = out.titles !== undefined
    const hasItems = out.items !== undefined
    const hasTasks = out.tasks !== undefined
    const nShapes = Number(hasTitles) + Number(hasItems) + Number(hasTasks)
    if (nShapes === 0) {
      return {
        ok: false,
        error:
          `\`${action}\` requires \`tasks\` (preferred: \`{title, children?}[]\`), ` +
          "or alias `items` (same shape), or flat `titles` (string[]). " +
          "Pass a real JSON array (not a stringified array). Retry once with the corrected shape; " +
          "do not drip-`add` the same titles afterward (that duplicates the board).",
      }
    }
    if (nShapes > 1) {
      return {
        ok: false,
        error:
          `\`tasks\`, \`items\`, and \`titles\` are mutually exclusive for action="${action}"; ` +
          "send exactly one. Prefer `tasks`. Retry once; do not re-add titles that may already exist.",
      }
    }
    // Normalize aliases onto `tasks` for the handler.
    if (hasItems && !hasTasks) {
      out.tasks = out.items
      out.items = undefined
    }
    if (out.parent !== undefined && action === "replace_plan") {
      return {
        ok: false,
        error: '`parent` is not valid for action="replace_plan"',
      }
    }
    if ((hasTasks || hasItems) && out.parent !== undefined) {
      return {
        ok: false,
        error:
          "`parent` cannot be combined with `tasks`/`items`: tree form always creates top-level roots. " +
          "To add a flat batch below a top-level parent, use `titles`; subtasks cannot have children.",
      }
    }
    if (out.after !== undefined) {
      return {
        ok: false,
        error: `\`after\` is only valid for action="add" (not ${action})`,
      }
    }
  }

  if (coerced.length > 0) out.coerced = coerced
  return { ok: true, value: out }
}

const REQUIRED_FIELDS: Record<Action, readonly (keyof ParsedInput)[]> = {
  add: ["title"],
  // add_many: custom titles XOR items check above (not a single required field).
  add_many: [],
  replace_plan: [],
  update: ["id"],
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

function modelMeta(action: RenderAction, inputAction?: string, targetId?: string): TaskModelMeta {
  const meta: TaskModelMeta = {}
  if (inputAction) meta.action = inputAction
  if (targetId) meta.id = targetId
  switch (action.kind) {
    case "added":
    case "started":
    case "updated":
    case "removed":
      meta.result = action.kind
      meta.id = action.id
      break
    case "marked_done":
    case "marked_doing":
    case "marked_todo":
    case "marked_canceled":
      meta.result = action.kind
      meta.id = action.id
      break
    case "added_many":
    case "replaced_plan":
    case "reordered":
    case "cleared":
    case "all_done":
    case "list":
      meta.result = action.kind
      break
    case "already_done":
      meta.result = action.kind
      meta.id = action.id
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
  targetId?: string,
  coerced?: readonly string[],
  replaced?: number,
): {
  content: string
  display: string
  displayHeader: string
  displayFooter: string
} {
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
      content: JSON.stringify(
        {
          stats,
          tasks,
          ...(replaced !== undefined ? { replaced } : {}),
          ...(coerced?.length ? { coerced } : {}),
        },
        null,
        2,
      ),
      display: displayParts.body,
      displayHeader: displayParts.header,
      displayFooter: displayParts.footer,
    }
  }
  const meta: TaskToolMeta = {
    ...modelMeta(action, inputAction, targetId),
    ...(coerced?.length ? { coerced } : {}),
    ...(replaced !== undefined ? { replaced } : {}),
  }
  const content = renderTasksToolContent(tasks, stats, meta)
  return {
    content,
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
  targetId?: string,
  coerced?: readonly string[],
  replaced?: number,
): TUIResult {
  const rendered = renderResult(
    store,
    action,
    format ?? "text",
    viewsOverride,
    inputAction,
    targetId,
    coerced,
    replaced,
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

/** Report a missing reference without exposing legacy internal identifiers. */
function idNotFound(ref: string | number): TUIResult {
  return err(`id "${ref}" not found; use a current id from the task board`)
}

/**
 * Model-facing result for status mutations.
 *
 * The default is a plain-text OK line only (MA-39298). With
 * `MINIMAL_AGENT_TASKS_FULL_RESULTS=1`, the same acknowledgement is followed by
 * the complete updated board. Human TUI display stays full in both modes.
 * Re-done of an already-done id is a hard error (not a soft ack).
 */
function okCompact(
  store: TaskStore,
  action: RenderAction,
  format: "text" | "json" | undefined,
  inputAction?: string,
  opts?: {
    quietDisplay?: boolean
    parentAutoDone?: string
    coerced?: readonly string[]
    reason?: string
    fullResults?: boolean
    targetId?: string
  },
): TUIResult {
  const stats = store.stats()
  const displayParts = renderToolDisplay(store.views(), stats, {
    ansi: true,
    action,
  })
  const metaBase = modelMeta(
    action,
    inputAction,
    opts?.targetId ?? ("id" in action ? action.id : undefined),
  )
  const quiet = opts?.quietDisplay === true

  const meta: TaskToolMeta = {
    ...metaBase,
    ...(opts?.parentAutoDone ? { parentAutoDone: opts.parentAutoDone } : {}),
    ...(opts?.coerced?.length ? { coerced: opts.coerced } : {}),
    ...(opts?.reason ? { reason: opts.reason } : {}),
  }
  const content = renderStatusResult(store, stats, meta, format, opts?.fullResults === true, {
    parentAutoDone: opts?.parentAutoDone,
    coerced: opts?.coerced,
    reason: opts?.reason,
  })

  return {
    kind: "tool_result",
    content,
    display: quiet ? "" : displayParts.body,
    displayHeader: displayParts.header,
    displayFooter: quiet ? "" : displayParts.footer,
    suppressToolTime: true,
  }
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
  input.fullResults = tasksFullResults(ctx.env)

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
      case "replace_plan":
        return doReplacePlan(store, input)
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
  return ok(
    store,
    { kind: "added", id: task.id },
    input.format,
    undefined,
    input.action,
    undefined,
    input.coerced,
  )
}

function doAddMany(store: TaskStore, input: ParsedInput): TUIResult {
  if (input.tasks !== undefined) {
    const created: ReturnType<TaskStore["add"]>[] = []
    for (const item of input.tasks) {
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
      undefined,
      input.coerced,
    )
  }

  let parentId: string | null = null
  if (input.parent !== undefined) {
    const parent = store.resolve(input.parent)
    if (parent === null) return err(`parent "${input.parent}" not found`)
    if (parent.parent !== null) {
      return err(`parent "${input.parent}" is a subtask; depth-2 nesting is not allowed`)
    }
    parentId = parent.id
    const existingKids = store.list().filter((t) => t.parent === parentId).length
    const incoming = input.titles!.length
    if (existingKids + incoming > MAX_SUBTASKS_PER_PARENT) {
      return err(
        `parent "${parentId}" would have ${existingKids + incoming} subtasks ` +
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
    undefined,
    input.coerced,
  )
}

function doReplacePlan(store: TaskStore, input: ParsedInput): TUIResult {
  const replaced = store.stats().total
  const plan =
    input.tasks?.map((item) => ({
      title: item.title,
      children: item.children?.map((title) => ({ title })),
    })) ?? input.titles!.map((title) => ({ title }))
  const tasks = store.replaceAll(plan)
  return ok(
    store,
    { kind: "replaced_plan", count: tasks.length, replaced },
    input.format,
    undefined,
    input.action,
    undefined,
    input.coerced,
    replaced,
  )
}

function doUpdate(store: TaskStore, input: ParsedInput): TUIResult {
  // Status-only: delegate to doStatus so we get the right render action
  // (marked_done / marked_doing / marked_canceled / all_done) and the
  // already-done hard-error path, with `input.action` = "update" in meta.
  if (input.title === undefined) {
    return doStatus(store, input)
  }

  // Title update, possibly with a concurrent status change.
  const before = store.resolve(input.id!)
  if (before === null) return idNotFound(input.id!)
  const oldTitle = before.title
  const updated = store.update(input.id!, input.title!)
  if (updated === null) return idNotFound(input.id!)

  // Status change alongside title.
  if (input.status !== undefined) {
    const target = store.resolve(input.id!)!
    // Skip idempotent done (title change is the real mutation here).
    if (!(input.status === "done" && target.status === "done")) {
      store.setStatus(target.id, input.status!, input.reason)
    }
  }

  const after = store.resolve(input.id!)!
  const titleChanged = oldTitle !== after.title
  const views = store.views()
  // Skip the diff overlay when nothing actually changed (whitespace-only
  // edit, or update to the same string) — showing `x  →  x` is noise.
  const augmented: readonly View[] = titleChanged
    ? views.map((v) => (v.task.id === after.id ? { ...v, diff: { oldTitle } } : v))
    : views

  // ALL DONE when a status→done alongside the title change completes the plan.
  if (input.status === "done") {
    const s = store.stats()
    if (s.total > 0 && s.done === s.total) {
      return ok(
        store,
        { kind: "all_done" },
        input.format,
        augmented,
        input.action,
        after.id,
        input.coerced,
      )
    }
  }

  return ok(
    store,
    { kind: "updated", id: after.id },
    input.format,
    augmented,
    input.action,
    undefined,
    input.coerced,
  )
}

function doStatus(store: TaskStore, input: ParsedInput): TUIResult {
  const target = store.resolve(input.id!)
  if (target === null) return idNotFound(input.id!)
  // Re-done is a hard error (Option D2). Soft already_done taught models
  // that an extra parent done after auto-promote was free.
  if (input.status === "done" && target.status === "done") {
    return errAlreadyDone(store, target.id)
  }
  const updated = store.setStatus(target.id, input.status!, input.reason)
  if (updated === null) return idNotFound(input.id!)
  // "ALL DONE" when every row is done. Parent↔child rollup means finishing
  // the last open child can complete the whole plan too, so check stats
  // regardless of whether the target was top-level or a subtask.
  if (input.status === "done") {
    const s = store.stats()
    if (s.total > 0 && s.done === s.total) {
      return okCompact(store, { kind: "all_done" }, input.format, input.action, {
        fullResults: input.fullResults,
        targetId: updated.id,
      })
    }
  }
  const action: RenderAction =
    input.status === "done"
      ? { kind: "marked_done", id: updated.id }
      : input.status === "doing"
        ? { kind: "marked_doing", id: updated.id }
        : input.status === "canceled"
          ? { kind: "marked_canceled", id: updated.id }
          : { kind: "marked_todo", id: updated.id }

  const parentAutoDone =
    (input.status === "done" || input.status === "canceled") && target.parent !== null
      ? parentJustAutoDone(store, target.parent, updated.id)
      : undefined

  return okCompact(store, action, input.format, input.action, {
    parentAutoDone,
    reason: input.status === "canceled" ? input.reason : undefined,
    fullResults: input.fullResults,
  })
}

function doStart(store: TaskStore, input: ParsedInput): TUIResult {
  const target = store.resolve(input.id!)
  if (target === null) return idNotFound(input.id!)
  const updated = store.start(target.id, { parallel: input.parallel })
  if (updated === null) return idNotFound(input.id!)
  return okCompact(store, { kind: "started", id: updated.id }, input.format, input.action, {
    fullResults: input.fullResults,
  })
}

function doDone(store: TaskStore, input: ParsedInput): TUIResult {
  const target = store.resolve(input.id!)
  if (target === null) return idNotFound(input.id!)
  // Re-done is a hard error (Option D2) — no soft already_done ack.
  if (target.status === "done") {
    return errAlreadyDone(store, target.id)
  }
  const updated = store.done(target.id)
  if (updated === null) return idNotFound(input.id!)
  // Same as doStatus: rollup can complete the plan via a last-child done.
  const s = store.stats()
  if (s.total > 0 && s.done === s.total) {
    return okCompact(store, { kind: "all_done" }, input.format, input.action, {
      fullResults: input.fullResults,
      targetId: updated.id,
    })
  }
  const parentAutoDone =
    target.parent !== null ? parentJustAutoDone(store, target.parent, updated.id) : undefined
  return okCompact(store, { kind: "marked_done", id: updated.id }, input.format, input.action, {
    parentAutoDone,
    fullResults: input.fullResults,
  })
}

/** If parent is now done and wasn't the mutated id, last-child auto-promote fired. */
function parentJustAutoDone(
  store: TaskStore,
  parentId: string,
  mutatedId: string,
): string | undefined {
  if (parentId === mutatedId) return undefined
  const parent = store.resolve(parentId)
  if (parent !== null && parent.status === "done") return parentId
  return undefined
}

/**
 * Hard-error for re-done of an already-done task (Option D2).
 *
 * Soft `already_done` taught models the extra parent `done` after auto-promote
 * was free (~710 hits). Auto-promote stays; the redundant call is now an error.
 */
function errAlreadyDone(store: TaskStore, id: string): TUIResult {
  const hasKids = store.list().some((t) => t.parent === id)
  if (hasKids) {
    return err(
      `${id} is already done (likely auto-promoted when its last child finished). ` +
        "Do not call done on the parent after finishing the last child — one done on the child is enough",
    )
  }
  return err(`${id} is already done. Do not call done again`)
}

function doRemove(store: TaskStore, input: ParsedInput): TUIResult {
  // Snapshot pre-mutation tasks so we can re-inject the just-removed
  // task(s) as ghost rows in the rendered output. The user sees the
  // tombstone (red ✘ + red strikethrough title) instead of a silent
  // disappearance.
  const beforeTasks = store.list()
  const target = store.resolve(input.id!)
  if (target === null) return idNotFound(input.id!)
  const removed = store.remove(target.id)
  const removedIds = new Set(removed.map((t) => t.id))
  const augmented = viewsWithGhostRemoved(beforeTasks, removedIds)
  return ok(store, { kind: "removed", id: target.id }, input.format, augmented, input.action)
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
