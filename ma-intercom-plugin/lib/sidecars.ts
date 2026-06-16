/**
 * Tolerant readers for OTHER plugins' per-session sidecar files.
 *
 * This is intercom's inter-plugin integration surface, and it is deliberately
 * decoupled: we never import the tasks / background / sub-agents plugins. We
 * read the files they colocate in `~/.minimal-agent/sessions/` with small,
 * defensive parsers that tolerate missing files, schema drift, and corruption
 * (always degrade to "empty", never throw). This mirrors how minimal-agent's
 * own core re-reads the tasks sidecar for replay (`parseReplaySidecarTasks`)
 * instead of importing the plugin.
 *
 * The shared `<sessions>/<sid>.<thing>` filesystem layout IS the contract.
 * Each reader validates only the few fields intercom surfaces.
 *
 * @module lib/sidecars
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

// ---------------------------------------------------------------------------
// Tasks  (<sid>.tasks.jsonl, owned by the `tasks` plugin)
// ---------------------------------------------------------------------------

/** A task status, mirrored from the tasks plugin's vocabulary. */
export type PeerTaskStatus = "todo" | "doing" | "done" | "canceled"

/** One task row, narrowed to what a peer view needs. */
export interface PeerTask {
  readonly id: string
  readonly parent: string | null
  readonly status: PeerTaskStatus
  readonly title: string
}

const TASK_STATUSES = new Set<PeerTaskStatus>(["todo", "doing", "done", "canceled"])

/** Read + parse a session's task list (empty when absent/corrupt). */
export function readPeerTasks(sessionsDir: string, sid: string): PeerTask[] {
  const path = join(sessionsDir, `${sid}.tasks.jsonl`)
  if (!existsSync(path)) return []
  let text: string
  try {
    text = readFileSync(path, "utf-8")
  } catch {
    return []
  }
  const out: PeerTask[] = []
  for (const line of text.split("\n")) {
    const t = line.trim()
    if (!t) continue
    let o: Record<string, unknown>
    try {
      o = JSON.parse(t) as Record<string, unknown>
    } catch {
      continue
    }
    if (typeof o.id !== "string") continue
    if (typeof o.title !== "string") continue
    if (typeof o.status !== "string" || !TASK_STATUSES.has(o.status as PeerTaskStatus)) continue
    out.push({
      id: o.id,
      parent: typeof o.parent === "string" ? o.parent : null,
      status: o.status as PeerTaskStatus,
      title: o.title,
    })
  }
  return out
}

/** Summary counts for a peer's task list. */
export interface TaskSummary {
  readonly total: number
  readonly todo: number
  readonly doing: number
  readonly done: number
  readonly canceled: number
}

/** Tally a task list by status. Pure. */
export function summarizeTasks(tasks: readonly PeerTask[]): TaskSummary {
  const s = { total: tasks.length, todo: 0, doing: 0, done: 0, canceled: 0 }
  for (const t of tasks) s[t.status] += 1
  return s
}

// ---------------------------------------------------------------------------
// Background jobs  (<sid>.bgjobs.jsonl, owned by the `ma-bg` plugin)
// ---------------------------------------------------------------------------

/** One background job row, narrowed. */
export interface PeerJob {
  readonly id: string
  readonly description: string
  readonly command: string
  /** e.g. "running" | "exited" | "stopped" | "timedout" — kept as a free string. */
  readonly state: string
  readonly exitCode: number | null
}

/** Read + parse a session's background jobs (empty when absent/corrupt). */
export function readPeerJobs(sessionsDir: string, sid: string): PeerJob[] {
  const path = join(sessionsDir, `${sid}.bgjobs.jsonl`)
  if (!existsSync(path)) return []
  let text: string
  try {
    text = readFileSync(path, "utf-8")
  } catch {
    return []
  }
  const out: PeerJob[] = []
  for (const line of text.split("\n")) {
    const t = line.trim()
    if (!t) continue
    let o: Record<string, unknown>
    try {
      o = JSON.parse(t) as Record<string, unknown>
    } catch {
      continue
    }
    if (typeof o.id !== "string") continue
    const status = (o.status ?? null) as Record<string, unknown> | null
    const state = status && typeof status.kind === "string" ? status.kind : "unknown"
    const exitCode =
      status && typeof status.exitCode === "number" && Number.isFinite(status.exitCode)
        ? status.exitCode
        : null
    out.push({
      id: o.id,
      description: typeof o.description === "string" ? o.description : "",
      command: typeof o.command === "string" ? o.command : "",
      state,
      exitCode,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Sub-agent fleet  (<sid>.subagents.jsonl, owned by the `sub-agents` plugin)
// ---------------------------------------------------------------------------

/** One sub-agent fleet member, narrowed. */
export interface PeerFleetMember {
  readonly id: string
  readonly label: string
  /** e.g. "running" | "done" | "failed" | "queued" — free string. */
  readonly state: string
  readonly model: string
}

/** Read + parse a session's sub-agent fleet (empty when absent/corrupt). */
export function readPeerFleet(sessionsDir: string, sid: string): PeerFleetMember[] {
  const path = join(sessionsDir, `${sid}.subagents.jsonl`)
  if (!existsSync(path)) return []
  let text: string
  try {
    text = readFileSync(path, "utf-8")
  } catch {
    return []
  }
  // The store may be append-only with one record per mutation; keep the LAST
  // record per worker id so we reflect current state.
  const by = new Map<string, PeerFleetMember>()
  for (const line of text.split("\n")) {
    const t = line.trim()
    if (!t) continue
    let o: Record<string, unknown>
    try {
      o = JSON.parse(t) as Record<string, unknown>
    } catch {
      continue
    }
    const id = typeof o.id === "string" ? o.id : typeof o.handle === "string" ? o.handle : null
    if (!id) continue
    const status = o.status as Record<string, unknown> | string | null | undefined
    const state =
      typeof status === "string"
        ? status
        : status && typeof status === "object" && typeof status.kind === "string"
          ? status.kind
          : "unknown"
    by.set(id, {
      id,
      label: typeof o.label === "string" ? o.label : id,
      state,
      model: typeof o.model === "string" ? o.model : "",
    })
  }
  return [...by.values()]
}
