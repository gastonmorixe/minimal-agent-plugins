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
import {
  sanitizePeerLine,
  sanitizePeerText,
  sanitizeTerminalLine,
  sanitizeTerminalText,
} from "./sanitize.ts"
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

/** Short, stable display form of a computerId (leading 8 chars), or "" when absent. */
export function shortComputerId(computerId: string | undefined): string {
  if (!computerId) return ""
  return computerId.slice(0, 8)
}

// ---------------------------------------------------------------------------
// Peer labels (Name (short) when named, else short)
// ---------------------------------------------------------------------------

/**
 * Plain peer label for headers / model text.
 *
 * Prefer `Name (short)` when a display name is present, else the short id alone.
 * Keeps the short id always addressable while making named sessions readable.
 */
export function peerLabel(short: string, name?: string | null): string {
  const s = (short || "").trim()
  const n = typeof name === "string" ? name.trim() : ""
  if (n && s) return `${n} (${s})`
  if (n) return n
  return s || "?"
}

/**
 * ANSI peer label for the transcript body / header slots.
 * Name is bold, short id is dim inside parens when both are present.
 */
export function peerLabelDisplay(short: string, name?: string | null): string {
  const s = (short || "").trim()
  const n = typeof name === "string" ? name.trim() : ""
  if (n && s) return `${bold(n)} ${dim(`(${s})`)}`
  if (n) return bold(n)
  return bold(s || "?")
}

/**
 * Pad a multi-line body with blank rows so the host frame draws empty `│`
 * gutters above and below the content (matches arrival-notice spacing).
 *
 * Pair with `displayFooter: ""` on the tool result. Without a defined footer,
 * the host rewrites the last body line onto the `╰` closer — the trailing
 * blank from this pad is not enough on its own (it gets stripped when footer
 * is absent). Empty footer keeps every body line as `│` and draws a bare `╰`.
 *
 * Empty input stays empty (no phantom padding for empty results).
 */
export function padDisplayBody(body: string): string {
  if (!body) return body
  return `\n${body}\n`
}

/** Scope text for send headers: all / project / team / peer ref. */
export function scopeLabel(scope: string): string {
  const s = scope.trim()
  const lower = s.toLowerCase()
  if (lower === "all" || lower === "*" || lower === "broadcast") return "all"
  if (lower === "project" || lower === "project:.") return "project"
  if (lower.startsWith("team:")) return s
  return s
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
    // Prefer Name (short) when named; short alone when not.
    const label = peerLabel(
      sanitizePeerLine(r.short),
      r.name ? sanitizePeerLine(r.name) : undefined,
    )
    // model / cwd / activity are peer-reported; sanitize before model-facing text.
    const where = sanitizePeerLine(baseName(r.cwd)) || "?"
    const model = r.model ? sanitizePeerLine(r.model) : "?"
    const act = r.activity ? ` · ${sanitizePeerLine(r.activity)}` : ""
    const seen = row.liveness.status === "online" ? "" : ` · ${ago(row.liveness.ageMs)}`
    // Remote peers carry a (Remote) tag + their computerId so the model knows the
    // peer is on another machine and which one. Local peers render unchanged.
    const cid = shortComputerId(r.computerId)
    const remote = row.isRemote ? ` (Remote${cid ? ` ${sanitizePeerLine(cid)}` : ""})` : ""
    lines.push(`  ${label}${self}${remote}  [${verdict}]  ${model}  ${where}${act}${seen}`)
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
  if (rows.length === 0) return padDisplayBody(dim("no other sessions"))
  const lines: string[] = []
  for (const row of rows) {
    const r = row.record
    const paint = VERDICT_COLOR[row.liveness.status]
    const verdict = paint(`●`)
    const self = row.isSelf ? dim(" (you)") : ""
    const label = peerLabelDisplay(r.short, r.name)
    const where = gray(baseName(r.cwd) || "?")
    const act = r.activity ? dim(` · ${r.activity}`) : ""
    const seen = row.liveness.status === "online" ? "" : dim(` · ${ago(row.liveness.ageMs)}`)
    const cid = shortComputerId(r.computerId)
    const remote = row.isRemote ? dim(` (Remote${cid ? ` ${cid}` : ""})`) : ""
    lines.push(
      `  ${verdict} ${label}${self}${remote}  ${paint(livenessLabel(row.liveness).padEnd(7))} ${dim(r.model || "?")}  ${where}${act}${seen}`,
    )
  }
  return padDisplayBody(lines.join("\n"))
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
    const name = e.from.name ? sanitizePeerLine(e.from.name) : undefined
    const who = peerLabel(short, name)
    const model = e.from.model ? sanitizePeerLine(e.from.model) : "?"
    lines.push(
      `[${e.kind}] from ${who} (${model}${where}) id=${sanitizePeerLine(e.id)}${reply} at ${e.ts}`,
    )
    for (const bl of sanitizePeerText(e.body).split("\n")) lines.push(`    ${bl}`)
  }
  return lines.join("\n")
}

/** ANSI inbox for the transcript (Inbox tool display). */
export function renderInboxDisplay(envs: readonly Envelope[]): string {
  if (envs.length === 0) return padDisplayBody(dim("inbox empty"))
  // Single message: body only (who/when live in the tool header when useful).
  // Multi: a dim from-line before each body so messages stay attributable
  // without stuffing model/time chrome into the frame.
  const lines: string[] = []
  for (const e of envs) {
    if (envs.length > 1) {
      const who = peerLabelDisplay(
        sanitizeTerminalLine(e.from.short),
        e.from.name ? sanitizeTerminalLine(e.from.name) : undefined,
      )
      const ts = e.ts.length >= 19 ? dim(e.ts.slice(11, 19)) : ""
      const tag = e.kind === "interrupt" ? `${red("interrupt")} ${dim("·")} ` : ""
      lines.push(`${tag}${who}${ts ? ` ${dim("·")} ${ts}` : ""}`)
    }
    for (const bl of sanitizeTerminalText(e.body).split("\n")) lines.push(bl)
    if (envs.length > 1 && e !== envs[envs.length - 1]) lines.push("")
  }
  return padDisplayBody(lines.join("\n"))
}

// ---------------------------------------------------------------------------
// Send tool presentation (displayHeader / display body)
// ---------------------------------------------------------------------------

/** Inputs for the Send tool's TUI presentation. */
export interface SendDisplayInput {
  readonly kind: Envelope["kind"]
  readonly scope: string
  readonly delivered: readonly { short: string; sid: string; name?: string }[]
  readonly body: string
  readonly isError?: boolean
  readonly errorNote?: string
}

/**
 * Header content slot for IntercomSend (after host icon + tool label).
 *
 * Host already paints `→ IntercomSend`. This slot is the destination only so the
 * row reads:
 *
 *   ╭ → IntercomSend → Sergio (3782589f) · 09:19:26
 *
 * Interrupt keeps a palette-red urgency word; the default "message" kind is
 * silent (the send tool itself is the action).
 */
export function renderSendHeader(input: SendDisplayInput): string {
  const scope = scopeLabel(input.scope)
  const lower = scope.toLowerCase()
  const isBroadcast = lower === "all" || lower === "project" || lower.startsWith("team:")

  let dest: string
  if (isBroadcast) {
    const n = input.delivered.length
    const peerWord = n === 1 ? "peer" : "peers"
    dest = n > 0 ? `${cyan(scope)} ${dim(`· ${n} ${peerWord}`)}` : cyan(scope)
  } else if (input.delivered.length === 1) {
    const d = input.delivered[0]!
    dest = peerLabelDisplay(d.short, d.name)
  } else if (input.delivered.length > 1) {
    dest = input.delivered.map((d) => peerLabel(d.short, d.name)).join(", ")
  } else {
    // Failed / no delivery: still show the addressed scope so the header is useful.
    dest = dim(scope)
  }

  const arrow = dim("→")
  const err = input.isError ? ` ${red("failed")}` : ""
  // `red()` is palette-aware (MINIMAL_AGENT_PALETTE), not a hardcoded SGR.
  if (input.kind === "interrupt") {
    return `${red("interrupt")} ${dim("·")} ${arrow} ${dest}${err}`
  }
  return `${arrow} ${dest}${err}`
}

/**
 * Body for IntercomSend: padded message text (and optional error note).
 * Host owns the frame; we only supply bare ANSI rows with blank padding.
 */
export function renderSendDisplay(input: SendDisplayInput): string {
  const parts: string[] = []
  if (input.isError && input.errorNote) {
    parts.push(red(input.errorNote))
    if (input.body) parts.push("")
  }
  if (input.body) {
    for (const bl of sanitizeTerminalText(input.body).split("\n")) parts.push(bl)
  }
  if (parts.length === 0) return padDisplayBody(dim("(empty)"))
  return padDisplayBody(parts.join("\n"))
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
  const label = peerLabel(sanitizePeerLine(r.short), r.name ? sanitizePeerLine(r.name) : undefined)
  lines.push(`Peer ${label}`)
  lines.push(`  sid: ${sanitizePeerLine(r.sid)}`)
  lines.push(
    `  liveness: ${livenessLabel(b.liveness)}${b.liveness.status === "online" ? "" : ` · ${ago(b.liveness.ageMs)}`}`,
  )
  // r.model / cwd / activity and the sidecar-sourced titles/labels below are all
  // peer-controlled; sanitize each so an inspected peer can't inject framing.
  lines.push(
    `  model: ${r.model ? sanitizePeerLine(r.model) : "?"}   pid: ${r.pid || "?"}   host: ${r.host ? sanitizePeerLine(r.host) : "?"}`,
  )
  // computerId + remote marker: which machine the peer is on (global address half).
  const cid = shortComputerId(r.computerId)
  if (cid || b.record.origin === "remote") {
    lines.push(
      `  computer: ${cid ? sanitizePeerLine(cid) : "?"}${b.record.origin === "remote" ? " (Remote)" : ""}`,
    )
  }
  lines.push(`  cwd: ${r.cwd ? sanitizePeerLine(r.cwd) : "?"}`)
  if (r.teams && r.teams.length > 0) {
    lines.push(`  teams: ${r.teams.map((t) => sanitizePeerLine(t)).join(", ")}`)
  }
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
  const who = peerLabelDisplay(r.short, r.name)
  const head = `${paint("●")} ${who}  ${dim(r.model || "?")}  ${gray(baseName(r.cwd) || "?")}`
  const bits: string[] = []
  if (b.tasks) bits.push(`${b.tasks.summary.doing}▸/${b.tasks.summary.total} tasks`)
  if (b.jobs && b.jobs.length) bits.push(`${b.jobs.length} jobs`)
  if (b.fleet && b.fleet.length) bits.push(`${b.fleet.length} workers`)
  const line = bits.length ? `${head}  ${dim(bits.join(" · "))}` : head
  return padDisplayBody(line)
}

/**
 * Header content slot for IntercomPeers inspect (after host icon + tool label).
 * e.g. `inspect · Sergio (3782589f)`
 */
export function renderInspectHeader(short: string, name?: string | null): string {
  return `${dim("inspect")} ${dim("·")} ${peerLabelDisplay(short, name)}`
}

/**
 * Header content slot for IntercomPeers list.
 * e.g. `3 sessions · 2 reachable`
 */
export function renderPeersListHeader(
  rowsCount: number,
  online: number,
  busy: number,
  idle: number,
): string {
  const parts: string[] = [`${rowsCount} session${rowsCount === 1 ? "" : "s"}`]
  const reachable = online + busy + idle
  if (reachable > 0 && reachable < rowsCount) parts.push(`${reachable} reachable`)
  else if (reachable > 0 && reachable === rowsCount) parts.push(`${reachable} reachable`)
  if (busy > 0) parts.push(`${busy} busy`)
  return dim(parts.join(" · "))
}

/**
 * Header content slot for IntercomInbox.
 * e.g. `unread · 2/5` or `recent · 3/3`
 */
export function renderInboxHeader(scope: string, selected: number, total: number): string {
  const s = scope === "recent" ? "recent" : "unread"
  return `${dim(s)} ${dim("·")} ${dim(`${selected}/${total}`)}`
}

/**
 * The "N new message(s)" label (plain). Used by persistence text and as a
 * multi-arrival header fallback when no single peer is the subject.
 */
export function arrivalLabel(count: number): string {
  return count === 1 ? "1 new message" : `${count} new messages`
}

/**
 * Header `info` slot for one arrival notice (after icon + "Intercom" title).
 *
 * Always one envelope per toast (the beat emits one notice per message):
 *   `from Sergio (3782589f)`
 *   `interrupt · from Sergio (3782589f)`  — "interrupt" is palette-red ANSI
 *
 * Note: host `info` is dimmed as a whole by `renderCommandNoticeBlock`, which
 * would wash out red. For interrupt we put the urgency word in the title instead
 * when building the block (see {@link toArrivalNotice}).
 */
export function renderArrivalInfo(e: Envelope): string {
  const who = peerLabel(
    sanitizeTerminalLine(e.from.short),
    e.from.name ? sanitizeTerminalLine(e.from.name) : undefined,
  )
  return `from ${who}`
}

/** Optional host `timestamp` slot (HH:MM:SS) for one arrival. */
export function renderArrivalTimestamp(e: Envelope): string | undefined {
  const ts = e.ts
  return ts.length >= 19 ? ts.slice(11, 19) : undefined
}

/**
 * Optional host `footer` slot: model name. Empty string means "no footer"
 * (host draws a bare `╰`).
 */
export function renderArrivalFooter(e: Envelope): string {
  return e.from.model ? sanitizeTerminalLine(e.from.model) : ""
}

/**
 * The structured payload for the `notification.emit` bus channel.
 *
 * `block` is a host `CommandNoticeBlock` (the host frames it; `body` is our bare
 * ANSI rows). `text` is the plain record the host persists to the session log.
 * This is the plugin↔host contract DTO; the host validates it at the boundary
 * (`coerceNoticeBlock`) before rendering.
 *
 * Presentation contract:
 *   header  = icon + "Intercom" + who/action (+ time for single)
 *   body    = message text only
 *   footer  = model (single) or count (multi)
 */
export interface ArrivalNotice {
  readonly source: "intercom"
  readonly block: {
    readonly icon: string
    readonly title: string
    readonly info: string
    readonly color: string
    readonly body: string[]
    readonly footer?: string
    readonly timestamp?: string
  }
  readonly text: string
}

/**
 * Build the full `notification.emit` payload for ONE fresh message.
 *
 * One toast per envelope (the beat loops). That keeps the header always
 * `from Name (short)` — never a vague "2 new messages · …" batch line.
 *
 * Interrupt urgency: host dims the entire `info` slot, so "interrupt" would
 * lose its red. Put the urgency word in `title` instead (`Intercom interrupt`),
 * with palette-red ANSI on that word only; normal arrivals stay `Intercom`.
 *
 * Pure. The beat handler decides WHEN to notify; this owns WHAT it looks like.
 */
export function toArrivalNotice(e: Envelope): ArrivalNotice {
  const footer = renderArrivalFooter(e)
  const timestamp = renderArrivalTimestamp(e)
  const isIrq = e.kind === "interrupt"
  // Title is host-accented (magenta). For interrupt, append a palette-red word
  // after the accented title so urgency survives host chrome.
  const title = isIrq ? `Intercom ${red("interrupt")}` : "Intercom"
  return {
    source: "intercom",
    block: {
      // ↓ = receive (matches Inbox tool icon).
      icon: "↓",
      title,
      info: renderArrivalInfo(e),
      color: "magenta",
      body: renderArrivalLines(e),
      ...(footer ? { footer } : {}),
      ...(timestamp ? { timestamp } : {}),
    },
    text: renderArrivalText(e),
  }
}

/**
 * Build one notice per envelope. Prefer this at the beat so each message gets
 * its own framed toast with a clear `from …` header.
 */
export function toArrivalNotices(fresh: readonly Envelope[]): ArrivalNotice[] {
  return fresh.map((e) => toArrivalNotice(e))
}

/**
 * Styled body rows for the arrival notice, for a HUMAN terminal.
 *
 * Message text ONLY for one envelope. Who / when / model live in header/footer.
 *
 * Returns the BARE content rows only: no `╭│╰` frame. The host owns chrome.
 * Does NOT html-escape peer text (the `&lt;/&gt;` bug) — terminal sanitize only.
 */
export function renderArrivalLines(e: Envelope): string[] {
  return sanitizeTerminalText(e.body).split("\n")
}

/**
 * Plain-text rendering of one arrival notice, for JSONL persistence + resume.
 */
export function renderArrivalText(e: Envelope): string {
  const lines: string[] = [
    `↓ Intercom${e.kind === "interrupt" ? " interrupt" : ""} · ${renderArrivalInfo(e)}`,
  ]
  const ts = renderArrivalTimestamp(e)
  if (ts) lines[0] = `${lines[0]} · ${ts}`
  for (const bl of sanitizeTerminalText(e.body).split("\n")) lines.push(`  ${bl}`)
  const footer = renderArrivalFooter(e)
  if (footer) lines.push(footer)
  return lines.join("\n")
}
