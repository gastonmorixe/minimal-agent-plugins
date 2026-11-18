/**
 * Tells the MODEL about a target switch, once, at the start of its next turn.
 *
 * A switch (`/provider`, `/credential-name`, `/model`, `/effort`) changes the
 * credential, provider, model or effort of the next request. The user sees a
 * line in the transcript, but the model sees nothing, because the commands
 * are quiet for the model. So a model that is asked "what changed?" can only
 * guess. Alex (11-18): after "/provider anthropic:anthropic-plan-oauth-3"
 * the model answered "Nothing changed in the model, provider or effort".
 *
 * How:
 * - `target.didSwitch` (sent by the CLI host after each switch, payload
 *   `{from, to}`) records the change here. Several switches before the next
 *   turn collapse to one: the first `from` and the last `to`.
 * - `turn.willStart` returns one context line for that turn, and clears it.
 *   The host wraps the line in a `<ma::agent::policy>` tag, like the time line.
 *
 * The line has only names: the credential name that the user gave at login,
 * the provider id, the model id and the effort level. No token, no secret.
 *
 * Process state: one pending change for the process. The CLI host runs one
 * session for each process; the web host sends no `target.didSwitch`.
 *
 * @module plugins/session-info/lib/target-notes
 */

/** One target, as the host sends it. */
export interface NoteTarget {
  credentialName?: string
  providerId?: string
  model: string
  effort?: string
}

let pending: { from: NoteTarget; to: NoteTarget } | null = null

/** Read a target from an event payload. `null` for a value that is not one. */
export function asNoteTarget(v: unknown): NoteTarget | null {
  if (v === null || typeof v !== "object") return null
  const t = v as Record<string, unknown>
  if (typeof t.model !== "string" || t.model.length === 0) return null
  const text = (x: unknown): string | undefined =>
    typeof x === "string" && x.length > 0 ? x : undefined
  const credentialName = text(t.credentialName)
  const providerId = text(t.providerId)
  const effort = text(t.effort)
  return {
    ...(credentialName !== undefined ? { credentialName } : {}),
    ...(providerId !== undefined ? { providerId } : {}),
    model: t.model,
    ...(effort !== undefined ? { effort } : {}),
  }
}

/** Record one switch. Several switches before the next turn keep the first `from`. */
export function recordSwitch(payload: unknown): void {
  if (payload === null || typeof payload !== "object") return
  const p = payload as { from?: unknown; to?: unknown }
  const from = asNoteTarget(p.from)
  const to = asNoteTarget(p.to)
  if (!from || !to) return
  pending = { from: pending?.from ?? from, to }
}

const UNSET: Readonly<Record<string, string>> = {
  credential: "the provider default",
  provider: "none",
  effort: "the model default",
}

/**
 * The context line for the change since the last turn, or `null` when nothing
 * changed (also after a switch there and back). Takes the change: a second
 * call returns `null`.
 */
export function takeSwitchNote(): string | null {
  const change = pending
  pending = null
  if (!change) return null
  const { from, to } = change
  const rows: [string, string | undefined, string | undefined][] = [
    ["credential", from.credentialName, to.credentialName],
    ["provider", from.providerId, to.providerId],
    ["model", from.model, to.model],
    ["effort", from.effort, to.effort],
  ]
  const text = (label: string, value: string | undefined): string =>
    value === undefined ? (UNSET[label] ?? "none") : `"${value}"`
  const changed = rows
    .filter(([, a, b]) => a !== b)
    .map(([label, a, b]) => `${label} ${text(label, a)} -> ${text(label, b)}`)
  if (changed.length === 0) return null
  // Only a new credential or provider changes the account behind the quota.
  const account =
    from.credentialName !== to.credentialName || from.providerId !== to.providerId
      ? " A new credential or provider has its own quota and account."
      : ""
  return (
    `The user switched the target of this session since your last turn: ${changed.join(", ")}. ` +
    `Your requests now use it.${account}`
  )
}

/** Forget a pending change (tests). */
export function resetSwitchNotesForTests(): void {
  pending = null
}
