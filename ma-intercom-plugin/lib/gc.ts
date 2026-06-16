/**
 * Garbage collection for the intercom store.
 *
 * Presence is an eventually-consistent graveyard: sessions die without cleanly
 * removing their files (crash, SIGKILL, power loss), and sub-agent workers leave
 * stale `active` rows behind. Without a sweep the presence dir grows without
 * bound and the roster fills with corpses (the "606 peers" bug). GC keeps the
 * store honest.
 *
 * Two targets, both OWNED BY INTERCOM (never the foreign sub-agents feed, which
 * we only read):
 *
 *   1. Dead presence — `intercom/presence/<sid>.json` that classifies as `dead`
 *      or `offline` AND whose last beat is older than {@link PRESENCE_GC_TTL_MS}.
 *      We keep a freshly-dead record briefly so "X died 2m ago" is still a
 *      useful roster signal, then prune it.
 *   2. Orphan aux files — `intercom/inbox/<sid>.jsonl`, `cursors/<sid>.json`,
 *      `self/<sid>.json` for a sid with NO live presence record, whose file is
 *      older than {@link ORPHAN_GC_TTL_MS} (generous, so a session that will
 *      `--resume` under the same sid doesn't lose its mail).
 *
 * Pure planning (`planPresenceGc` / `planOrphanGc`) + a thin unlink shell
 * (`runGc`). Safe under concurrency: many sessions may GC at once; unlinks are
 * idempotent and a missing file (ENOENT) is ignored. We only ever target files
 * already classified dead/offline-and-old, so a concurrently-beating peer is
 * fresh by definition and never in the delete set; the worst case is deleting
 * one beat of a peer returning from a long (past-TTL) stall, which self-heals on
 * its next 5s beat.
 *
 * @module lib/gc
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"

import type { Thresholds } from "./config.ts"
import { classifyLiveness, type LivenessProbe } from "./liveness.ts"
import { cursorsDir, inboxDir, presenceDir, subagentsPresenceDir } from "./paths.ts"
import { type PresenceRecord, readPresenceFile } from "./presence.ts"
import { selfDir } from "./selfstate.ts"

/** Dead/offline presence older than this is pruned. Default 10 minutes. */
export const PRESENCE_GC_TTL_MS = 10 * 60_000

/** Orphan aux files (no live presence) older than this are pruned. Default 24h. */
export const ORPHAN_GC_TTL_MS = 24 * 60 * 60_000

/**
 * A foreign sub-agents presence file (`~/.minimal-agent/presence/<leadSid>.jsonl`)
 * not rewritten in this long is a DEAD LEAD's leftover and is pruned. A live
 * lead's supervisor rewrites its file every heartbeat (~5s), so a file with an
 * mtime older than this can only belong to a lead that's gone. Generous default
 * (10 min) to never touch a briefly-stalled live lead. This is the cleanup the
 * sub-agents plugin itself lacks; intercom does it because it reads that feed.
 */
export const FOREIGN_GC_TTL_MS = 10 * 60_000

/** A presence file paired with its parsed record (or null when unreadable). */
export interface PresenceFile {
  readonly sid: string
  readonly path: string
  readonly record: PresenceRecord | null
}

/** An auxiliary (inbox/cursor/self) file keyed by the sid it belongs to. */
export interface AuxFile {
  readonly sid: string
  readonly path: string
  readonly mtimeMs: number
}

/**
 * Decide which of MY presence files to delete: those whose derived liveness is
 * `dead` or `offline` and whose age exceeds `ttlMs`. Pure.
 *
 * A record that fails to parse (null) is always prunable — it's corrupt junk.
 */
export function planPresenceGc(
  files: readonly PresenceFile[],
  thresholds: Thresholds,
  probe: LivenessProbe,
  ttlMs: number = PRESENCE_GC_TTL_MS,
): string[] {
  const out: string[] = []
  for (const f of files) {
    if (f.record === null) {
      out.push(f.path)
      continue
    }
    const l = classifyLiveness(f.record, thresholds, probe)
    if ((l.status === "dead" || l.status === "offline") && l.ageMs > ttlMs) {
      out.push(f.path)
    }
  }
  return out
}

/**
 * Decide which orphan aux files to delete: those whose sid has no live presence
 * record and whose file age exceeds `ttlMs`. Pure.
 *
 * `liveSids` is the set of sids that currently have ANY presence record on disk
 * (alive or recently dead) — we keep aux files as long as the owner is still
 * known, and only reap once both the presence record is gone AND the file has
 * aged out.
 */
export function planOrphanGc(
  files: readonly AuxFile[],
  liveSids: ReadonlySet<string>,
  now: number,
  ttlMs: number = ORPHAN_GC_TTL_MS,
): string[] {
  const out: string[] = []
  for (const f of files) {
    if (liveSids.has(f.sid)) continue
    const age = now - f.mtimeMs
    if (Number.isFinite(age) && age > ttlMs) out.push(f.path)
  }
  return out
}

/**
 * Decide which FOREIGN sub-agents presence files to delete: those whose file
 * mtime is older than `ttlMs` (a dead lead's leftover — a live lead rewrites
 * every heartbeat). Pure; keyed on mtime only because we don't own or trust the
 * contents and a whole stale file = a whole dead fleet snapshot.
 */
export function planForeignGc(
  files: readonly AuxFile[],
  now: number,
  ttlMs: number = FOREIGN_GC_TTL_MS,
): string[] {
  const out: string[] = []
  for (const f of files) {
    const age = now - f.mtimeMs
    if (Number.isFinite(age) && age > ttlMs) out.push(f.path)
  }
  return out
}

// ---------------------------------------------------------------------------
// IO shell
// ---------------------------------------------------------------------------

/** Strip a known suffix from a filename to recover the sid, or null. */
function sidFromName(name: string, suffix: string): string | null {
  return name.endsWith(suffix) ? name.slice(0, -suffix.length) : null
}

/** List `dir` entries that end with `suffix`, paired with mtime. Empty when absent. */
function listAux(dir: string, suffix: string): AuxFile[] {
  if (!existsSync(dir)) return []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: AuxFile[] = []
  for (const name of names) {
    if (name.includes(".tmp-")) continue
    const sid = sidFromName(name, suffix)
    if (sid === null) continue
    const path = join(dir, name)
    let mtimeMs = 0
    try {
      mtimeMs = statSync(path).mtimeMs
    } catch {
      continue
    }
    out.push({ sid, path, mtimeMs })
  }
  return out
}

/** Read every intercom presence file paired with its parsed record. */
function listPresence(dir: string): PresenceFile[] {
  if (!existsSync(dir)) return []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: PresenceFile[] = []
  for (const name of names) {
    if (!name.endsWith(".json") || name.includes(".tmp-")) continue
    const sid = name.slice(0, -".json".length)
    const path = join(dir, name)
    out.push({ sid, path, record: readPresenceFile(path) })
  }
  return out
}

/** What a GC sweep removed. */
export interface GcResult {
  readonly prunedPresence: number
  readonly prunedOrphans: number
  readonly prunedForeign: number
}

/** Injected knobs for {@link runGc} (env + clock + probe). */
export interface GcDeps {
  readonly env: NodeJS.ProcessEnv
  readonly now: number
  readonly thresholds: Thresholds
  readonly pidAlive: (pid: number) => boolean
  readonly host: string
  readonly presenceTtlMs?: number
  readonly orphanTtlMs?: number
  readonly foreignTtlMs?: number
  /**
   * Also prune the foreign sub-agents presence dir (dead-lead leftover files).
   * Default true. The sub-agents plugin never GCs its own
   * `~/.minimal-agent/presence/` dir, so without this it grows without bound and
   * inflates the roster. Set false to leave that dir untouched.
   */
  readonly sweepForeign?: boolean
}

/**
 * Sweep the intercom store once. Best-effort: never throws (an unlink failure is
 * swallowed). Returns counts for diagnostics. Idempotent and concurrency-safe.
 *
 * Only intercom-owned dirs are touched. The foreign sub-agents presence feed
 * (`~/.minimal-agent/presence/`) is read-only to us and is filtered at roster
 * build time, not deleted here.
 */
export function runGc(deps: GcDeps): GcResult {
  const probe: LivenessProbe = { now: deps.now, pidAlive: deps.pidAlive, host: deps.host }

  // 1. Dead/old presence.
  const pdir = presenceDir(deps.env)
  const presenceFiles = listPresence(pdir)
  const presenceToDelete = planPresenceGc(
    presenceFiles,
    deps.thresholds,
    probe,
    deps.presenceTtlMs ?? PRESENCE_GC_TTL_MS,
  )

  // Sids that still have a presence record AFTER the presence prune — those are
  // the owners whose aux files we must keep.
  const deleteSet = new Set(presenceToDelete)
  const liveSids = new Set<string>()
  for (const f of presenceFiles) {
    if (!deleteSet.has(f.path) && f.record !== null) liveSids.add(f.sid)
  }

  // 2. Orphan aux files (inbox/cursor/self) whose owner is gone + aged out.
  const aux: AuxFile[] = [
    ...listAux(inboxDir(deps.env), ".jsonl"),
    ...listAux(cursorsDir(deps.env), ".json"),
    ...listAux(selfDir(deps.env), ".json"),
  ]
  const orphansToDelete = planOrphanGc(
    aux,
    liveSids,
    deps.now,
    deps.orphanTtlMs ?? ORPHAN_GC_TTL_MS,
  )

  let prunedPresence = 0
  for (const p of presenceToDelete) {
    try {
      rmSync(p, { force: true })
      prunedPresence += 1
    } catch {
      // ignore — another GC may have removed it
    }
  }
  let prunedOrphans = 0
  for (const p of orphansToDelete) {
    try {
      rmSync(p, { force: true })
      prunedOrphans += 1
    } catch {
      // ignore
    }
  }

  // 3. Foreign sub-agents presence graveyard (dead-lead leftover files). The
  // sub-agents plugin never sweeps its own dir, so intercom prunes stale files
  // (mtime older than the foreign TTL) to keep the merged roster honest.
  let prunedForeign = 0
  if (deps.sweepForeign !== false) {
    const foreign = listAux(subagentsPresenceDir(deps.env), ".jsonl")
    const foreignToDelete = planForeignGc(foreign, deps.now, deps.foreignTtlMs ?? FOREIGN_GC_TTL_MS)
    for (const p of foreignToDelete) {
      try {
        rmSync(p, { force: true })
        prunedForeign += 1
      } catch {
        // ignore
      }
    }
  }

  return { prunedPresence, prunedOrphans, prunedForeign }
}
