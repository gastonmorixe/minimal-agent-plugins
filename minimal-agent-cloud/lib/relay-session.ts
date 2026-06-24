/**
 * Per-session relay state — the glue that makes the write-path run in a LIVE
 * session: one {@link PendingRunner} + {@link PendingInjector} per attached sid,
 * held across live-area ticks, with the injector's stamp wired into the uploader.
 *
 * ## Why module-level state
 *
 * The plugin's handlers are stateless functions the host calls per tick/turn. The
 * relay needs to persist a runner (its open subscription + claim/inject wiring)
 * for the session's lifetime. We key it by sid in a module-level map: the first
 * tick for a logged-in, cloud-enabled session constructs + starts the runner; the
 * uploader reads the same session's injector to stamp `pendingId` onto outgoing
 * user records. One process = one CLI = a small, bounded map.
 *
 * Everything is gated: no token / cloud disabled ⇒ {@link ensureRelay} is a
 * no-op and {@link injectorFor} returns null (the uploader stamps nothing). So a
 * non-cloud session pays nothing and the relay never touches its turn loop.
 *
 * @module lib/relay-session
 */

import { currentFlags, isEnabled } from "./feature-flags.ts"
import { cloudConfig } from "./login.ts"
import { createPendingGateway } from "./pending-gateway.ts"
import { PendingInjector } from "./pending-inject.ts"
import { PendingRunner } from "./pending-runner.ts"
import { loadAuth } from "./token-store.ts"

/** One session's live relay: its injector (for upload-stamp) + runner (drain). */
interface RelayState {
  readonly injector: PendingInjector
  readonly runner: PendingRunner
}

/** sid → relay state. Module-level, bounded by the number of attached sessions. */
const SESSIONS = new Map<string, RelayState>()

/** Derive the ws:// GraphQL URL from the http(s) graphql URL. */
function wsUrl(graphqlUrl: string): string {
  return graphqlUrl.replace(/^http/, "ws")
}

/**
 * Ensure the relay is running for `sid`, constructing + starting it on first
 * call. Gated: returns without doing anything when not logged in or cloud is
 * disabled. Idempotent (PendingRunner.start is). `emit` is the host's
 * prompt.inject channel.
 *
 * Best-effort + never throws: a start failure is swallowed (the next tick
 * retries). Returns the relay state when active, else null.
 */
export function ensureRelay(
  sid: string,
  emit: (channel: string, payload?: unknown) => void,
  env: NodeJS.ProcessEnv = process.env,
): RelayState | null {
  const auth = loadAuth(env)
  if (!auth) return null
  const flags = currentFlags(env)
  if (!isEnabled(flags, "cloudEnabled") || !isEnabled(flags, "teleportEnabled")) return null

  const existing = SESSIONS.get(sid)
  if (existing) return existing

  const cfg = cloudConfig(env)
  const injector = new PendingInjector(emit)
  const runner = new PendingRunner({
    sid,
    wsUrl: wsUrl(cfg.graphqlUrl),
    bearer: auth.accessToken,
    gateway: createPendingGateway({ graphqlUrl: cfg.graphqlUrl, env }),
    injector,
  })
  const state: RelayState = { injector, runner }
  SESSIONS.set(sid, state)
  // Fire-and-forget start (drain backlog + open subscription). Never throws.
  void runner.start()
  return state
}

/** The injector for a session's outgoing-record stamp, or null when no relay. */
export function injectorFor(sid: string): PendingInjector | null {
  return SESSIONS.get(sid)?.injector ?? null
}

/** Stop + drop a session's relay (detach / shutdown). */
export function stopRelay(sid: string): void {
  const s = SESSIONS.get(sid)
  if (s) {
    s.runner.stop()
    SESSIONS.delete(sid)
  }
}

/** Test-only: clear all relay state. */
export function __resetRelaysForTests(): void {
  for (const s of SESSIONS.values()) s.runner.stop()
  SESSIONS.clear()
}
