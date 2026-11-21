/**
 * `editor.submitted` event handler.
 *
 * Subscribed via `manifest.events`. Called once for each line that the user
 * submits in the editor, with `{text, cwd, sid, submittedAt}` (the raw typed
 * line, before slash-command dispatch or expansion). The plugin does NOT
 * listen to `prompt.submitted`: that is a queue event for any origin
 * (intercom, sub-agent, cron, background, expanded commands, recovery), and
 * history must hold only what the user typed. We:
 *
 *   1. Build a fresh {@link HistoryEntry} stamped with the current
 *      time + a base36-millis-rand4hex id (matches memory plugin).
 *   2. Append it to BOTH the per-project file and the global mirror
 *      (`store.appendBoth`).
 *   3. Push it into the in-memory recall so the next ↑ surfaces it
 *      without a disk re-read.
 *
 * Best-effort: any failure (disk full, permission denied, recall
 * uninitialized) is logged and swallowed. The agent's submit path is
 * never blocked or surfaced as user-visible error.
 *
 * @module plugins/history/handlers/on_submit
 */

import type {
  EditorSubmittedPayload,
  EventHandler,
  EventHandlerContext,
} from "../lib/host-types.ts"
import { recallFor } from "../lib/session.ts"
import { appendBoth, buildEntry, isDisabled } from "../lib/store.ts"

/**
 * Runtime check of the `editor.submitted` payload (the bus is untyped at the
 * wire). `submittedAt` is the host submit time (ISO).
 */
function isPayload(v: unknown): v is EditorSubmittedPayload {
  if (!v || typeof v !== "object") return false
  const o = v as Record<string, unknown>
  return (
    typeof o.text === "string" &&
    typeof o.cwd === "string" &&
    (o.sid === null || typeof o.sid === "string") &&
    typeof o.submittedAt === "string"
  )
}

/** The submit time of the payload, or `undefined` (then now) if it is not a valid date. */
function submitTime(iso: string): Date | undefined {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? undefined : d
}

const handler: EventHandler<EditorSubmittedPayload> = async (
  ctx: EventHandlerContext<EditorSubmittedPayload>,
) => {
  if (isDisabled()) return
  const payload = ctx.payload as unknown
  if (!isPayload(payload)) {
    ctx.log.warn("on_submit", `ignoring malformed payload ${JSON.stringify(payload)}`)
    return
  }
  const { text, sid } = payload
  if (text.trim().length === 0) return
  // We use `ctx.cwd` (the agent's working directory) as the index key
  // for both the on-disk file AND the in-memory recall — not
  // `payload.cwd`. In production they're equal (one agent process, one
  // cwd). In tests it lets us reliably scope state without round-trip
  // mismatches. The entry's `cwd` field still records `payload.cwd` as
  // an audit field — that's what the EMITTER observed.
  const recordCwd = typeof payload.cwd === "string" ? payload.cwd : ctx.cwd
  const at = submitTime(payload.submittedAt)
  // The host has no "canceled draft" submit path: each entry is `submitted`.
  const entry = buildEntry(
    { text, cwd: recordCwd, sid, exit: "submitted" },
    at ? { now: () => at } : {},
  )
  appendBoth(entry, {
    // The project file's path key is the AGENT's cwd (ctx.cwd), even
    // if payload.cwd differs (which only happens in tests). The entry
    // ROW still carries payload.cwd as a metadata field — see the
    // `recordCwd` variable above.
    projectCwd: ctx.cwd,
    logger: (m) => ctx.log.warn("on_submit", m),
  })
  // Notify the in-memory recall so ↑ on the next turn surfaces the
  // entry. Best-effort — if the recall was never built (e.g. ↑ never
  // pressed), this is the FIRST instantiation and it'll load disk;
  // either way the push runs against a known-good Recall.
  try {
    recallFor(ctx.cwd).push(text)
  } catch (e) {
    ctx.log.warn("on_submit", `recall.push failed: ${e instanceof Error ? e.message : e}`)
  }
}

export default handler
