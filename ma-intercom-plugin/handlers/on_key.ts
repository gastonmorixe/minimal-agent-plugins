/**
 * `editor.key` hook handler — at-mention peer autocomplete input intercept.
 *
 * Broadcast-sync. Runs in the editor's keystroke pump, BEFORE default key
 * handling. Priority ~65 (below slash-menu 70 so `/` wins at col 0; `@`
 * mid-line is free).
 *
 * Responsibilities:
 *   1. Map the editor's canonical key name to the FSM's `KeyName`.
 *   2. Run one FSM transition.
 *   3. Apply effects (halt / set-buffer / footer / styles).
 *
 * The menu opens via `editor.buffer.changed`, never via `editor.key` — so
 * the user sees the `@` sigil as visual feedback.
 *
 */

import type { HookHandlerContext } from "../lib/host-types.ts"
import { type Effect, type KeyName, transition } from "../lib/mention/overlay.ts"
import { configureSgr } from "../lib/mention/palette.ts"
import { getFsmState, getPeers, setFsmState } from "../lib/mention/state.ts"

// ---------------------------------------------------------------------------
// Payload guard
// ---------------------------------------------------------------------------

interface EditorKeyPayload {
  key: string
  buffer: string
  cursor: {
    row: number
    col: number
    visualRow?: number
    rowsInLogicalLine?: number
    totalLines?: number
  }
  result: {
    halt?: boolean
    buffer?: string
    cursor?: { row: number; col: number }
  }
}

function isPayload(v: unknown): v is EditorKeyPayload {
  if (!v || typeof v !== "object") return false
  const o = v as Record<string, unknown>
  return (
    typeof o.key === "string" &&
    typeof o.buffer === "string" &&
    typeof o.result === "object" &&
    o.result !== null
  )
}

function toFsmKey(key: string): KeyName | null {
  switch (key) {
    case "Tab":
    case "Enter":
    case "Escape":
    case "ArrowUp":
    case "ArrowDown":
      return key
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const handler = (payload: unknown, ctx: HookHandlerContext): void => {
  configureSgr(ctx.env?.MINIMAL_AGENT_PALETTE)

  if (!isPayload(payload)) return
  const key = toFsmKey(payload.key)
  if (key === null) return

  const state = getFsmState()
  if (state.kind === "closed") return

  const result = transition(
    state,
    { kind: "key", name: key },
    {
      peers: getPeers(),
      cols: terminalCols(),
      bufferText: payload.buffer,
    },
  )
  setFsmState(result.state)
  applyEffects(result.effects, payload, ctx)
}

// ---------------------------------------------------------------------------
// Effect applier
// ---------------------------------------------------------------------------

function applyEffects(effects: Effect[], payload: EditorKeyPayload, ctx: HookHandlerContext): void {
  for (const eff of effects) {
    switch (eff.kind) {
      case "halt-key":
        payload.result.halt = true
        break
      case "set-buffer":
        // Same-tick: editor reads result.buffer right after the hook returns.
        payload.result.buffer = eff.text
        if (typeof eff.cursor === "number") {
          // Cursor is a flat offset into the (single-line) buffer for mentions.
          payload.result.cursor = { row: 0, col: eff.cursor }
        }
        // Also fan out via the bus for hosts that listen async.
        ctx.emit?.("editor.buffer.set", {
          text: eff.text,
          ...(typeof eff.cursor === "number" ? { cursor: { row: 0, col: eff.cursor } } : {}),
        })
        break
      case "paint-footer":
        ctx.emit?.("editor.footer.set", { lines: eff.lines })
        break
      case "clear-footer":
        ctx.emit?.("editor.footer.set", { lines: [] })
        break
      case "set-styles":
        ctx.emit?.("editor.buffer.styles", { spans: eff.spans })
        break
    }
  }
}

function terminalCols(): number {
  const c = (process.stdout as unknown as { columns?: number }).columns
  if (typeof c === "number" && c > 0) return c
  return 100
}

export default handler
