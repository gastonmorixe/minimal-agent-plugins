/**
 * The background-jobs supervisor: a live-area slot that ticks every second.
 *
 * Thin shell: build real deps from `ctx`, run one reconcile pass, execute the
 * resulting effects (emit a bus event, inject a completion digest between turns
 * via `prompt.inject`), and return the breathing widget. Disabled by
 * `MINIMAL_AGENT_DISABLE_BGJOBS=1`.
 *
 * @module handlers/heartbeat
 */

import { loadBgConfig } from "../lib/config.ts"
import { realReconcileIO, serviceDepsFromCtx } from "../lib/handler-deps.ts"
import type { LiveAreaHandlerContext } from "../lib/host-types.ts"
import type { Effect } from "../lib/reconcile.ts"
import { configureSgr, renderWidget } from "../lib/render.ts"
import { runReconcile } from "../lib/service.ts"

const handler = async (ctx: LiveAreaHandlerContext): Promise<string | null> => {
  configureSgr(ctx.env.MINIMAL_AGENT_PALETTE)

  if (ctx.env.MINIMAL_AGENT_DISABLE_BGJOBS === "1") return null

  const config = loadBgConfig(ctx.env as NodeJS.ProcessEnv)
  const deps = serviceDepsFromCtx(
    {
      packageDir: ctx.packageDir,
      cwd: ctx.cwd,
      env: ctx.env,
      ...(ctx.agent ? { agent: ctx.agent } : {}),
    },
    config,
  )
  if (!deps) return null

  const { records, effects } = runReconcile(deps, realReconcileIO())
  for (const e of effects) runEffect(e, ctx)

  const cols = process.stdout.columns ?? 80
  return renderWidget(records, { tick: ctx.tick, nowMs: Date.now(), cols })
}

/** Execute one reconcile effect via the slot's bus. */
function runEffect(e: Effect, ctx: LiveAreaHandlerContext): void {
  switch (e.type) {
    case "emit":
      ctx.emit?.(e.channel, e.payload)
      break
    case "inject":
      // The completion digest rides the existing `prompt.inject` channel: it
      // lands BETWEEN turns and survives resume, like the sub-agents plugin.
      ctx.emit?.("prompt.inject", { text: e.text, source: e.source })
      break
    default: {
      const _exhaustive: never = e
      throw new Error(`unhandled effect: ${String(_exhaustive)}`)
    }
  }
}

export default handler
