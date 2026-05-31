/**
 * `editor.buffer.changed` event handler — slash-menu's activation +
 * filter trigger.
 *
 * Broadcast-async. Fires after every successful buffer mutation
 * (microtask-deferred from the keystroke pump, so it's safe to be
 * slower than the key path).
 *
 * Responsibilities:
 *
 *   1. Feed the FSM a `{kind: "buffer-changed", text}` event.
 *   2. Apply effects via `ctx.emit("editor.footer.set", ...)`.
 *
 * The FSM decides whether to open / re-filter / close the menu based
 * on whether `text` matches the trigger regex (`^[/$][a-zA-Z0-9_-]*$`).
 *
 * @module ma-slash-menu/handlers/on_buffer_changed
 */

import type { EventHandlerContext } from "../lib/host-types.ts"
import { type Effect, transition } from "../lib/overlay.ts"
import { getFsmState, getItems, refreshItems, setFsmState } from "../lib/state.ts"

interface BufferChangedPayload {
  text: string
  cursor: { row: number; col: number }
}

function isPayload(v: unknown): v is BufferChangedPayload {
  if (!v || typeof v !== "object") return false
  const o = v as Record<string, unknown>
  return typeof o.text === "string"
}

const handler = async (ctx: EventHandlerContext): Promise<void> => {
  if (!isPayload(ctx.payload)) return

  // Refresh the action rows from the host's live command registry so the
  // menu lists exactly the commands that actually dispatch (+ skills).
  refreshItems(ctx.listCommands?.())

  const state = getFsmState()
  const result = transition(
    state,
    { kind: "buffer-changed", text: ctx.payload.text },
    {
      allItems: getItems(),
      cols: terminalCols(),
      contextWindow: resolveContextWindow(),
    },
  )
  setFsmState(result.state)
  applyEffects(result.effects, ctx)
}

function applyEffects(effects: Effect[], ctx: EventHandlerContext): void {
  for (const eff of effects) {
    switch (eff.kind) {
      case "paint-footer":
        ctx.emit("editor.footer.set", { lines: eff.lines })
        break
      case "clear-footer":
        ctx.emit("editor.footer.set", { lines: [] })
        break
      case "set-buffer":
      case "halt-key":
      case "run-command":
        // These shouldn't surface on the buffer-changed path; the FSM
        // only emits them in response to key events. Silently ignore
        // so the contract is one-directional: keys cause buffer/halt/
        // run-command effects, buffer-changes cause footer effects.
        break
    }
  }
}

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
