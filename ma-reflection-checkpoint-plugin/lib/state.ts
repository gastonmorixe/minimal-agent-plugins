/**
 * The per-session state of the plugin: the number of checkpoints that an ack
 * silenced, and the facts that find the start of a new run.
 *
 * Core keeps no reflection state. The plugin keeps one entry for each session
 * id in this process, so two sessions of one host do not share a count.
 *
 * Run rule (same as the old core loop, which set the count to 0 at the start
 * of each run): a new run resets the silence count, but an ack in the first
 * response of the new run stays. An ack in the last response of a run (a
 * text-only response, with no tool round after it) does not go into the next
 * run. The plugin uses two signals:
 *
 * - `turn.didEnd` / `turn.aborted` (the end of a run): {@link endRun} deletes
 *   the entry of the session. The next run starts from the initial state.
 * - Fallback for a host that sends no turn-end event: the `round` of
 *   `tool.didBatch` starts at 1 again in a new run. When the round goes down,
 *   and no ack arrived since the last batch, the plugin clears the count.
 *
 * Size: {@link endRun} removes the entry at each run end. Also, the map keeps
 * at most {@link MAX_SESSIONS} entries. When it is full, the entry that was
 * not used for the longest time goes out (LRU).
 *
 * @module lib/state
 */

/** The state of one session. */
export interface SessionState {
  /** The number of due checkpoints to skip. */
  silenceRemaining: number
  /** The round of the last `tool.didBatch`, 0 before the first. */
  lastRound: number
  /** True when an ack arrived after the last `tool.didBatch`. */
  ackSinceBatch: boolean
}

/** The maximum number of session entries in the map (LRU cap). */
export const MAX_SESSIONS = 256

const sessions = new Map<string, SessionState>()

/** The session key: the agent session id, else the env id, else `"default"`. */
export function sessionKey(
  agent: { sessionId?: string } | undefined,
  env: Record<string, string | undefined>,
): string {
  return agent?.sessionId?.trim() || env.MINIMAL_AGENT_SESSION_ID?.trim() || "default"
}

/**
 * The state of `key`. Makes a new entry when there is none. Each call marks
 * the entry as the newest. Above {@link MAX_SESSIONS} entries, the oldest
 * entry goes out.
 */
export function stateFor(key: string): SessionState {
  let s = sessions.get(key)
  if (s) {
    // Move the entry to the end of the insertion order (the newest).
    sessions.delete(key)
  } else {
    s = { silenceRemaining: 0, lastRound: 0, ackSinceBatch: false }
  }
  sessions.set(key, s)
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value
    if (oldest === undefined) break
    sessions.delete(oldest)
  }
  return s
}

/** The end of a run: delete the entry of `key` (the count goes to 0). */
export function endRun(key: string): void {
  sessions.delete(key)
}

/** True when `key` has an entry. For tests. */
export function hasState(key: string): boolean {
  return sessions.has(key)
}

/** The number of session entries. For tests. */
export function sessionCount(): number {
  return sessions.size
}

/** Clear all sessions. For tests. */
export function resetAllState(): void {
  sessions.clear()
}
