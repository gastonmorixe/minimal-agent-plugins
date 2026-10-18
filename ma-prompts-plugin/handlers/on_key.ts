/**
 * `editor.key` hook handler: the `&` menu's input intercept.
 *
 * Runs in the editor's keystroke pump BEFORE default key handling. It maps
 * the editor's key name to the kit FSM's `KeyName`, runs one transition, and
 * applies the effects.
 *
 * # Focus discipline
 *
 * The menu is inert while closed: every key returns without halting, so the
 * input box keeps its default behavior. Alt+Enter in particular falls through
 * to the editor's newline insertion when no menu is open. This is the "no
 * conflict with the input box" guarantee.
 *
 * `&` itself is NOT handled here. The menu arms via `editor.buffer.changed`
 * (see the sibling handler), so the user sees the sigil in the prompt as
 * visual feedback. Same approach the intercom plugin uses for `@`.
 *
 * @module handlers/on_key
 */

import { type KeyName, offsetToRowCol, transition } from "ma-autocomplete-kit"

import { loadPromptsConfig } from "../lib/config.ts"
import type { HookHandlerContext } from "../lib/host-types.ts"
import { getFsmState, getItems, providerFor, setFsmState, specFor } from "../lib/menu.ts"
import { defaultDeps } from "../lib/store.ts"

interface EditorKeyPayload {
  key: string
  buffer: string
  cursor: { row: number; col: number }
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

/** Map the editor's key name to the kit FSM's key set. */
export function toFsmKey(key: string): KeyName | null {
  switch (key) {
    case "Tab":
    case "Enter":
    case "Escape":
    case "ArrowUp":
    case "ArrowDown":
      return key
    case "Alt+Enter":
      return "Alt+Enter"
    default:
      return null
  }
}

const handler = async (payload: unknown, ctx: HookHandlerContext): Promise<void> => {
  if (!isPayload(payload)) return

  const config = loadPromptsConfig()
  if (!config.enabled) return

  const key = toFsmKey(payload.key)
  if (key === null) return

  const state = getFsmState()
  // Closed menu: do not halt anything, including Alt+Enter.
  if (state.kind === "closed") return

  const deps = defaultDeps(ctx.env, ctx.cwd, config.projectScope, {
    maxBodyBytes: config.maxBodyBytes,
    maxPrompts: config.maxPrompts,
  })
  const items = await getItems(providerFor(deps))
  const result = transition(
    state,
    { kind: "key", name: key },
    {
      spec: specFor(config),
      allItems: items,
      cols: terminalCols(),
      contextWindow: resolveContextWindow(),
      bufferText: payload.buffer,
    },
  )
  setFsmState(result.state)
  applyEffects(result.effects, payload, ctx)
}

/** Imperative shell: apply FSM effects to the editor. */
export function applyEffects(
  effects: ReadonlyArray<{ kind: string; text?: string; cursor?: number; lines?: string[] }>,
  payload: EditorKeyPayload,
  ctx: HookHandlerContext,
): void {
  for (const eff of effects) {
    switch (eff.kind) {
      case "halt-key":
        payload.result.halt = true
        break
      case "set-buffer": {
        payload.result.buffer = eff.text ?? payload.buffer
        if (typeof eff.cursor === "number") {
          const cursor = offsetToRowCol(eff.text ?? "", eff.cursor)
          payload.result.cursor = cursor
          ctx.emit("editor.buffer.set", { text: eff.text, cursor })
        }
        break
      }
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
