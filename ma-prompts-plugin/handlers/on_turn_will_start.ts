/**
 * `turn.willStart` chain handler: expand `&name` to the prompt body on the
 * model path only.
 *
 * Chain shape. Payload is `{text: string}` (the raw buffer text the user
 * typed). Returning `{payload: {text}}` rewrites the model-facing content
 * without changing scrollback. Returning void is pass-through.
 *
 * Mirrors `ma-intercom-plugin/handlers/on_turn_will_start.ts`.
 *
 * @module handlers/on_turn_will_start
 */

import { loadPromptsConfig } from "../lib/config.ts"
import type { HookHandlerContext } from "../lib/host-types.ts"
import { rewritePrompts } from "../lib/rewrite.ts"
import { defaultDeps, loadPrompts } from "../lib/store.ts"

interface TurnWillStartPayload {
  text: string
}

function isPayload(v: unknown): v is TurnWillStartPayload {
  if (!v || typeof v !== "object") return false
  return typeof (v as Record<string, unknown>).text === "string"
}

const handler = (
  payload: unknown,
  ctx: HookHandlerContext,
): { payload: TurnWillStartPayload } | void => {
  if (!isPayload(payload)) return

  const config = loadPromptsConfig()
  if (!config.enabled) return

  const spec = config.sigil
  if (!payload.text.includes(spec)) return

  const deps = defaultDeps(ctx.env, ctx.cwd, config.projectScope, {
    maxBodyBytes: config.maxBodyBytes,
    maxPrompts: config.maxPrompts,
  })
  const { prompts } = loadPrompts(deps)
  if (prompts.length === 0) return

  const rewritten = rewritePrompts(payload.text, prompts)
  if (rewritten === payload.text) return
  return { payload: { text: rewritten } }
}

export default handler
