/**
 * Session identity helpers: the short display handle, the host name, and
 * resolving "who am I" from a handler context. Pure (or thin os reads).
 *
 * @module lib/identity
 */

import { hostname } from "node:os"

import type { AgentContext } from "./host-types.ts"

/**
 * The set of characters a session id may contain to be usable as a filename
 * component. Session ids are UUIDs (hex + dashes); we allow the slightly wider
 * `[A-Za-z0-9_-]` so test/fixture sids work too, but nothing that could escape
 * a directory (`/`, `.`, `\`, null, etc.).
 */
const SAFE_SID_RE = /^[A-Za-z0-9_-]{1,128}$/

/**
 * Is `sid` safe to interpolate into a filesystem path?
 *
 * Presence/envelope records are written by OTHER processes (and the foreign
 * sub-agents feed), so a `sid` field is attacker-influenceable. A value like
 * `"../../../../etc/cron.d/x"` would, unchecked, make `join(dir, sid + ".json")`
 * escape the intercom directory and turn our writers into an arbitrary-file
 * write primitive. Every path builder and every record parser gates on this.
 */
export function isSafeSid(sid: unknown): sid is string {
  return typeof sid === "string" && SAFE_SID_RE.test(sid)
}

/**
 * Length of the short display handle: the leading hex group of a UUID (the 8
 * chars before the first dash). This matches the rest of minimal-agent, where
 * the quota footer, session-history, and file-lock all show a session as its
 * first 8 chars (e.g. `bd94a4be`). Keeping intercom identical means the handle
 * a user reads in the footer is the same one they pass to `Send`/`Peers`.
 */
export const SHORT_ID_LEN = 8

/**
 * The short display handle for a session: the first 8 chars of its uuid (the
 * leading hex group). This is what humans and the model use to refer to a peer
 * ("send to bd94a4be"); it is not an address key on its own (we resolve it
 * against the live roster).
 */
export function shortId(sid: string): string {
  return sid.slice(0, SHORT_ID_LEN)
}

/** This machine's host name (best-effort; empty string on failure). */
export function thisHost(): string {
  try {
    return hostname()
  } catch {
    return ""
  }
}

/**
 * Normalize a user/model-supplied peer reference to a comparable token.
 * Accepts a full sid, a short id, or an at-mention. Lowercased, a leading
 * at-sign is stripped, then trimmed. Empty string when nothing usable.
 */
export function normalizePeerRef(ref: string): string {
  return ref.trim().replace(/^@+/, "").toLowerCase()
}

/**
 * Does a candidate session (by full sid) match a normalized peer reference?
 * True when the ref equals the full sid or is a prefix of it (so a short id,
 * or any unambiguous prefix, resolves). Caller is responsible for ambiguity
 * (multiple matches) detection.
 */
export function sidMatchesRef(sid: string, normalizedRef: string): boolean {
  if (normalizedRef.length === 0) return false
  const lower = sid.toLowerCase()
  return lower === normalizedRef || lower.startsWith(normalizedRef)
}

/**
 * My own identity for this session, derived from the boot {@link AgentContext}
 * plus ambient facts. Returns `null` when no session id is plumbed through
 * (rare; the plugin then no-ops rather than guessing).
 */
export interface SelfIdentity {
  readonly sid: string
  readonly short: string
  readonly pid: number
  readonly host: string
  readonly model: string
  readonly agentVersion: string
}

/** Build {@link SelfIdentity} from a handler context's agent block + cwd. */
export function selfIdentity(agent: AgentContext | undefined): SelfIdentity | null {
  const sid = agent?.sessionId?.trim()
  if (!sid) return null
  return {
    sid,
    short: shortId(sid),
    pid: agent?.pid ?? process.pid,
    host: thisHost(),
    model: agent?.model ?? "",
    agentVersion: agent?.version ?? "",
  }
}
