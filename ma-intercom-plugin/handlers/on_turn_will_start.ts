/**
 * `turn.willStart` chain handler — rewrite resolved at-mentions to peer XML
 * on the model path only.
 *
 * Chain shape. Payload is `{text: string}` (raw buffer text the user typed).
 * Returning `{payload: {text}}` rewrites model-facing content without changing
 * scrollback commit lines. Returning void / undefined is pass-through.
 *
 * Pure rewrite lives in `lib/mention/rewrite.ts`. This handler only:
 *   1. Refreshes the peer roster.
 *   2. Calls `rewriteMentions`.
 *   3. Returns the rewritten payload when it differs.
 *
 */

import type { HookHandlerContext } from "../lib/host-types.ts"
import { rewriteMentions } from "../lib/mention/rewrite.ts"
import { getPeers, setPeersFromRoster } from "../lib/mention/state.ts"
import { loadRoster, serviceDepsFromAgent } from "../lib/service.ts"

interface TurnWillStartPayload {
  text: string
}

function isPayload(v: unknown): v is TurnWillStartPayload {
  if (!v || typeof v !== "object") return false
  return typeof (v as Record<string, unknown>).text === "string"
}

/**
 * Chain listener signature: `(payload, ctx) => {payload} | void`.
 * The loader wraps this as a module export for `hooks[]` entries.
 */
const handler = (
  payload: unknown,
  ctx: HookHandlerContext,
): { payload: TurnWillStartPayload } | void => {
  if (!isPayload(payload)) return
  if (!payload.text.includes("@")) return

  refreshPeers(ctx)
  const peers = getPeers()
  if (peers.length === 0) return

  const rewritten = rewriteMentions(payload.text, peers)
  if (rewritten === payload.text) return
  return { payload: { text: rewritten } }
}

function refreshPeers(ctx: HookHandlerContext): void {
  try {
    const deps = serviceDepsFromAgent(ctx.agent, process.env, ctx.host)
    if (!deps) return
    const rows = loadRoster(deps, { excludeSelf: true })
    setPeersFromRoster(rows)
  } catch {
    // Keep previous cache.
  }
}

export default handler
