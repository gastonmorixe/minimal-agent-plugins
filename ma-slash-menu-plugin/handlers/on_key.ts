/**
 * `editor.key` hook handler — slash-menu's input intercept.
 *
 * Broadcast-sync. Runs in the editor's keystroke pump, BEFORE the
 * default key handling. Responsibilities:
 *
 *   1. Map the editor's canonical key name to the FSM's `KeyName`.
 *   2. Run one FSM transition.
 *   3. Apply effects:
 *      - `set-buffer` → write `payload.result.buffer` (same-tick mutation
 *        — the editor reads it right after we return).
 *      - `halt-key` → set `payload.result.halt = true`.
 *      - `paint-footer` / `clear-footer` → emit on
 *        `editor.footer.set` via `ctx.emit`. The host's listener calls
 *        `EditorController.setFooterLines()` on the next repaint.
 *
 * # Why the menu only opens for keys we know
 *
 * The FSM's `closed` state is conservative — keys it doesn't recognize
 * pass through. The slash-menu opens via the `editor.buffer.changed`
 * handler (see sibling file), NEVER via `editor.key`. Detecting the
 * activation char (`/` or `$`) here would mean halting it on insert
 * which the user doesn't want — they want to SEE the sigil in the
 * prompt as visual feedback that the menu is open.
 *
 * @module ma-slash-menu/handlers/on_key
 */

import type { HookHandlerContext } from "../lib/host-types.ts"
import { type Effect, type KeyName, offsetToRowCol, transition } from "../lib/overlay.ts"
import { configureSgr } from "../lib/palette.ts"
import { getFsmState, getItems, refreshItems, setFsmState } from "../lib/state.ts"

// ---------------------------------------------------------------------------
// Payload guard (keep host types decoupled)
// ---------------------------------------------------------------------------

interface EditorKeyPayload {
  key: string
  buffer: string
  cursor: {
    row: number
    col: number
    visualRow: number
    rowsInLogicalLine: number
    totalLines: number
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
  configureSgr(ctx.env.MINIMAL_AGENT_PALETTE)

  if (!isPayload(payload)) return
  if (payload.key === "/" || payload.key === "$") {
    const cursor = absoluteCursor(payload.buffer, payload.cursor)
    setFsmState(
      transition(
        getFsmState(),
        { kind: "slash-typed", trigger: payload.key, cursor },
        transitionCtx(ctx),
      ).state,
    )
    return
  }

  const key = toFsmKey(payload.key)
  if (key === null) return

  const state = getFsmState()
  if (state.kind === "closed" || state.kind === "armed") return

  refreshItems(ctx.listCommands?.())

  const result = transition(
    state,
    { kind: "key", name: key },
    {
      ...transitionCtx(ctx),
      bufferText: payload.buffer,
    },
  )
  setFsmState(result.state)
  applyEffects(result.effects, payload, ctx)
}

// ---------------------------------------------------------------------------
// Effect applier — imperative shell
// ---------------------------------------------------------------------------

function applyEffects(effects: Effect[], payload: EditorKeyPayload, ctx: HookHandlerContext): void {
  for (const eff of effects) {
    switch (eff.kind) {
      case "halt-key":
        payload.result.halt = true
        break
      case "set-buffer": {
        // Same-tick: the editor reads `result.buffer` right after the hook
        // listener returns. Preserve the logical caret for mid-buffer and
        // multiline completions, like intercom mentions.
        payload.result.buffer = eff.text
        if (typeof eff.cursor === "number") {
          const cursor = offsetToRowCol(eff.text, eff.cursor)
          payload.result.cursor = cursor
          ctx.emit("editor.buffer.set", { text: eff.text, cursor })
        }
        break
      }
      case "paint-footer":
        ctx.emit("editor.footer.set", { lines: eff.lines })
        break
      case "clear-footer":
        ctx.emit("editor.footer.set", { lines: [] })
        break
      case "run-command":
        // Dispatch the picked command through the host registry directly.
        // No buffer write, no submit — the host runs `/slug` and the command
        // (e.g. /config) paints its own overlay. One Enter, no scrollback leak.
        ctx.emit("command.run", { line: `/${eff.slug}` })
        break
    }
  }
}

function transitionCtx(ctx: HookHandlerContext) {
  refreshItems(ctx.listCommands?.())
  return {
    allItems: getItems(),
    cols: terminalCols(),
    contextWindow: resolveContextWindow(),
  }
}

function absoluteCursor(text: string, cursor: { row: number; col: number }): number {
  if (cursor.row <= 0) return Math.max(0, Math.min(cursor.col, text.length))
  const lines = text.split("\n")
  let offset = 0
  for (let row = 0; row < cursor.row && row < lines.length; row++) {
    offset += (lines[row]?.length ?? 0) + 1
  }
  return Math.max(0, Math.min(offset + cursor.col, text.length))
}

// ---------------------------------------------------------------------------
// Environmental probes
// ---------------------------------------------------------------------------

function terminalCols(): number {
  const c = (process.stdout as unknown as { columns?: number }).columns
  if (typeof c === "number" && c > 0) return c
  return 100
}

function resolveContextWindow(): number | undefined {
  const model = process.env.MINIMAL_AGENT_MODEL ?? ""
  if (!model) return undefined
  if (model.includes("[1m]")) return 1_000_000
  return 200_000
}

export default handler
