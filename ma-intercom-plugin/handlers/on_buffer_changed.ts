/**
 * `editor.buffer.changed` event handler — at-mention activation + filter +
 * buffer style spans.
 *
 * Broadcast-async. Fires after every successful buffer mutation.
 *
 * Responsibilities:
 *   1. Refresh the peer roster cache from disk (cheap directory scan).
 *   2. Feed the FSM a `{kind: "buffer-changed", text, cursor}` event.
 *   3. Apply footer effects via `editor.footer.set`.
 *   4. Emit `editor.buffer.styles` for matching at-tokens (core paints them).
 *
 */

import type { EventHandlerContext } from "../lib/host-types.ts"
import { type Effect, transition } from "../lib/mention/overlay.ts"
import { configureSgr } from "../lib/mention/palette.ts"
import { getFsmState, getPeers, setFsmState, setPeersFromRoster } from "../lib/mention/state.ts"
import { mentionStyleSpans } from "../lib/mention/styles.ts"
import { loadRoster, serviceDepsFromAgent } from "../lib/service.ts"

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
  configureSgr(ctx.env?.MINIMAL_AGENT_PALETTE)

  if (!isPayload(ctx.payload)) return

  // Refresh peer cache from the live roster (exclude self). Best-effort:
  // if no session identity is plumbed, keep the previous cache.
  refreshPeers(ctx)

  const text = ctx.payload.text
  // Cursor: prefer col on the current row. Mentions treat the buffer as a
  // flat string; when multi-line, approximate with col only if row is 0,
  // otherwise rebuild an absolute offset from prior newlines if needed.
  // Host currently sends single-line editor text for the prompt, so col
  // is the absolute offset.
  const cursor = absoluteCursor(text, ctx.payload.cursor)

  const state = getFsmState()
  const result = transition(
    state,
    { kind: "buffer-changed", text, cursor },
    {
      peers: getPeers(),
      cols: terminalCols(),
      bufferText: text,
    },
  )
  setFsmState(result.state)
  applyEffects(result.effects, ctx)

  // Always recompute buffer styles for matching at-tokens (independent of
  // whether the autocomplete menu is open).
  const spans = mentionStyleSpans(text, getPeers())
  ctx.emit("editor.buffer.styles", { spans })
}

function refreshPeers(ctx: EventHandlerContext): void {
  try {
    const deps = serviceDepsFromAgent(ctx.agent, process.env, ctx.host)
    if (!deps) return
    const rows = loadRoster(deps, { excludeSelf: true })
    setPeersFromRoster(rows)
  } catch {
    // Keep previous cache on any roster failure.
  }
}

function absoluteCursor(text: string, cursor: { row: number; col: number } | undefined): number {
  if (!cursor) return text.length
  if (cursor.row <= 0) return Math.max(0, Math.min(cursor.col, text.length))
  // Multi-line: sum lengths of prior lines + col.
  const lines = text.split("\n")
  let offset = 0
  for (let i = 0; i < cursor.row && i < lines.length; i++) {
    offset += lines[i]!.length + 1 // +1 for the newline
  }
  return Math.max(0, Math.min(offset + cursor.col, text.length))
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
      case "set-styles":
        ctx.emit("editor.buffer.styles", { spans: eff.spans })
        break
      case "set-buffer":
      case "halt-key":
        // Key-path only.
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
