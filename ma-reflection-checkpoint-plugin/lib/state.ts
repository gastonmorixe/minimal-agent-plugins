/**
 * The per-session state of the plugin: the number of checkpoints that an ack
 * silenced, and the facts that find the start of a new run.
 *
 * Core keeps no reflection state. The plugin keeps one entry for each session
 * id in this process, so two sessions of one host do not share a count.
 *
 * Run rule (same as the old core loop): a new run resets the silence count,
 * but an ack in the first response of the new run stays. The `round` of
 * `tool.didBatch` starts at 1 again in a new run. So when the round goes
 * down, and no ack arrived since the last batch, the plugin clears the count.
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

const sessions = new Map<string, SessionState>()

/** The session key: the agent session id, else the env id, else `"default"`. */
export function sessionKey(
  agent: { sessionId?: string } | undefined,
  env: Record<string, string | undefined>,
): string {
  return agent?.sessionId?.trim() || env.MINIMAL_AGENT_SESSION_ID?.trim() || "default"
}

/** The state of `key`. Makes a new entry when there is none. */
export function stateFor(key: string): SessionState {
  let s = sessions.get(key)
  if (!s) {
    s = { silenceRemaining: 0, lastRound: 0, ackSinceBatch: false }
    sessions.set(key, s)
  }
  return s
}

/** Clear all sessions. For tests. */
export function resetAllState(): void {
  sessions.clear()
}
