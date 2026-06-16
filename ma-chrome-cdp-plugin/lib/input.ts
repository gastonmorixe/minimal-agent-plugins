/**
 * Validate + normalize the `ChromeCDP` tool's raw input into a daemon route +
 * body. Pure, so the action/param matrix is unit-tested without a browser.
 *
 * @module lib/input
 */

import { isRoute, type Route, validateBody } from "./routes.ts"

export type ValidateResult =
  | { ok: true; route: Route; body: Record<string, unknown> }
  | { ok: false; error: string }

const ACTION_HELP =
  "actions: ping | targets | alltargets | eval | frameeval | nav | newtab | setdownload | " +
  "downloads | send | events | record | closetarget | activatetarget | getinfo"

/**
 * Map the tool input to a route + validated body.
 *
 * Tool input shape:
 * ```
 *   { action: "<route>", target?, expr?, urlSub?, url?, dir?,
 *     method?, params?, sessionId?, filter?, since?, limit?, clear?, on? }
 * ```
 *
 * The field names mirror the route params. Validation reuses `validateBody`
 * from the route contract, so the tool and the daemon agree on requirements.
 */
export function validateToolInput(raw: Record<string, unknown>): ValidateResult {
  const action = raw.action
  if (typeof action !== "string" || action.length === 0) {
    return { ok: false, error: `\`action\` is required. ${ACTION_HELP}` }
  }
  if (!isRoute(action)) {
    return { ok: false, error: `unknown action "${action}". ${ACTION_HELP}` }
  }
  try {
    const body = validateBody(action, raw)
    return { ok: true, route: action, body }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
