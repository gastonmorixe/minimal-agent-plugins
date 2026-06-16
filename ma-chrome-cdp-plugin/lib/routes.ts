/**
 * Daemon route contract + pure request validation.
 *
 * The daemon speaks plain HTTP over a unix domain socket. Each route takes a
 * small JSON body; this module defines the route names and validates/normalizes
 * a parsed body into typed params (or an error string). Pure, so the validation
 * matrix is unit-tested without spinning up a server.
 *
 * @module lib/routes
 */

export const ROUTES = [
  "ping",
  "targets",
  "alltargets",
  "eval",
  "frameeval",
  "nav",
  "newtab",
  "setdownload",
  "downloads",
  // Generic CDP passthrough + event inspection (full-protocol surface).
  "send",
  "events",
  "record",
  "closetarget",
  "activatetarget",
  "getinfo",
] as const

export type Route = (typeof ROUTES)[number]

/** Type guard: is the string one of the known route names? */
export function isRoute(s: string): s is Route {
  return (ROUTES as readonly string[]).includes(s)
}

export interface EvalParams {
  target: string
  expr: string
}
export interface FrameEvalParams {
  target: string
  urlSub: string
  expr: string
}
export interface NavParams {
  target: string
  url: string
}
export interface NewtabParams {
  url: string
}
export interface SetDownloadParams {
  target: string
  dir: string
}
export interface SendParams {
  method: string
  params: Record<string, unknown>
  /** Optional explicit session id (advanced). */
  sessionId?: string
  /** Optional target id; the daemon attaches and scopes the call to it. */
  target?: string
}
export interface EventsParams {
  filter?: string
  since?: number
  sessionId?: string
  limit?: number
  clear?: boolean
}
export interface RecordParams {
  on: boolean
  clear?: boolean
}
export interface TargetIdParam {
  target: string
}

function reqStr(body: Record<string, unknown>, key: string): string {
  const v = body[key]
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`missing required string field "${key}"`)
  }
  return v
}

function optStr(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key]
  if (v == null) return undefined
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`field "${key}" must be a non-empty string when present`)
  }
  return v
}

function optNum(body: Record<string, unknown>, key: string): number | undefined {
  const v = body[key]
  if (v == null) return undefined
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`field "${key}" must be a number when present`)
  }
  return v
}

function optBool(body: Record<string, unknown>, key: string): boolean | undefined {
  const v = body[key]
  if (v == null) return undefined
  if (typeof v !== "boolean") throw new Error(`field "${key}" must be a boolean when present`)
  return v
}

/** A `.`-bearing "Domain.method" string is required for the generic passthrough. */
function reqMethod(body: Record<string, unknown>): string {
  const m = reqStr(body, "method")
  if (!/^[A-Z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(m)) {
    throw new Error(
      `"method" must be a CDP method like "Network.enable" (got ${JSON.stringify(m)})`,
    )
  }
  return m
}

/** `params` for the passthrough: an object or omitted (defaults to `{}`). */
function optParamsObject(body: Record<string, unknown>): Record<string, unknown> {
  const v = body.params
  if (v == null) return {}
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`"params" must be a JSON object`)
  }
  return v as Record<string, unknown>
}

/**
 * Validate + normalize a parsed JSON body for a route. Returns the typed
 * params. Throws `Error` with a human message on bad input (the daemon turns
 * that into a 400). Routes with no params (`ping`, `targets`, …) return `{}`.
 */
export function validateBody(route: Route, body: Record<string, unknown>): Record<string, unknown> {
  switch (route) {
    case "eval":
      return { target: reqStr(body, "target"), expr: reqStr(body, "expr") } satisfies EvalParams
    case "frameeval":
      return {
        target: reqStr(body, "target"),
        urlSub: reqStr(body, "urlSub"),
        expr: reqStr(body, "expr"),
      } satisfies FrameEvalParams
    case "nav":
      return { target: reqStr(body, "target"), url: reqStr(body, "url") } satisfies NavParams
    case "newtab":
      // url optional; default about:blank
      return {
        url: typeof body.url === "string" && body.url ? body.url : "about:blank",
      } satisfies NewtabParams
    case "setdownload":
      return {
        target: reqStr(body, "target"),
        dir: reqStr(body, "dir"),
      } satisfies SetDownloadParams
    case "send":
      return {
        method: reqMethod(body),
        params: optParamsObject(body),
        sessionId: optStr(body, "sessionId"),
        target: optStr(body, "target"),
      } satisfies SendParams
    case "events":
      return {
        filter: optStr(body, "filter"),
        since: optNum(body, "since"),
        sessionId: optStr(body, "sessionId"),
        limit: optNum(body, "limit"),
        clear: optBool(body, "clear"),
      } satisfies EventsParams
    case "record":
      return {
        on: optBool(body, "on") ?? true,
        clear: optBool(body, "clear"),
      } satisfies RecordParams
    case "closetarget":
    case "activatetarget":
    case "getinfo":
      return { target: reqStr(body, "target") } satisfies TargetIdParam
    default:
      return {}
  }
}
