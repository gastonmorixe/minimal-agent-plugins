/**
 * The sibling mailbox — an opt-in, durable, append-only coordination channel
 * shared by a lead and its workers at `<sessionsDir>/<leadSid>.mailbox.jsonl`.
 *
 * This is the typed successor to the old bash-swarm's broadcast/inbox files.
 * It is PULL-based: a worker reads it only when its task tells it to coordinate
 * (via the `Mailbox` tool), which is exactly why it works across processes
 * where a push channel wouldn't. Strictly opt-in and bounded so a fleet doesn't
 * "distract each other with excessive updates" (Anthropic's failure mode).
 *
 * Pure parse/filter + a thin append/read shell.
 *
 * @module sub-agents/lib/mailbox
 */

import { randomBytes } from "node:crypto"
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs"
import { dirname, join } from "node:path"

/** One mailbox message. `to: "*"` is a broadcast. */
/**
 * The message kinds that the SubAgentsMailbox `kind` param names. The field
 * stays free-form (the handler keeps any string); these are the documented
 * values, and `DEFAULT_MAIL_KIND` is the one the handler sets.
 */
export const MAIL_KINDS = ["note", "claim", "blocker", "handoff", "continue"] as const

/** Kinds that start a terminal sub-agent again (`resume` is the old alias). */
export const CONTINUE_KINDS: ReadonlySet<string> = new Set(["continue", "resume"])

/** The kind of a message posted with no `kind`. */
export const DEFAULT_MAIL_KIND = "note"

export interface MailMessage {
  /** Optional unique message id (added on post for deduplication). */
  readonly id?: string
  readonly ts: string
  /** Sender handle: a worker id (`"A2"`) or `"lead"`. */
  readonly from: string
  /** Recipient handle, or `"*"` for broadcast. */
  readonly to: string
  /** Free-form category. The tool text names the {@link MAIL_KINDS}; any other string is kept as it is. */
  readonly kind: string
  readonly body: string
}

/** Generate a short unique mailbox message id. */
export function makeMailId(): string {
  return `m-${randomBytes(4).toString("hex")}`
}

/** Shared durable mailbox path for one lead fleet. */
export function mailboxPathFor(sessionsDir: string, leadSid: string): string {
  return join(sessionsDir, `${leadSid}.mailbox.jsonl`)
}

/** Tolerant JSONL parse (skips blank/corrupt lines). */
export function parseMailbox(text: string): MailMessage[] {
  const out: MailMessage[] = []
  for (const line of text.split("\n")) {
    const t = line.trim()
    if (!t) continue
    try {
      const o = JSON.parse(t)
      if (
        o &&
        typeof o.from === "string" &&
        typeof o.to === "string" &&
        typeof o.body === "string"
      ) {
        out.push({
          ...(typeof o.id === "string" && o.id.length > 0 ? { id: o.id } : {}),
          ts: String(o.ts ?? ""),
          from: o.from,
          to: o.to,
          kind: String(o.kind ?? DEFAULT_MAIL_KIND),
          body: o.body,
        })
      }
    } catch {
      // skip
    }
  }
  return out
}

/**
 * Messages visible to `me`: broadcasts, messages addressed to `me`, and `me`'s
 * own posts (so a reader sees its own thread). Optionally only those strictly
 * after `sinceIso`. Pure.
 */
export function visibleTo(
  messages: readonly MailMessage[],
  me: string,
  sinceIso?: string,
): MailMessage[] {
  return messages.filter((m) => {
    if (sinceIso && !(m.ts > sinceIso)) return false
    return m.to === "*" || m.to === me || m.from === me
  })
}

/**
 * Incoming messages addressed to `me` (or broadcast `"*"`), excluding `me`'s own
 * posts so push notifications never echo the sender's own messages.
 */
export function incomingFor(messages: readonly MailMessage[], me: string): MailMessage[] {
  return messages.filter((m) => (m.to === "*" || m.to === me) && m.from !== me)
}

/** Append one message (creates the file/dir as needed). */
export function postMessage(path: string, msg: MailMessage): void {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(msg)}\n`)
}

/** Read + parse the whole mailbox (empty when absent). */
export function readMailbox(path: string): MailMessage[] {
  if (!existsSync(path)) return []
  return parseMailbox(readFileSync(path, "utf-8"))
}

const MAX_DRAIN_BYTES = 1024 * 1024
const mailboxCursors = new Map<string, number>()

function cursorKey(path: string, me: string): string {
  return `${path}\0${me}`
}

/** Reset incremental byte-offset cursors (for tests or cleanup). */
export function resetMailboxCursor(path?: string, me?: string): void {
  if (!path) {
    mailboxCursors.clear()
    return
  }
  if (me) {
    mailboxCursors.delete(cursorKey(path, me))
    return
  }
  const prefix = `${path}\0`
  for (const key of mailboxCursors.keys()) {
    if (key.startsWith(prefix)) mailboxCursors.delete(key)
  }
}

/**
 * Incrementally drain newly appended incoming messages for `me` from `path`.
 * Fast path when idle: one `statSync` and zero file reads. Never echoes `me`'s
 * own posts. Shared across `TurnContentDrain` and `ReportResult` pre-exit check
 * so no steering message is delivered twice or missed.
 */
export function drainUnreadMessages(path: string, me: string): MailMessage[] {
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return []
  }
  const key = cursorKey(path, me)
  let offset = mailboxCursors.get(key) ?? 0
  if (size < offset) offset = 0
  if (size === offset) return []

  const length = Math.min(size - offset, MAX_DRAIN_BYTES)
  let buf: Buffer
  try {
    const fd = openSync(path, "r")
    try {
      const raw = Buffer.alloc(length)
      const n = readSync(fd, raw, 0, length, offset)
      buf = raw.subarray(0, n)
    } finally {
      closeSync(fd)
    }
  } catch {
    return []
  }

  const cut = buf.lastIndexOf(0x0a)
  if (cut < 0) return []
  const text = buf.subarray(0, cut + 1).toString("utf-8")
  mailboxCursors.set(key, offset + cut + 1)
  return incomingFor(parseMailbox(text), me)
}

/** True when a message is a steering or interrupt update that must be applied before exit. */
export function isSteeringMessage(m: MailMessage): boolean {
  return m.from === "lead" || m.kind === "steer" || m.kind === "interrupt"
}

/** Render pushed mailbox messages as a compact numbered block (zero bullets, zero semicolons). */
export function formatMailboxPush(me: string, messages: readonly MailMessage[]): string {
  const lines = messages.map((m, i) => {
    const tag = m.kind.toUpperCase()
    const idPart = m.id ? ` (${m.id})` : ""
    return `${i + 1}. [${tag} from ${m.from}${idPart}] ${m.body}`
  })
  return (
    `Mailbox update for ${me}:\n` +
    `${lines.join("\n")}\n` +
    `Apply these updates before continuing or calling SubAgentsReportResult.`
  )
}

/** Text block shape structurally matching core's `ContentBlock`. */
export interface MailboxTextBlock {
  readonly type: "text"
  readonly text: string
}

/**
 * Create a `TurnContentDrain` that pushes unread mailbox updates into a running
 * worker between tool rounds (via core's `nextRoundContent` saveEcho drain).
 */
export function createWorkerMailboxDrain(
  path: string,
  me: string,
): { consumeAll: () => MailboxTextBlock[] } {
  return {
    consumeAll: () => {
      const msgs = drainUnreadMessages(path, me)
      if (msgs.length === 0) return []
      return [{ type: "text", text: formatMailboxPush(me, msgs) }]
    },
  }
}
