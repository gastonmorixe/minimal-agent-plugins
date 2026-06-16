/**
 * Renderers: turn rosters / peer inspections / inboxes into the two surfaces a
 * tool result has — a plain-text `content` the model reads (no ANSI) and an
 * optional ANSI `display` the user sees in the transcript. Pure.
 *
 * @module lib/render
 */

import type { Envelope } from "./envelope.ts"
import type { Liveness } from "./liveness.ts"
import { livenessLabel } from "./liveness.ts"
import type { PresenceRecord } from "./presence.ts"
import type { RosterCounts, RosterRow } from "./roster.ts"
import { sanitizePeerLine, sanitizePeerText } from "./sanitize.ts"
import type { PeerFleetMember, PeerJob, PeerTask, TaskSummary } from "./sidecars.ts"
import { bold, cyan, dim, gray, green, magenta, red, yellow } from "./style.ts"

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/** Compact "Xs / Xm / Xh / Xd ago" from a ms age. */
export function ago(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?"
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/** Last path segment, for compact cwd display. */
export function baseName(path: string): string {
  if (!path) return ""
  const parts = path.replace(/\/+$/, "").split("/")
  return parts[parts.length - 1] || path
}

// ---------------------------------------------------------------------------
// Roster (Peers list)
// ---------------------------------------------------------------------------

/** Plain-text roster for the model. */
export function renderRosterText(rows: readonly RosterRow[], counts: RosterCounts): string {
  if (rows.length === 0) return "No other sessions found. You're the only one running."
  const lines: string[] = []
  lines.push(
    `${rows.length} session(s) · ${counts.online + counts.busy + counts.idle} reachable` +
      (counts.busy > 0 ? ` (${counts.busy} busy)` : ""),
  )
  for (const row of rows) {
    const r = row.record
    const verdict = livenessLabel(row.liveness)
    const self = row.isSelf ? " (you)" : ""
    // model / cwd / activity are peer-reported; sanitize before model-facing text.
    const where = sanitizePeerLine(baseName(r.cwd)) || "?"
    const model = r.model ? sanitizePeerLine(r.model) : "?"
    const act = r.activity ? ` · ${sanitizePeerLine(r.activity)}` : ""
    const seen = row.liveness.status === "online" ? "" : ` · ${ago(row.liveness.ageMs)}`
    lines.push(
      `  ${sanitizePeerLine(r.short)}${self}  [${verdict}]  ${model}  ${where}${act}${seen}`,
    )
  }
  return lines.join("\n")
}

const VERDICT_COLOR: Record<Liveness["status"], (s: string) => string> = {
  online: green,
  stale: yellow,
  hung: yellow,
  dead: red,
  offline: gray,
}

/** ANSI roster for the transcript. */
export function renderRosterDisplay(rows: readonly RosterRow[]): string {
  if (rows.length === 0) return dim("no other sessions")
  const lines: string[] = []
  for (const row of rows) {
    const r = row.record
    const paint = VERDICT_COLOR[row.liveness.status]
    const verdict = paint(`●`)
    const self = row.isSelf ? dim(" (you)") : ""
    const where = gray(baseName(r.cwd) || "?")
    const act = r.activity ? dim(` · ${r.activity}`) : ""
    const seen = row.liveness.status === "online" ? "" : dim(` · ${ago(row.liveness.ageMs)}`)
    lines.push(
      `  ${verdict} ${bold(r.short)}${self}  ${paint(livenessLabel(row.liveness).padEnd(7))} ${dim(r.model || "?")}  ${where}${act}${seen}`,
    )
  }
  return lines.join("\n")
}

/**
 * The ambient footer line, or null when no peers are reachable.
 *
 * The footer leads with the REACHABLE count (online + stale), never the raw
 * total: a graveyard of dead/offline sessions in the presence dir must never
 * inflate the headline number (the "606 peers" bug). When there are reachable
 * peers we add a faint trailer for how many others are merely known-but-gone, so
 * the information isn't lost, just not shouted.
 */
export function renderFooter(counts: RosterCounts): string | null {
  const reachable = counts.online + counts.busy + counts.idle
  if (reachable === 0) return null
  const parts: string[] = [green(`${reachable} online`)]
  if (counts.busy > 0) parts.push(yellow(`${counts.busy} busy`))
  if (counts.other > 0) parts.push(dim(`${counts.other} gone`))
  return `${magenta("⇆ intercom")} ${dim("·")} ${parts.join(dim(" · "))}`
}

// ---------------------------------------------------------------------------
// Inbox (received messages)
// ---------------------------------------------------------------------------

const KIND_GLYPH: Record<Envelope["kind"], string> = {
  note: "✉",
  ping: "‼",
  interrupt: "⛔",
}

/** Body of the `<ma::agent::intercom-inbox>` attachment (plain, model-facing). */
export function renderInboxBody(envs: readonly Envelope[]): string {
  const lines: string[] = []
  for (const e of envs) {
    // Every peer-sourced field is sanitized: a message from another session is
    // untrusted text and must never be able to forge `<ma::...>` framing or a
    // closing tag inside our trusted attachment block.
    const reply = e.replyTo ? ` reply-to=${sanitizePeerLine(e.replyTo)}` : ""
    const where = e.from.cwd ? ` cwd=${sanitizePeerLine(baseName(e.from.cwd))}` : ""
    const short = sanitizePeerLine(e.from.short)
    const model = e.from.model ? sanitizePeerLine(e.from.model) : "?"
    lines.push(
      `[${e.kind}] from ${short} (${model}${where}) id=${sanitizePeerLine(e.id)}${reply} at ${e.ts}`,
    )
    for (const bl of sanitizePeerText(e.body).split("\n")) lines.push(`    ${bl}`)
  }
  return lines.join("\n")
}

/** ANSI inbox for the transcript (Inbox tool display). */
export function renderInboxDisplay(envs: readonly Envelope[]): string {
  if (envs.length === 0) return dim("inbox empty")
  const lines: string[] = []
  for (const e of envs) {
    const glyph =
      e.kind === "interrupt"
        ? red(KIND_GLYPH[e.kind])
        : e.kind === "ping"
          ? yellow(KIND_GLYPH[e.kind])
          : cyan(KIND_GLYPH[e.kind])
    lines.push(
      `  ${glyph} ${bold(e.from.short)} ${dim(e.ts.slice(11, 19))}  ${e.body.split("\n")[0]}`,
    )
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Peer inspection
// ---------------------------------------------------------------------------

/** The bundle of cross-plugin state gathered for one peer. */
export interface InspectBundle {
  readonly record: PresenceRecord
  readonly liveness: Liveness
  readonly tasks?: { list: readonly PeerTask[]; summary: TaskSummary }
  readonly jobs?: readonly PeerJob[]
  readonly fleet?: readonly PeerFleetMember[]
  readonly activity?: readonly string[]
  readonly transcript?: readonly string[]
  /** Errors encountered while gathering one or more sections. */
  readonly notes?: readonly string[]
}

/** Plain-text peer inspection for the model. */
export function renderInspectText(b: InspectBundle): string {
  const r = b.record
  const lines: string[] = []
  lines.push(`Peer ${r.short} (${r.sid})`)
  lines.push(
    `  liveness: ${livenessLabel(b.liveness)}${b.liveness.status === "online" ? "" : ` · ${ago(b.liveness.ageMs)}`}`,
  )
  // r.model / cwd / activity and the sidecar-sourced titles/labels below are all
  // peer-controlled; sanitize each so an inspected peer can't inject framing.
  lines.push(
    `  model: ${r.model ? sanitizePeerLine(r.model) : "?"}   pid: ${r.pid || "?"}   host: ${r.host ? sanitizePeerLine(r.host) : "?"}`,
  )
  lines.push(`  cwd: ${r.cwd ? sanitizePeerLine(r.cwd) : "?"}`)
  if (r.activity) lines.push(`  activity: ${sanitizePeerLine(r.activity)}`)

  if (b.tasks) {
    const s = b.tasks.summary
    lines.push(
      `  tasks: ${s.total} total · ${s.doing} doing · ${s.done} done · ${s.todo} todo${s.canceled ? ` · ${s.canceled} canceled` : ""}`,
    )
    for (const t of b.tasks.list.slice(0, 12)) {
      const indent = t.parent ? "      - " : "    "
      lines.push(`${indent}[${t.status}] ${sanitizePeerLine(t.title)}`)
    }
    if (b.tasks.list.length > 12) lines.push(`    … ${b.tasks.list.length - 12} more`)
  }

  if (b.jobs && b.jobs.length > 0) {
    lines.push(`  background jobs: ${b.jobs.length}`)
    for (const j of b.jobs.slice(0, 8)) {
      lines.push(
        `    ${sanitizePeerLine(j.id)} [${sanitizePeerLine(j.state)}${j.exitCode !== null ? ` exit ${j.exitCode}` : ""}] ${sanitizePeerLine(j.description || j.command)}`,
      )
    }
  }

  if (b.fleet && b.fleet.length > 0) {
    lines.push(`  sub-agent fleet: ${b.fleet.length}`)
    for (const f of b.fleet.slice(0, 8)) {
      lines.push(
        `    ${sanitizePeerLine(f.id)} [${sanitizePeerLine(f.state)}] ${sanitizePeerLine(f.label)}${f.model ? ` · ${sanitizePeerLine(f.model)}` : ""}`,
      )
    }
  }

  if (b.activity && b.activity.length > 0) {
    lines.push(`  recent activity:`)
    for (const a of b.activity) lines.push(`    ${sanitizePeerText(a)}`)
  }

  if (b.transcript && b.transcript.length > 0) {
    lines.push(`  transcript excerpt:`)
    for (const t of b.transcript) lines.push(`    ${sanitizePeerText(t)}`)
  }

  if (b.notes && b.notes.length > 0) {
    // notes are intercom-generated, not peer text, but cheap to keep clean.
    for (const n of b.notes) lines.push(`  note: ${n}`)
  }

  return lines.join("\n")
}

/** Short ANSI summary for the inspect transcript display. */
export function renderInspectDisplay(b: InspectBundle): string {
  const r = b.record
  const paint = VERDICT_COLOR[b.liveness.status]
  const head = `${paint("●")} ${bold(r.short)} ${dim(r.model || "?")} ${gray(baseName(r.cwd) || "?")}`
  const bits: string[] = []
  if (b.tasks) bits.push(`${b.tasks.summary.doing}▸/${b.tasks.summary.total} tasks`)
  if (b.jobs && b.jobs.length) bits.push(`${b.jobs.length} jobs`)
  if (b.fleet && b.fleet.length) bits.push(`${b.fleet.length} workers`)
  return bits.length ? `${head}  ${dim(bits.join(" · "))}` : head
}
