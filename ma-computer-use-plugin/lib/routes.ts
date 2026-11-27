/**
 * The Computer tool's `action` enum maps to daemon routes. This module owns the
 * mapping + light per-action validation on the bun side (the Swift daemon also
 * validates, this is just a fast fail with a clear message).
 *
 * @module lib/routes
 */

import { homedir } from "node:os"
import { isAbsolute, resolve } from "node:path"

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
  "targets",
] as const

export type Route = (typeof ROUTES)[number]

/** Type guard: is the string one of the known route names? */
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

/** An integer from `min` to `max`, both included (review R3, R10). */
const INT_IN = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max

/** The largest `pid_t` (Int32). A larger pid traps the Swift daemon. */
export const MAX_PID = 2 ** 31 - 1

/** The largest `CGWindowID` and `CGDirectDisplayID` (UInt32). */
export const MAX_UINT32 = 2 ** 32 - 1

/** The error text of a bad pid. */
const PID_ERROR = `pid must be an integer from 1 to ${MAX_PID}.`

/** The `screenshot` modes that the daemon knows. */
export const SCREENSHOT_MODES = ["screen", "area", "window", "app"] as const

/** The minimum `maxSize` (long edge, in pixels) that the daemon accepts. */
export const MIN_MAX_SIZE = 64

/** The hint that ends each screenshot target error. */
const TARGETS_HINT = "Use `targets` to get the window ids and the display list."

/**
 * Check the target fields of a `screenshot` body.
 *
 * @param body - The daemon body, without `action`.
 * @returns An error text, or null when the body is valid.
 */
export function screenshotError(body: Record<string, unknown>): string | null {
  const mode = body.mode ?? "screen"
  if (typeof mode !== "string" || !(SCREENSHOT_MODES as readonly string[]).includes(mode))
    return `screenshot: the mode '${String(mode)}' is not known. Use ${SCREENSHOT_MODES.join(", ")}.`
  if (body.maxSize !== undefined && !INT_IN(body.maxSize, MIN_MAX_SIZE, Number.MAX_SAFE_INTEGER))
    return `screenshot: maxSize must be an integer, ${MIN_MAX_SIZE} or more.`
  if (body.display !== undefined && !INT_IN(body.display, 0, Number.MAX_SAFE_INTEGER))
    return `screenshot: display must be an integer, 0 or more. ${TARGETS_HINT}`
  if (body.displayId !== undefined && !INT_IN(body.displayId, 0, MAX_UINT32))
    return `screenshot: displayId must be an integer from 0 to ${MAX_UINT32}. ${TARGETS_HINT}`
  if (body.windowId !== undefined && !INT_IN(body.windowId, 1, MAX_UINT32))
    return `screenshot: windowId must be an integer from 1 to ${MAX_UINT32}. ${TARGETS_HINT}`
  if (body.pid !== undefined && !INT_IN(body.pid, 1, MAX_PID)) return `screenshot: ${PID_ERROR}`
  if (body.outputDir !== undefined && !STR(body.outputDir))
    return "screenshot: outputDir must be a directory path."
  switch (mode) {
    case "area": {
      const missing = ["x", "y", "w", "h"].filter((k) => !NUM(body[k]))
      if (missing.length > 0)
        return `screenshot area: give x, y, w and h as numbers in points. Missing: ${missing.join(", ")}.`
      if ((body.w as number) <= 0 || (body.h as number) <= 0)
        return `screenshot area: w and h must be more than 0. ${TARGETS_HINT}`
      break
    }
    case "window":
      if (!NUM(body.windowId) && !STR(body.el) && !NUM(body.pid) && !STR(body.bundleId))
        return `screenshot window: give windowId, el, pid or bundleId. ${TARGETS_HINT}`
      break
    case "app":
      if (!NUM(body.pid) && !STR(body.bundleId))
        return `screenshot app: give pid or bundleId. ${TARGETS_HINT}`
      break
    default:
      break
  }
  return null
}

/** The paths that make a relative `outputDir` absolute. */
export interface PathContext {
  /** The agent cwd. A relative `outputDir` is resolved against it. */
  cwd?: string
  /** The home directory for a `~/` prefix. The default is `os.homedir()`. */
  home?: string
}

/**
 * Make a screenshot `outputDir` absolute (review R6). The daemon writes to the
 * path as given, and its cwd is not the agent cwd.
 *
 * 1. `~` and `~/x` expand with the home directory.
 * 2. An absolute path stays (normalized).
 * 3. A relative path resolves against `ctx.cwd`. With no cwd, it is an error.
 *
 * @param dir - The `outputDir` value.
 * @param ctx - The agent cwd and the home directory.
 * @returns The absolute path, or an error text.
 */
export function resolveOutputDir(
  dir: string,
  ctx: PathContext = {},
): { ok: true; dir: string } | { ok: false; error: string } {
  const home = ctx.home ?? homedir()
  if (dir === "~") return { ok: true, dir: home }
  if (dir.startsWith("~/")) return { ok: true, dir: resolve(home, dir.slice(2)) }
  if (isAbsolute(dir)) return { ok: true, dir: resolve(dir) }
  if (dir.startsWith("~"))
    return {
      ok: false,
      error: `screenshot: outputDir '${dir}' is not supported. Use '~/' or an absolute path.`,
    }
  if (!ctx.cwd || !isAbsolute(ctx.cwd))
    return {
      ok: false,
      error: `screenshot: outputDir '${dir}' is relative and the agent cwd is not known. Use an absolute path.`,
    }
  return { ok: true, dir: resolve(ctx.cwd, dir) }
}

/**
 * Validate the raw tool input. The tool takes `action` plus action-specific
 * params; we forward everything except `action` as the daemon body.
 *
 * @param input - The raw tool input.
 * @param paths - The agent cwd and home, to make `outputDir` absolute.
 */
export function validateToolInput(input: unknown, paths: PathContext = {}): ValidationResult {
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

  // A pid goes to `pid_t(p)` in the daemon for each action that reads it.
  if (body.pid !== undefined && !INT_IN(body.pid, 1, MAX_PID))
    return { ok: false, error: `${action}: ${PID_ERROR}` }

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
    case "screenshot": {
      const error = screenshotError(body)
      if (error) return { ok: false, error }
      if (typeof body.outputDir === "string") {
        const out = resolveOutputDir(body.outputDir, paths)
        if (!out.ok) return out
        body.outputDir = out.dir
      }
      break
    }
    case "targets":
      if (body.limit !== undefined && !INT_IN(body.limit, 1, Number.MAX_SAFE_INTEGER))
        return { ok: false, error: "targets: limit must be an integer, 1 or more." }
      break
    default:
      break
  }

  return { ok: true, route: action, body }
}
