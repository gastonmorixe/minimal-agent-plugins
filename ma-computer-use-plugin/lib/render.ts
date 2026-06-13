/**
 * Render a daemon response into the model-facing `content` string and a short
 * ANSI `display` preview. Pure + tested.
 *
 * @module lib/render
 */

import type { Route } from "./routes.ts"

const FALLBACK_SGR = {
  dim: "\x1b[2m",
  weightReset: "\x1b[22m",
  red: "\x1b[31m",
  fgReset: "\x1b[39m",
} as const

export interface SgrTokens {
  readonly dim: string
  readonly weightReset: string
  readonly red: string
  readonly fgReset: string
}

/** Resolve style tokens from the host-injected palette environment. */
export function resolveSgr(raw = process.env.MINIMAL_AGENT_PALETTE): SgrTokens {
  const palette = parsePaletteEnv(raw)
  return {
    ...FALLBACK_SGR,
    red: palette?.red ?? FALLBACK_SGR.red,
    fgReset: palette?._fgReset ?? FALLBACK_SGR.fgReset,
  }
}

function parsePaletteEnv(raw: string | undefined): Record<string, string> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") out[key] = value
    }
    return out
  } catch {
    return null
  }
}

const SGR = resolveSgr()

/** Wrap a string in the ANSI dim attribute. */
export function dim(s: string): string {
  return `${SGR.dim}${s}${SGR.weightReset}`
}
/** Color a string red (ANSI foreground). */
export function red(s: string): string {
  return `${SGR.red}${s}${SGR.fgReset}`
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
      if (typeof o.path === "string") return `${o.path} (${o.width}×${o.height} @${o.scale}x)`
      if (typeof o.bytes === "number") return `${o.bytes}B base64 (${o.width}×${o.height})`
      return "captured"
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
  return `${json.slice(0, maxChars)}\n… (${json.length - maxChars} more chars truncated; narrow the query, e.g. lower maxNodes or use find)`
}

/** True when the daemon body represents a failure the model should treat as an error. */
export function isErrorBody(status: number, body: unknown): boolean {
  if (status >= 400) return true
  if (body && typeof body === "object" && "error" in (body as object)) return true
  return false
}
