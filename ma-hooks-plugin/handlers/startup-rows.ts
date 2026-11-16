/**
 * Listener for the future core chain channel `startup.rows` (design H1).
 * It appends the `hooks` row to the CLI startup header. Not registered in
 * `manifest.json` yet: core does not have the channel.
 *
 * It uses the engine cache of `handlers/dispatch.ts` (`engineFor`). Engine
 * discovery is sync and reads a few small files. It never throws: an error
 * goes to the debug log and the payload stays as it is.
 *
 * @module handlers/startup-rows
 */

import type { HookHandlerContext } from "@minimal-agent/core/plugin-api/types/plugin"

import { buildHooksStartupRow, type StartupRowsPayload } from "../engine/startup-row.ts"

import { engineFor } from "./dispatch.ts"

/** Default export: the `startup.rows` chain listener. */
export default function startupRows(
  payload: StartupRowsPayload,
  ctx: HookHandlerContext,
): { payload: StartupRowsPayload } | undefined {
  try {
    const cwd = typeof payload?.cwd === "string" && payload.cwd !== "" ? payload.cwd : ctx.cwd
    const eng = engineFor(cwd)
    // A plugin-wide `enabled: false` runs no hook, so there is nothing to show.
    if (!eng.config.enabled) return undefined
    const row = buildHooksStartupRow(eng.status())
    if (!row) return undefined
    const rows = Array.isArray(payload.rows) ? payload.rows : []
    return { payload: { ...payload, rows: [...rows, row] } }
  } catch (e) {
    try {
      ctx.log.debug("hooks", `startup.rows failed: ${String(e)}`)
    } catch {
      // a logger failure never breaks the header
    }
    return undefined
  }
}
