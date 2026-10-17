// Counts-only session audit. File IO stays behind the contained state edge.

import type { FsResult, RegularFile } from "../state/fs.ts"
import * as stateFs from "../state/fs.ts"

export type AuditIO = {
  append(root: string, filename: string, data: string): FsResult<never>
  rename(root: string, from: string, to: string): FsResult<never>
  remove(root: string, filename: string): FsResult<never>
  read(root: string, filename: string, cap: number): FsResult<RegularFile>
}
const defaultIO: AuditIO = {
  append: stateFs.appendFileIn,
  rename: stateFs.renameFileIn,
  remove: stateFs.removeFileIn,
  read: stateFs.readRegularFileIn,
}

import { safeCount, safeProfile, safeReason, safeRuleId, safeTool } from "../status/sanitize.ts"

export const AUDIT_DECISIONS = [
  "redact",
  "note",
  "autofix",
  "deny",
  "ask",
  "tier1",
  "tier2",
  "deadline",
  "config-drop",
  "tag-collision",
  "escalate",
] as const
export type AuditDecision = (typeof AUDIT_DECISIONS)[number]
export type AuditRow = {
  time: number
  kind: "security"
  ruleId: string
  profile: "off" | "steer" | "guard" | "strict"
  decision: AuditDecision
  tool: string
  count: number
  tier: "none" | "tier1" | "tier2"
  note: string
}
export type AuditEvent = {
  ruleId?: unknown
  profile?: unknown
  decision?: unknown
  tool?: unknown
  count?: unknown
  tier?: unknown
  note?: unknown
}
export type AuditOptions = {
  root: string
  /** Session filename relative to root. No runtime data is used in a log row. */
  sessionFile: string
  maxMb?: number
  keep?: number
  now?: () => number
  enabled?: boolean
  io?: AuditIO
}
export type AuditSnapshot = {
  countsByRule: Record<string, number>
  countsByDecision: Record<AuditDecision, number>
  rotations: number
  writeFailures: number
  bytes: number
  auditWriteErrors: number
  degraded: boolean
  errorReason: "none" | "audit-io-error"
}
export type AuditLog = {
  record(event: AuditEvent): boolean
  recordRedactions(hits: readonly { ruleId: unknown; count?: unknown }[], profile: unknown): boolean
  recordDisabledRules(
    rules: readonly { id: unknown; reason: unknown; builtin?: boolean }[],
    profile: unknown,
  ): boolean
  readRecent(limit?: number): AuditRow[]
  snapshot(): AuditSnapshot
}

function decision(value: unknown): AuditDecision {
  return AUDIT_DECISIONS.find((item) => item === value) ?? "note"
}
function positive(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(value, max)
    : fallback
}
function add(a: number, b: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, a + b)
}
function rowOf(event: AuditEvent, time: number): AuditRow {
  return {
    time: safeCount(time),
    kind: "security",
    ruleId: safeRuleId(event.ruleId),
    profile: safeProfile(event.profile),
    decision: decision(event.decision),
    tool: safeTool(event.tool),
    count: event.count === undefined ? 1 : safeCount(event.count),
    tier: event.tier === "tier1" || event.tier === "tier2" ? event.tier : "none",
    note: safeReason(event.note),
  }
}

/**
 * Counts-only audit. Writes never grow the active file past its byte cap.
 * Recovery exception: an oversized pre-existing log is renamed, not truncated.
 * That archive stays untouched until normal keep-count rotation removes it.
 * Readers read only the capped active file, never any recovery archive.
 * Never returns file names, values, tags, paths, raw errors or raw config.
 */
export function createAuditLog(options: AuditOptions): AuditLog {
  const io = options.io ?? defaultIO
  const filename = `${options.sessionFile}.security-audit.jsonl`
  const maxBytes = Math.max(128, Math.floor(positive(options.maxMb, 16, 256) * 1024 * 1024))
  const keep =
    typeof options.keep === "number" && Number.isFinite(options.keep)
      ? Math.min(100, Math.max(0, Math.floor(options.keep)))
      : 3
  const now = options.now ?? Date.now
  const countsByRule: Record<string, number> = {}
  const countsByDecision = Object.fromEntries(AUDIT_DECISIONS.map((key) => [key, 0])) as Record<
    AuditDecision,
    number
  >
  let bytes = 0
  let needsBoundary = false
  let rotations = 0
  let writeFailures = 0
  let degraded = false
  let retryRows = 0
  let oversizedArchivePending = false

  function refresh(): boolean {
    const current = io.read(options.root, filename, maxBytes)
    if ("error" in current) {
      if (current.error === "too big") {
        bytes = maxBytes
        oversizedArchivePending = keep > 0
      } else if (current.error === "missing") bytes = 0
      else return false
      needsBoundary = false
    } else {
      const text = current.value?.text ?? ""
      bytes = Buffer.byteLength(text)
      needsBoundary = text !== "" && !text.endsWith("\n")
    }
    return bytes < maxBytes || rotate()
  }

  if (options.enabled !== false && !refresh()) {
    degraded = true
    retryRows = 100
    writeFailures = 1
  }

  function rotate(): boolean {
    if (keep === 0) {
      const removed = io.remove(options.root, filename)
      if ("error" in removed && removed.error !== "missing") return false
    } else {
      const removed = io.remove(options.root, `${filename}.${keep}`)
      if ("error" in removed && removed.error !== "missing") return false
      for (let n = keep - 1; n >= 1; n--) {
        const moved = io.rename(options.root, `${filename}.${n}`, `${filename}.${n + 1}`)
        if ("error" in moved && moved.error !== "missing") return false
      }
      const moved = io.rename(options.root, filename, `${filename}.1`)
      if ("error" in moved && moved.error !== "missing") return false
    }
    bytes = 0
    needsBoundary = false
    rotations = add(rotations, 1)
    return true
  }

  function record(event: AuditEvent): boolean {
    try {
      if (options.enabled === false) return true
      const row = rowOf(event, now())
      countsByRule[row.ruleId] = add(countsByRule[row.ruleId] ?? 0, row.count)
      countsByDecision[row.decision] = add(countsByDecision[row.decision], row.count)
      if (degraded) {
        retryRows--
        if (retryRows > 0) return false
        if (!refresh()) {
          writeFailures = add(writeFailures, 1)
          retryRows = 100
          return false
        }
        degraded = false
      }
      if (oversizedArchivePending) {
        oversizedArchivePending = false
        if (
          !record({ decision: "config-drop", profile: row.profile, note: "oversized-archive-kept" })
        ) {
          oversizedArchivePending = true
          return false
        }
      }
      const line = JSON.stringify(row) + "\n"
      const lineBytes = Buffer.byteLength(line)
      if (lineBytes > maxBytes) {
        writeFailures = add(writeFailures, 1)
        return false
      }
      if (bytes > 0 && bytes + lineBytes + (needsBoundary ? 1 : 0) > maxBytes && !rotate()) {
        degraded = true
        retryRows = 100
        writeFailures = add(writeFailures, 1)
        return false
      }
      const data = (needsBoundary ? "\n" : "") + line
      const result = io.append(options.root, filename, data)
      if ("error" in result) {
        degraded = true
        retryRows = 100
        writeFailures = add(writeFailures, 1)
        return false
      }
      bytes += Buffer.byteLength(data)
      needsBoundary = false
      return true
    } catch {
      degraded = true
      retryRows = 100
      writeFailures = add(writeFailures, 1)
      return false
    }
  }

  return {
    record,
    recordRedactions(hits, profile) {
      try {
        const grouped = new Map<string, number>()
        for (const hit of hits) {
          const id = safeRuleId(hit.ruleId)
          grouped.set(
            id,
            add(grouped.get(id) ?? 0, hit.count === undefined ? 1 : safeCount(hit.count)),
          )
        }
        let ok = true
        for (const [ruleId, count] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
          if (!record({ ruleId, count, profile, decision: "redact" })) ok = false
        }
        return ok
      } catch {
        writeFailures = add(writeFailures, 1)
        return false
      }
    },
    recordDisabledRules(rules, profile) {
      try {
        let ok = true
        for (const rule of rules) {
          if (!record({ ruleId: rule.id, profile, decision: "config-drop", note: rule.reason }))
            ok = false
        }
        return ok
      } catch {
        writeFailures = add(writeFailures, 1)
        return false
      }
    },
    readRecent(limit = 20) {
      try {
        const result = io.read(options.root, filename, maxBytes)
        if ("error" in result) return []
        const text = result.value?.text ?? ""
        const end = text.lastIndexOf("\n")
        if (end < 0) return []
        const rows: AuditRow[] = []
        const cap = Math.min(1000, Math.max(0, safeCount(limit)))
        if (cap === 0) return rows
        for (const line of text.slice(0, end).split("\n")) {
          try {
            const parsed: unknown = JSON.parse(line)
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue
            const value = parsed as AuditEvent & { time?: unknown }
            rows.push(rowOf(value, safeCount(value.time)))
            if (rows.length > cap) rows.shift()
          } catch {
            // A corrupt or interrupted row is not part of the report.
          }
        }
        return rows
      } catch {
        return []
      }
    },
    snapshot() {
      return {
        countsByRule: { ...countsByRule },
        countsByDecision: { ...countsByDecision },
        rotations,
        writeFailures,
        bytes,
        auditWriteErrors: writeFailures,
        degraded,
        errorReason: degraded ? "audit-io-error" : "none",
      }
    },
  }
}
