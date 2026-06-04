/**
 * Render a daemon response into the model-facing `content` string and a short
 * ANSI `display` preview. Pure + tested.
 *
 * @module lib/render
 */

import type { Route } from "./routes.ts"

const DIM = "\x1b[2m"
const RESET = "\x1b[22m"
const RED = "\x1b[31m"
const RESET_FG = "\x1b[39m"

export function dim(s: string): string {
  return `${DIM}${s}${RESET}`
}
export function red(s: string): string {
  return `${RED}${s}${RESET_FG}`
}

/** One-line summary of a route result for the transcript header. */
export function summarize(route: Route, body: unknown): string {
  if (Array.isArray(body)) {
    if (route === "targets" || route === "alltargets") return `${body.length} target(s)`
    if (route === "downloads") return `${body.length} download(s)`
    return `${body.length} item(s)`
  }
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>
    if (route === "ping") return o.connected ? "connected" : "disconnected"
    if (route === "newtab" && typeof o.id === "string") return `new tab ${o.id.slice(0, 12)}…`
    if (route === "events") {
      const n = typeof o.count === "number" ? o.count : 0
      const cur = typeof o.cursor === "number" ? o.cursor : 0
      const rec = o.recording ? "rec" : "off"
      return `${n} event(s) · cursor ${cur} · ${rec}`
    }
    if (route === "record") return o.recording ? "recording" : "stopped"
    if (route === "closetarget") return o.ok ? "closed" : "close failed"
    if (route === "activatetarget") return "activated"
    if (route === "getinfo") return typeof o.type === "string" ? o.type : "ok"
    if ("result" in o) {
      const r = o.result
      if (r && typeof r === "object" && "__error" in (r as object)) {
        return route === "send" ? "cdp error" : "eval error"
      }
      return "ok"
    }
    if (o.ok === true) return "ok"
  }
  return "ok"
}

/** The model-facing content: pretty JSON, capped so a huge eval doesn't flood. */
export function renderContent(body: unknown, maxChars = 20_000): string {
  const json = JSON.stringify(body, null, 2)
  if (json.length <= maxChars) return json
  return `${json.slice(0, maxChars)}\n… (${json.length - maxChars} more chars truncated)`
}

/** True when the daemon body represents a failure the model should treat as an error. */
export function isErrorBody(status: number, body: unknown): boolean {
  if (status >= 400) return true
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>
    if ("error" in o) return true
    if (o.result && typeof o.result === "object" && "__error" in (o.result as object)) return true
  }
  return false
}
