/**
 * Render a daemon response into the model-facing `content` string and a short
 * ANSI `display` preview. Pure + tested.
 *
 * @module lib/render
 */

import type { Route } from "./routes.ts"
import { slots } from "./style.ts"

export interface SgrTokens {
  readonly dim: string
  readonly weightReset: string
  readonly red: string
  readonly fgReset: string
}

/**
 * The style tokens of this module (S41). They come from the style slots,
 * read at call time, so they are plain until the CLI runs `ui/setup.ts`.
 */
function sgr(): SgrTokens {
  return {
    dim: slots.codes.DIM,
    weightReset: slots.codes.BOLD_CLOSE,
    red: slots.palette.red,
    fgReset: slots.codes.FG_RESET,
  }
}

/** Wrap a string in the ANSI dim attribute. */
export function dim(s: string): string {
  return `${sgr().dim}${s}${sgr().weightReset}`
}
/** Color a string red (ANSI foreground). */
export function red(s: string): string {
  return `${sgr().red}${s}${sgr().fgReset}`
}

/**
 * The target part of a screenshot summary: the mode, then the window id and
 * title, the app, or the display. Empty when the daemon sent no `mode`.
 */
function screenshotTarget(o: Record<string, unknown>): string {
  switch (o.mode) {
    case "window": {
      const title = typeof o.title === "string" && o.title ? ` ${JSON.stringify(o.title)}` : ""
      const covered = o.occluded === true ? " occluded" : ""
      return `window ${o.windowId ?? "?"}${title}${covered}`
    }
    case "app":
      return `app ${o.bundleId ?? o.pid ?? "?"} (${o.windows ?? 0} window(s))`
    case "screen":
    case "area":
      return typeof o.display === "number" ? `${o.mode} display ${o.display}` : o.mode
    default:
      return typeof o.mode === "string" ? o.mode : ""
  }
}

/** One-line summary of a screenshot result: mode, target, size and scale, then the path. */
function summarizeScreenshot(o: Record<string, unknown>): string {
  const target = screenshotTarget(o)
  const lead = target ? `${target} ` : ""
  const scale = typeof o.scale === "number" ? ` @${Number(o.scale.toFixed(2))}x` : ""
  const size = `${o.width}×${o.height}${scale}`
  if (typeof o.path === "string") return `${lead}${size} · ${o.path}`
  if (typeof o.bytes === "number") return `${lead}${size} · ${o.bytes}B base64`
  return target ? `${target} captured` : "captured"
}

/** One-line summary of a route result for the transcript footer. */
export function summarize(route: Route, body: unknown): string {
  if (!body || typeof body !== "object") return "ok"
  const o = body as Record<string, unknown>
  if ("error" in o) return String(o.error).slice(0, 80)
  switch (route) {
    case "ping": {
      const perms = o.perms as Record<string, unknown> | undefined
      const p = perms ? `ax:${perms.ax} screen:${perms.screen}` : ""
      return `up · v${o.version ?? "?"} · ${p}`
    }
    case "perms": {
      return `ax:${o.ax} screen:${o.screen} input:${o.input}`
    }
    case "apps":
      return `${(o.apps as unknown[] | undefined)?.length ?? 0} app(s)`
    case "windows":
      return `${(o.windows as unknown[] | undefined)?.length ?? 0} window(s)`
    case "snapshot":
      return `${o.nodeCount ?? 0} node(s)${o.truncated ? " (truncated)" : ""} · ${o.snapshotId ?? ""}`
    case "find":
      return `${o.count ?? 0} match(es)`
    case "screenshot":
      return summarizeScreenshot(o)
    case "targets": {
      const displays = (o.displays as unknown[] | undefined)?.length ?? 0
      const windows = (o.windows as unknown[] | undefined)?.length ?? 0
      return `${displays} display(s), ${windows} window(s)${o.truncated ? " (truncated)" : ""}`
    }
    case "type":
      return o.ok ? `typed ${o.typed ?? ""} chars` : "blocked"
    default:
      if (o.ok === true) return o.warning ? `ok (${String(o.warning).slice(0, 40)})` : "ok"
      if ("element" in o) return "element"
      return "ok"
  }
}

/** The model-facing content: pretty JSON, capped so a huge snapshot doesn't flood. */
export function renderContent(body: unknown, maxChars = 24_000): string {
  // Strip base64 blobs from the readable content (they're noise to read).
  let printable = body
  if (body && typeof body === "object" && "base64" in (body as object)) {
    const o = { ...(body as Record<string, unknown>) }
    const b64 = o.base64
    o.base64 = typeof b64 === "string" ? `<${b64.length} base64 chars omitted>` : b64
    printable = o
  }
  const json = JSON.stringify(printable, null, 2)
  if (json.length <= maxChars) return json
  return `${json.slice(0, maxChars)}\n... (${json.length - maxChars} more chars truncated. Narrow the query, e.g. lower maxNodes or use find)`
}

/** True when the daemon body represents a failure the model should treat as an error. */
export function isErrorBody(status: number, body: unknown): boolean {
  if (status >= 400) return true
  if (body && typeof body === "object" && "error" in (body as object)) return true
  return false
}
