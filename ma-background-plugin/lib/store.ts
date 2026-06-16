/**
 * Per-session job index: the Repository over `<sid>.bgjobs.jsonl`.
 *
 * Mirrors minimal-agent's sub-agents store: pure {@link parseRecords} /
 * {@link serializeRecords} (no IO) under a thin {@link BgJobStore} imperative
 * shell that reads/writes the file. One writer per session by construction (the
 * harness), so a full rewrite per mutation is fine: the file is tiny (one line
 * per job).
 *
 * Collection-like (Repository pattern): `all`, `get`, `upsert`, `replaceAll`.
 * Id minting ({@link nextId}) is pure and monotonic so handles stay stable
 * across eviction.
 *
 * @module lib/store
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import { indexPath } from "./paths.ts"
import { type JobId, type JobRecord, jobId } from "./types.ts"

// ---------------------------------------------------------------------------
// Pure parse / serialize
// ---------------------------------------------------------------------------

/**
 * Parse JSONL into records. Tolerant: blank lines and unparseable/!object lines
 * are skipped (a corrupt tail must not wipe the index). Order preserved.
 */
export function parseRecords(text: string): JobRecord[] {
  const out: JobRecord[] = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let obj: unknown
    try {
      obj = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (obj && typeof obj === "object" && typeof (obj as JobRecord).id === "string") {
      out.push(obj as JobRecord)
    }
  }
  return out
}

/** Serialize records to JSONL (one compact line each, trailing newline). */
export function serializeRecords(records: readonly JobRecord[]): string {
  return records.length === 0 ? "" : `${records.map((r) => JSON.stringify(r)).join("\n")}\n`
}

/**
 * Mint the next job id: prefix + (max existing numeric suffix + 1), so ids are
 * monotonic and never reused even after a record is evicted. Pure. Default
 * prefix `"j"` yields `j1`, `j2`, ... `j100`.
 */
export function nextId(records: readonly JobRecord[], prefix = "j"): JobId {
  let max = 0
  for (const r of records) {
    if (!r.id.startsWith(prefix)) continue
    const n = Number.parseInt(r.id.slice(prefix.length), 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return jobId(`${prefix}${max + 1}`)
}

/**
 * Evict oldest TERMINAL records past `maxTotal`. Never evicts an active record.
 * Insertion order is oldest-first, so we scan from the front. Pure: returns a
 * new array. `isActiveFn` decides which records must be kept.
 */
export function evictExcess(
  records: readonly JobRecord[],
  maxTotal: number,
  isActiveFn: (r: JobRecord) => boolean,
): JobRecord[] {
  if (records.length <= maxTotal) return [...records]
  const out = [...records]
  let removable = out.filter((r) => !isActiveFn(r)).length
  let overBy = out.length - maxTotal
  for (let i = 0; i < out.length && overBy > 0 && removable > 0; ) {
    if (!isActiveFn(out[i])) {
      out.splice(i, 1)
      overBy--
      removable--
    } else {
      i++
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Store (imperative shell)
// ---------------------------------------------------------------------------

/** Injectable deps (tests point `dir` at a tmp folder; prod uses the default). */
export interface StoreDeps {
  /** Sessions directory. Defaults to the resolved `~/.minimal-agent/sessions`. */
  readonly sessionsDir: string
}

/**
 * Collection-like access to one session's job index. Construct one per session.
 * Every read hits disk (the file is tiny), every write is a full rewrite.
 */
export class BgJobStore {
  private readonly path: string

  constructor(
    public readonly sid: string,
    deps: StoreDeps,
  ) {
    this.path = indexPath(deps.sessionsDir, sid)
  }

  /** Absolute path to the backing file. */
  filePath(): string {
    return this.path
  }

  /** Load all records (empty when the file is absent). */
  all(): JobRecord[] {
    if (!existsSync(this.path)) return []
    return parseRecords(readFileSync(this.path, "utf-8"))
  }

  /** Fetch one record by id, or `null`. */
  get(id: string): JobRecord | null {
    return this.all().find((r) => r.id === id) ?? null
  }

  /** Replace the entire index (used by the reconcile pass). */
  replaceAll(records: readonly JobRecord[]): void {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, serializeRecords(records))
  }

  /**
   * Insert or replace one record (matched by id), preserving order: an existing
   * id is updated in place, a new id is appended.
   */
  upsert(record: JobRecord): void {
    const records = this.all()
    const idx = records.findIndex((r) => r.id === record.id)
    if (idx === -1) records.push(record)
    else records[idx] = record
    this.replaceAll(records)
  }

  /** Mint the next handle id for this session (pure {@link nextId} over state). */
  nextId(prefix = "j"): JobId {
    return nextId(this.all(), prefix)
  }
}
