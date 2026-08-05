/**
 * Per-session bidi stream handles for Cursor AgentService/Run.
 *
 * @module llm/providers/cursor/cursor-bidi-session
 */

import type { CursorBidiWire } from "./connect/bidi-wire.ts"
import type { ConnectEnvelope } from "./connect/stream.ts"
import type { DecodedExecMcpArgs } from "./proto/exec-server-decode.ts"
import type { CursorBidiEnvelopeTranslator } from "./response-stream-bidi.ts"

export type CursorBidiPendingExec = DecodedExecMcpArgs

export type CursorBidiSession = {
  wire: CursorBidiWire
  /** Single shared Connect envelope stream for the wire lifetime (gen1 + gen2). */
  envelopeGen: AsyncGenerator<ConnectEnvelope>
  /** Stateful decoder; survives tool_use pause between agent runs. */
  translator: CursorBidiEnvelopeTranslator
  conversationId: string
  /** Set when we yielded tool_use and await MA tool_result on the next run(). */
  pendingExec: CursorBidiPendingExec | null
}

const sessions = new Map<string, CursorBidiSession>()

/** Read an open bidi session for a host session id. */
export function getCursorBidiSession(sessionId: string): CursorBidiSession | undefined {
  return sessions.get(sessionId)
}

/** Store or replace the bidi session for a host session id. */
export function setCursorBidiSession(sessionId: string, session: CursorBidiSession): void {
  const prev = sessions.get(sessionId)
  if (prev && prev.wire !== session.wire) {
    try {
      prev.wire.close()
    } catch {
      /* ignore */
    }
  }
  sessions.set(sessionId, session)
}

/** Close and remove a bidi session. */
export function clearCursorBidiSession(sessionId: string, expected?: CursorBidiSession): void {
  const prev = sessions.get(sessionId)
  if (!prev || (expected && prev !== expected)) return
  try {
    prev.wire.close()
  } catch {
    /* ignore */
  }
  sessions.delete(sessionId)
}

/** Test-only: reset all sessions. */
export function resetCursorBidiSessionsForTests(): void {
  for (const id of [...sessions.keys()]) clearCursorBidiSession(id)
}
