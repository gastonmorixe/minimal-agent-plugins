/**
 * Carry Cursor's own conversation state across fresh AgentService/Run requests.
 *
 * Every new MA user prompt opens a fresh Run. Before, the plugin sent an empty
 * conversation_state and folded the whole transcript into one user text. On
 * long sessions (about 500k chars, about 160 past tool calls as text) the model
 * copied those records as plain text and made no real tool calls
 * (2026-10-01, research/cursor-fake-toolcall-forensics.md).
 *
 * The official CLI never folds history. The server sends
 * AgentServerMessage.conversation_checkpoint_update (#3) and stores the turn
 * data as KV blobs on the client (set_blob). The next Run sends that checkpoint
 * back as AgentRunRequest.conversation_state (#1) plus only the new user text,
 * and answers the server's get_blob calls from the blob store.
 *
 * This module keeps that state per host session. A state is usable only when
 * the new request extends the exact transcript the state covers with assistant
 * text and one new user text. Anything else (edits, compaction, a failed
 * continuation, tool blocks after the covered prefix) falls back to the fold.
 *
 * Kill switch: `MA_CURSOR_CARRY=0`.
 *
 * @module llm/providers/cursor/conversation-carry
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type { CanonicalMessage } from "./lib/canonical-messages.ts"
import type { CursorBlobStore } from "./proto/kv.ts"

/** Server conversation state for one host session. */
export type CursorCarryState = {
  /** Last AgentServerMessage.conversation_checkpoint_update body (ConversationStateStructure). */
  checkpoint: Uint8Array
  /** Every KV blob the server set on this conversation (hex id to bytes). */
  blobs: CursorBlobStore
  /** Number of canonical messages the checkpoint covers. */
  coveredCount: number
  /** Fingerprint of those messages. */
  fingerprint: string
}

const states = new Map<string, CursorCarryState>()

/** False when `MA_CURSOR_CARRY=0`. */
export function cursorCarryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MA_CURSOR_CARRY?.trim() !== "0"
}

/** Stable fingerprint of a message prefix (roles, block types, ids, text, inputs). */
export function fingerprintMessages(messages: readonly CanonicalMessage[]): string {
  const hasher = new Bun.CryptoHasher("sha256")
  for (const msg of messages) {
    hasher.update(msg.role)
    hasher.update("\u0000")
    hasher.update(JSON.stringify(msg.content))
    hasher.update("\u0001")
  }
  return hasher.digest("hex")
}

/**
 * Directory for persisted carry states (survive a host restart / --resume).
 * `MA_CURSOR_CARRY_DIR` overrides. Empty string disables persistence.
 */
export function cursorCarryDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env.MA_CURSOR_CARRY_DIR
  if (override !== undefined) return override.trim() || undefined
  const home = env.MINIMAL_AGENT_HOME?.trim() || join(homedir(), ".minimal-agent")
  return join(home, "cursor-carry")
}

function carryFile(dir: string, sessionId: string): string {
  // Session ids are host uuids. Keep the file name safe anyway.
  return join(dir, `${sessionId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`)
}

type CarryFileV1 = {
  v: 1
  coveredCount: number
  fingerprint: string
  checkpoint: string
  blobs: Array<[string, string]>
}

function persist(sessionId: string, state: CursorCarryState | undefined): void {
  const dir = cursorCarryDir()
  if (!dir) return
  const path = carryFile(dir, sessionId)
  try {
    if (!state) {
      rmSync(path, { force: true })
      return
    }
    const body: CarryFileV1 = {
      v: 1,
      coveredCount: state.coveredCount,
      fingerprint: state.fingerprint,
      checkpoint: Buffer.from(state.checkpoint).toString("base64"),
      blobs: [...state.blobs].map(([k, b]) => [k, Buffer.from(b).toString("base64")]),
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(path, JSON.stringify(body), { mode: 0o600 })
  } catch {
    // Persistence is best effort. The in-memory state still works.
  }
}

function load(sessionId: string): CursorCarryState | undefined {
  const dir = cursorCarryDir()
  if (!dir) return undefined
  try {
    const raw = JSON.parse(readFileSync(carryFile(dir, sessionId), "utf8")) as CarryFileV1
    if (raw.v !== 1) return undefined
    return {
      coveredCount: raw.coveredCount,
      fingerprint: raw.fingerprint,
      checkpoint: new Uint8Array(Buffer.from(raw.checkpoint, "base64")),
      blobs: new Map(raw.blobs.map(([k, b]) => [k, new Uint8Array(Buffer.from(b, "base64"))])),
    }
  } catch {
    return undefined
  }
}

/** Read the carry state for a host session (memory first, then disk). */
export function getCursorCarryState(sessionId: string): CursorCarryState | undefined {
  const mem = states.get(sessionId)
  if (mem) return mem
  const disk = load(sessionId)
  if (disk) states.set(sessionId, disk)
  return disk
}

/** Store the carry state for a host session (memory and disk). */
export function setCursorCarryState(sessionId: string, state: CursorCarryState): void {
  states.set(sessionId, state)
  persist(sessionId, state)
}

/** Drop the carry state for a host session (memory and disk). */
export function clearCursorCarryState(sessionId: string): void {
  states.delete(sessionId)
  persist(sessionId, undefined)
}

/** Test-only: drop every carry state. */
export function resetCursorCarryStatesForTests(): void {
  states.clear()
}

/** A usable carry for one request: the checkpoint plus the new user text. */
export type CursorCarryPlan = {
  state: CursorCarryState
  userText: string
}

/**
 * Decide whether a request can continue from the stored state.
 *
 * Usable when the request starts with the covered messages (same fingerprint)
 * and the rest is assistant text (the reply the server already has) followed
 * by user text only. Tool blocks, images, or thinking signatures after the
 * covered prefix mean the server state is missing them, so return undefined.
 */
export function planCursorCarry(
  state: CursorCarryState | undefined,
  messages: readonly CanonicalMessage[],
): CursorCarryPlan | undefined {
  if (!state) return undefined
  if (messages.length <= state.coveredCount) return undefined
  if (fingerprintMessages(messages.slice(0, state.coveredCount)) !== state.fingerprint) {
    return undefined
  }
  const rest = messages.slice(state.coveredCount)
  const last = rest.at(-1)
  if (!last || last.role !== "user") return undefined
  const texts: string[] = []
  for (const [i, msg] of rest.entries()) {
    const isLast = i === rest.length - 1
    for (const block of msg.content) {
      if (msg.role === "assistant") {
        // The server already holds its own reply. Only plain text and thinking may sit here.
        if (
          block.type !== "text" &&
          block.type !== "thinking" &&
          block.type !== "redacted_thinking"
        ) {
          return undefined
        }
        continue
      }
      if (block.type !== "text") return undefined
      if (!isLast) return undefined
      if (block.text.trim()) texts.push(block.text.trim())
    }
  }
  if (texts.length === 0) return undefined
  return { state, userText: texts.join("\n\n") }
}
