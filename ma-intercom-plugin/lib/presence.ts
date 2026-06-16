/**
 * Presence records: the per-session "I exist, here's my pid + a heartbeat"
 * file. Pure record/parse/merge plus a thin atomic-write / read-dir IO shell.
 *
 * Each session owns exactly one file, `intercom/presence/<sid>.json`, which it
 * REWRITES every heartbeat (small, single object — cheaper and simpler than an
 * append log, and a rewrite is naturally last-write-wins). Readers scan the
 * directory and classify each record via `lib/liveness.ts`.
 *
 * The record only PROMISES `sid` + `pid` + `ts`. Everything else is best-effort
 * enrichment; liveness never depends on it.
 *
 * @module lib/presence
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { hostname } from "node:os"
import { dirname, join } from "node:path"

import { isSafeSid, shortId } from "./identity.ts"

/** Coarse self-reported phase. Best-effort; defaults to `active`. */
export type SelfPhase = "active" | "idle" | "busy"

/**
 * Derive a busy/idle phase from how recently the session transcript was
 * written. A turn actively streams tool calls + assistant text into the JSONL,
 * so a very recent mtime means "busy"; otherwise "idle". Pure.
 *
 * `busyWindowMs` should be a small multiple of the heartbeat cadence so a
 * mid-turn lull between tool calls doesn't flip to idle. Returns `idle` when
 * the mtime is unknown (null) — a session we can't time is treated as not busy
 * rather than falsely active.
 */
export function phaseFromMtime(
  mtimeMs: number | null,
  nowMs: number,
  busyWindowMs: number,
): SelfPhase {
  if (mtimeMs === null || !Number.isFinite(mtimeMs)) return "idle"
  return nowMs - mtimeMs <= busyWindowMs ? "busy" : "idle"
}

/** Current presence schema version. */
export const PRESENCE_V = 1

/** One session's presence record. */
export interface PresenceRecord {
  readonly v: number
  /** Full session uuid (the address key). */
  readonly sid: string
  /** Short display handle (`sid[0..6]`). */
  readonly short: string
  /** Agent process id — half of the liveness signal. */
  readonly pid: number
  /** Host name; readers compare to decide whether a pid probe is meaningful. */
  readonly host: string
  /** ISO timestamp of this beat — the other half of the liveness signal. */
  readonly ts: string
  /** ISO timestamp the session first published (stable across beats). */
  readonly startedAt: string
  /** Agent semver. */
  readonly agentVersion: string
  /** Resolved model id. */
  readonly model: string
  /** Working directory. */
  readonly cwd: string
  /** Project root (often == cwd; used for `project` broadcast scoping). */
  readonly projectRoot: string
  /** Coarse self-state. Best-effort. */
  readonly phase: SelfPhase
  /** ≤100-char human summary of what it's doing now, or null. Best-effort. */
  readonly activity: string | null
  /** Set true on a clean shutdown beat so readers can say "offline (exited)". */
  readonly gone?: true
}

/** Validate + coerce an unknown parsed object into a {@link PresenceRecord}, or null. */
export function coercePresence(o: unknown): PresenceRecord | null {
  if (o === null || typeof o !== "object") return null
  const r = o as Record<string, unknown>
  // `sid` becomes a filename component, so reject anything that could escape a
  // directory before it ever reaches a path builder (path-traversal guard).
  if (!isSafeSid(r.sid)) return null
  if (typeof r.ts !== "string" || r.ts.length === 0) return null
  const pid = typeof r.pid === "number" && Number.isFinite(r.pid) ? r.pid : 0
  const phase: SelfPhase =
    r.phase === "idle" || r.phase === "busy" || r.phase === "active" ? r.phase : "active"
  return {
    v: typeof r.v === "number" ? r.v : PRESENCE_V,
    sid: r.sid,
    short: typeof r.short === "string" && r.short.length > 0 ? r.short : shortId(r.sid),
    pid,
    host: typeof r.host === "string" ? r.host : "",
    ts: r.ts,
    startedAt: typeof r.startedAt === "string" ? r.startedAt : r.ts,
    agentVersion: typeof r.agentVersion === "string" ? r.agentVersion : "",
    model: typeof r.model === "string" ? r.model : "",
    cwd: typeof r.cwd === "string" ? r.cwd : "",
    projectRoot: typeof r.projectRoot === "string" ? r.projectRoot : "",
    phase,
    activity:
      typeof r.activity === "string" && r.activity.length > 0 ? r.activity.slice(0, 100) : null,
    ...(r.gone === true ? { gone: true as const } : {}),
  }
}

/**
 * Adapt a row from the sub-agents plugin's presence feed
 * (`~/.minimal-agent/presence/<leadSid>.jsonl`, schema
 * `{sid, role, status, pid, ts, model, cwd, label}`) into our
 * {@link PresenceRecord} shape, so those sessions appear in the roster even
 * when they don't run intercom. Best-effort; returns null on missing keys.
 *
 * The sub-agents status vocabulary is active / queued / done / incomplete /
 * failed / stopped. We map "active" to the busy phase and treat terminal
 * statuses by setting `gone` so the roster shows them as offline rather than
 * implying liveness.
 */
export function adaptSubagentRow(o: unknown, localHost: string): PresenceRecord | null {
  if (o === null || typeof o !== "object") return null
  const r = o as Record<string, unknown>
  // Same path-traversal guard as coercePresence: the foreign sub-agents feed is
  // not ours, so treat its `sid` as untrusted before it can become a path.
  if (!isSafeSid(r.sid)) return null
  if (typeof r.ts !== "string" || r.ts.length === 0) return null
  const status = typeof r.status === "string" ? r.status : "active"
  const terminal =
    status === "done" || status === "failed" || status === "stopped" || status === "incomplete"
  const phase: SelfPhase = status === "active" ? "busy" : "idle"
  return {
    v: PRESENCE_V,
    sid: r.sid,
    short: shortId(r.sid),
    pid: typeof r.pid === "number" && Number.isFinite(r.pid) ? r.pid : 0,
    // The sub-agents feed carries no host field, but it is only ever written by
    // processes on THIS machine, so we stamp the reader's host. That makes
    // `sameHost` true in classifyLiveness, so the kill(pid,0) probe actually
    // runs — without it a crashed worker with a stale-ish `ts` would never be
    // classified dead (the "stuck active worker" graveyard bug).
    host: typeof r.host === "string" && r.host.length > 0 ? r.host : localHost,
    ts: r.ts,
    startedAt: r.ts,
    agentVersion: "",
    model: typeof r.model === "string" ? r.model : "",
    cwd: typeof r.cwd === "string" ? r.cwd : "",
    projectRoot: typeof r.cwd === "string" ? r.cwd : "",
    phase,
    activity:
      typeof r.label === "string" && r.label.length > 0 ? `worker: ${r.label}`.slice(0, 100) : null,
    ...(terminal ? { gone: true as const } : {}),
  }
}

/**
 * Read + parse the sub-agents presence directory into adapted records.
 *
 * `localHost` is stamped onto every adapted row (the feed carries no host but
 * is always local) so the liveness pid probe applies. Defaults to the machine
 * hostname; injectable for tests.
 */
export function readSubagentPresenceDir(
  dir: string,
  localHost: string = hostname(),
): PresenceRecord[] {
  if (!existsSync(dir)) return []
  const by = new Map<string, PresenceRecord>()
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue
    let text: string
    try {
      text = readFileSync(join(dir, name), "utf-8")
    } catch {
      continue
    }
    for (const line of text.split("\n")) {
      const t = line.trim()
      if (!t) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(t)
      } catch {
        continue
      }
      const rec = adaptSubagentRow(parsed, localHost)
      if (!rec) continue
      const prev = by.get(rec.sid)
      if (!prev || rec.ts > prev.ts) by.set(rec.sid, rec)
    }
  }
  return [...by.values()]
}

/** Parse one presence file's text into a record, tolerating junk. */
export function parsePresence(text: string): PresenceRecord | null {
  const t = text.trim()
  if (!t) return null
  try {
    return coercePresence(JSON.parse(t))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// IO shell
// ---------------------------------------------------------------------------

/**
 * Atomically (re)write a session's presence record. Write to a temp sibling
 * then `rename` so a reader never observes a half-written file. Best-effort:
 * callers wrap in try/catch — a presence write must never break the agent.
 */
export function writePresence(path: string, rec: PresenceRecord): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(rec)}\n`)
  renameSync(tmp, path)
}

/** Read + parse one session's presence record by file path. Null when absent/corrupt. */
export function readPresenceFile(path: string): PresenceRecord | null {
  if (!existsSync(path)) return null
  try {
    return parsePresence(readFileSync(path, "utf-8"))
  } catch {
    return null
  }
}

/**
 * Read every presence record in a directory, newest-write-per-sid winning if
 * (somehow) duplicated. Empty array when the directory is absent. Skips temp
 * files and anything unparseable.
 */
export function readPresenceDir(dir: string): PresenceRecord[] {
  if (!existsSync(dir)) return []
  const by = new Map<string, PresenceRecord>()
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  for (const name of names) {
    if (!name.endsWith(".json") || name.includes(".tmp-")) continue
    const rec = readPresenceFile(join(dir, name))
    if (!rec) continue
    const prev = by.get(rec.sid)
    if (!prev || rec.ts > prev.ts) by.set(rec.sid, rec)
  }
  return [...by.values()]
}
