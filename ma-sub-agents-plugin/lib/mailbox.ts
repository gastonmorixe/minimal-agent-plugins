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

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"

/** One mailbox message. `to: "*"` is a broadcast. */
/**
 * The message kinds that the SubAgentsMailbox `kind` param names. The field
 * stays free-form (the handler keeps any string); these are the documented
 * values, and `DEFAULT_MAIL_KIND` is the one the handler sets.
 */
export const MAIL_KINDS = ["note", "claim", "blocker", "handoff"] as const

/** The kind of a message posted with no `kind`. */
export const DEFAULT_MAIL_KIND = "note"

export interface MailMessage {
  readonly ts: string
  /** Sender handle: a worker id (`"A2"`) or `"lead"`. */
  readonly from: string
  /** Recipient handle, or `"*"` for broadcast. */
  readonly to: string
  /** Free-form category. The tool text names the {@link MAIL_KINDS}; any other string is kept as it is. */
  readonly kind: string
  readonly body: string
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
