/**
 * Teams — named groups of peers (like Slack channels). Pure record + parse +
 * the local-membership helpers. No IO here (the catalog read/write shell, when
 * it lands, mirrors `lib/presence.ts`'s atomic writer).
 *
 * ## Model (research-core.md "TEAMS — implementable spec")
 *
 * A team is a {@link TeamRef}: a globally-unique id, a display name, the owning
 * `computerId` (for a purely-local team) or null (for a backend/global team that
 * spans machines), and a `remote` flag. Membership is many-to-many and, for
 * LOCAL teams, lives on the presence record (`PresenceRecord.teams[]`): a team's
 * local members = every reachable peer whose `teams` includes the team id. No
 * central membership file is needed for the local half — the presence-dir scan
 * already has the data. The remote/at-scale half (backend-paginated membership)
 * folds in later through the Transport port; nothing here blocks on it.
 *
 * Team ids use a namespace split: a purely-local team is `local:<slug>`; a
 * backend team is a backend-minted id. This lets a local team be "promoted" to a
 * backend team later without colliding.
 *
 * @module lib/teams
 */

/**
 * A team reference: identity + display metadata. The id is the addressing key
 * (`Send to:"team:<id>"`); everything else is for rendering + routing.
 */
export interface TeamRef {
  /** Globally-unique team id. `local:<slug>` for a local team; backend-minted otherwise. */
  readonly id: string
  /** Human-readable name shown in the TUI. Sanitized on render. */
  readonly name: string
  /**
   * Owning computer for a LOCAL team (the creator's computerId), or null for a
   * backend/global team that spans machines. Drives the `(Remote)` marker on the
   * team header.
   */
  readonly computerId: string | null
  /**
   * True when membership is answered by the backend (scales to 1000s); false for
   * a local team materialized from presence records.
   */
  readonly remote: boolean
}

/**
 * Safe team-id shape: alnum plus `:_-` (the `:` carries the `local:` namespace),
 * 1..128 chars. Same path-traversal-safe class as sids — a team id may become a
 * filename component (the future `intercom/teams/<id>.json` catalog) and is
 * peer-influenceable, so we gate it everywhere before it touches a path.
 */
const SAFE_TEAM_ID = /^[A-Za-z0-9:_-]{1,128}$/

/** Is `id` safe to use as a team id / path component? */
export function isSafeTeamId(id: unknown): id is string {
  return typeof id === "string" && SAFE_TEAM_ID.test(id)
}

/** The `local:` namespace prefix for teams that live on one machine. */
export const LOCAL_TEAM_PREFIX = "local:"

/** Build a local team id from a free-form slug (lowercased, sanitized). */
export function localTeamId(slug: string): string {
  const clean = slug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
  return `${LOCAL_TEAM_PREFIX}${clean || "team"}`
}

/** True when an id is in the local namespace. */
export function isLocalTeamId(id: string): boolean {
  return id.startsWith(LOCAL_TEAM_PREFIX)
}

/**
 * Normalize a user/model-supplied team reference: strip a leading `team:` scope
 * prefix if present, trim. Returns "" when nothing usable. (The `Send` scope
 * `team:<id>` and a bare `<id>` both resolve through here.)
 */
export function normalizeTeamRef(ref: string): string {
  const t = ref.trim()
  const body = t.toLowerCase().startsWith("team:") ? t.slice("team:".length) : t
  return body.trim()
}

/** Coerce an unknown parsed object into a {@link TeamRef}, or null when invalid. */
export function coerceTeamRef(o: unknown): TeamRef | null {
  if (o === null || typeof o !== "object") return null
  const r = o as Record<string, unknown>
  if (!isSafeTeamId(r.id)) return null
  const name =
    typeof r.name === "string" && r.name.trim().length > 0 ? r.name.trim().slice(0, 64) : r.id
  const computerId =
    typeof r.computerId === "string" && r.computerId.length > 0 ? r.computerId : null
  // `remote` defaults to "not local-namespaced": a backend id is remote unless
  // it explicitly says otherwise; a `local:` id is local unless flagged remote.
  const remote =
    typeof r.remote === "boolean" ? r.remote : !isLocalTeamId(r.id)
  return { id: r.id, name, computerId, remote }
}

/**
 * The local members of a team: every presence record (by sid) whose `teams`
 * includes `teamId`. Pure — caller passes the already-read records. This is the
 * local half of membership; remote members fold in via the transport later.
 */
export function localTeamMembers<T extends { readonly teams?: readonly string[]; readonly sid: string }>(
  records: readonly T[],
  teamId: string,
): T[] {
  return records.filter((r) => Array.isArray(r.teams) && r.teams.includes(teamId))
}

/** Every distinct team id seen across a set of presence records. Pure. */
export function teamsFromRecords(
  records: readonly { readonly teams?: readonly string[] }[],
): string[] {
  const seen = new Set<string>()
  for (const r of records) {
    if (!Array.isArray(r.teams)) continue
    for (const id of r.teams) if (isSafeTeamId(id)) seen.add(id)
  }
  return [...seen]
}
