/**
 * `editor.buffer.changed` event handler: the `&` menu's activation + filter.
 *
 * Fires after every successful buffer mutation (microtask-deferred from the
 * keystroke pump). It feeds the FSM a `buffer-changed` event, which decides
 * whether to open, re-filter, or close the menu based on the `&` token regex.
 *
 * This is where the menu arms, NOT `editor.key`. The user sees the `&` they
 * typed as visual feedback, and the menu opens from the resulting buffer.
 *
 * @module handlers/on_buffer_changed
 */

import { sigilStyleSpans, transition } from "../../ma-autocomplete-kit/src/index.ts"
import { loadPromptsConfig } from "../lib/config.ts"
import type { EventHandlerContext } from "../lib/host-types.ts"
import { getFsmState, getItems, providerFor, setFsmState, specFor } from "../lib/menu.ts"
import { defaultDeps } from "../lib/store.ts"

interface BufferChangedPayload {
  text: string
  cursor: { row: number; col: number }
}

function isPayload(v: unknown): v is BufferChangedPayload {
  if (!v || typeof v !== "object") return false
  return typeof (v as Record<string, unknown>).text === "string"
}

const handler = async (ctx: EventHandlerContext): Promise<void> => {
  if (!isPayload(ctx.payload)) return

  const config = loadPromptsConfig()
  if (!config.enabled) return

  const spec = specFor(config)
  const text = ctx.payload.text
  const state = getFsmState()
  // Fast path: nothing that could arm or refresh the menu. Only skip while the
  // menu is closed. When it is open, the sigil may have just been deleted, and
  // the transition below is what closes the menu, so it must always run.
  if (state.kind === "closed" && !text.includes(spec.sigil)) return

  const deps = defaultDeps(ctx.env, ctx.cwd, config.projectScope, {
    maxBodyBytes: config.maxBodyBytes,
    maxPrompts: config.maxPrompts,
  })
  const items = await getItems(providerFor(deps))

  const result = transition(
    state,
    {
      kind: "buffer-changed",
      text,
      cursor: absoluteCursor(text, ctx.payload.cursor),
    },
    {
      spec,
      allItems: items,
      cols: terminalCols(),
      contextWindow: resolveContextWindow(),
      bufferText: text,
    },
  )
  setFsmState(result.state)
  applyEffects(result.effects, ctx)

  // Paint resolved tokens in the buffer.
  ctx.emit("editor.buffer.styles", {
    source: "prompts",
    spans: sigilStyleSpans(text, items, spec),
  })
}

/** Buffer-changes only produce footer effects; keys own buffer/halt. */
export function applyEffects(
  effects: ReadonlyArray<{ kind: string; lines?: string[] }>,
  ctx: EventHandlerContext,
): void {
  for (const eff of effects) {
    switch (eff.kind) {
      case "paint-footer":
        ctx.emit("editor.footer.set", { lines: eff.lines ?? [] })
        break
      case "clear-footer":
        ctx.emit("editor.footer.set", { lines: [] })
        break
      default:
        break
    }
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
