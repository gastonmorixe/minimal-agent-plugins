/**
 * The Computer tool's `action` enum maps to daemon routes. This module owns the
 * mapping + light per-action validation on the bun side (the Swift daemon also
 * validates, this is just a fast fail with a clear message).
 *
 * @module lib/routes
 */

export const ROUTES = [
  "ping",
  "perms",
  "apps",
  "activate",
  "windows",
  "snapshot",
  "find",
  "elementAtPoint",
  "focused",
  "describe",
  "getValue",
  "setValue",
  "perform",
  "mouse",
  "type",
  "key",
  "keypress",
  "screenshot",
] as const

export type Route = (typeof ROUTES)[number]

export function isRoute(s: string): s is Route {
  return (ROUTES as readonly string[]).includes(s)
}

export interface ValidatedInput {
  route: Route
  body: Record<string, unknown>
}

export interface ValidationOk {
  ok: true
  route: Route
  body: Record<string, unknown>
}
export interface ValidationErr {
  ok: false
  error: string
}
export type ValidationResult = ValidationOk | ValidationErr

const NUM = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const STR = (v: unknown): v is string => typeof v === "string" && v.length > 0

/**
 * Validate the raw tool input. The tool takes `action` plus action-specific
 * params; we forward everything except `action` as the daemon body.
 */
export function validateToolInput(input: unknown): ValidationResult {
  if (!input || typeof input !== "object") return { ok: false, error: "input must be an object" }
  const o = input as Record<string, unknown>
  const action = o.action
  if (typeof action !== "string") return { ok: false, error: "missing required 'action'" }
  if (!isRoute(action)) return { ok: false, error: `unknown action '${action}'` }

  // Build the body from the remaining keys.
  const body: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) {
    if (k === "action") continue
    if (v !== undefined && v !== null) body[k] = v
  }

  // Per-action required-field checks.
  switch (action) {
    case "elementAtPoint":
      if (!NUM(body.x) || !NUM(body.y))
        return { ok: false, error: "elementAtPoint requires numeric x and y" }
      break
    case "describe":
    case "getValue":
      if (!STR(body.el)) return { ok: false, error: `${action} requires 'el' (element handle)` }
      break
    case "setValue":
      if (!STR(body.el)) return { ok: false, error: "setValue requires 'el'" }
      if (body.value === undefined) return { ok: false, error: "setValue requires 'value'" }
      break
    case "perform":
      if (!STR(body.el)) return { ok: false, error: "perform requires 'el'" }
      if (!STR(body.axAction))
        return { ok: false, error: "perform requires 'axAction' (e.g. AXPress)" }
      break
    case "type":
      if (typeof body.text !== "string") return { ok: false, error: "type requires 'text'" }
      break
    case "key":
    case "keypress":
      if (!STR(body.combo) && !STR(body.key))
        return { ok: false, error: "key requires 'combo' (e.g. cmd+c) or 'key' (e.g. return)" }
      break
    case "mouse": {
      const op = body.op
      if (op !== undefined && typeof op !== "string")
        return { ok: false, error: "mouse 'op' must be a string" }
      const needsXY = [
        "move",
        "click",
        "leftclick",
        "doubleclick",
        "rightclick",
        "middleclick",
        "down",
        "up",
        "drag",
      ]
      if (typeof op === "string" && needsXY.includes(op)) {
        if (!NUM(body.x) || !NUM(body.y))
          return { ok: false, error: `mouse ${op} requires numeric x and y` }
      }
      if (op === "drag" && (!NUM(body.toX) || !NUM(body.toY)))
        return { ok: false, error: "mouse drag requires numeric toX and toY" }
      break
    }
    default:
      break
  }

  return { ok: true, route: action, body }
}
