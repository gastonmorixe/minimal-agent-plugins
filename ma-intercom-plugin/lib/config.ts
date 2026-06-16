/**
 * Tunable thresholds, read from the environment with sane defaults. Pure
 * (env in, numbers out) so the liveness classifier and heartbeat stay
 * testable.
 *
 * @module lib/config
 */

/** Heartbeat cadence: how often a session republishes its presence record. */
export const DEFAULT_HEARTBEAT_MS = 5_000

/** A beat younger than this ⇒ unambiguously fresh (trust the self-reported phase). */
export const DEFAULT_FRESH_MS = 20_000

/** A beat older than this ⇒ the writer is no longer beating on schedule. */
export const DEFAULT_STALE_MS = 90_000

/** Resolved threshold bundle. */
export interface Thresholds {
  /** Heartbeat cadence in ms. */
  readonly heartbeatMs: number
  /** Upper bound (ms) of the "fresh" band. */
  readonly freshMs: number
  /** Upper bound (ms) of the "stale-but-maybe-alive" band. */
  readonly staleMs: number
}

function intEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * Resolve thresholds from the environment.
 *
 * - `MINIMAL_AGENT_INTERCOM_HEARTBEAT_MS`
 * - `MINIMAL_AGENT_INTERCOM_FRESH_MS`
 * - `MINIMAL_AGENT_INTERCOM_STALE_MS`
 *
 * `staleMs` is clamped to be at least `freshMs` so the bands can never invert.
 */
export function resolveThresholds(env: NodeJS.ProcessEnv = process.env): Thresholds {
  const heartbeatMs = intEnv(env, "MINIMAL_AGENT_INTERCOM_HEARTBEAT_MS", DEFAULT_HEARTBEAT_MS)
  const freshMs = intEnv(env, "MINIMAL_AGENT_INTERCOM_FRESH_MS", DEFAULT_FRESH_MS)
  const staleRaw = intEnv(env, "MINIMAL_AGENT_INTERCOM_STALE_MS", DEFAULT_STALE_MS)
  return { heartbeatMs, freshMs, staleMs: Math.max(staleRaw, freshMs) }
}

/** True when the user opted this session out of publishing/participating in presence. */
export function presenceDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MINIMAL_AGENT_INTERCOM_NO_PRESENCE === "1"
}
