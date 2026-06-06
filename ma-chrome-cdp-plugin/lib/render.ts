/**
 * Render a daemon response into the model-facing `content` string and a rich
 * ANSI transcript block. Pure + tested.
 *
 * # Why this file got bigger
 *
 * The old block showed only the *result* JSON: you'd see `{cookies: …, ls: …}`
 * come back but had no idea what JS expression, CDP method, or URL produced it.
 * "I am clueless what it's issuing right now" was the exact complaint.
 *
 * So the transcript block now leads with the REQUEST. {@link describeRequest}
 * builds a one-line header that names the action and its key argument (the JS
 * expr, the `Domain.method`, the URL, the target tab). {@link renderDisplay}
 * builds the body: the full request (multi-line JS shown verbatim, CDP params
 * pretty-printed) followed by a compact result preview. The model-facing
 * `content` is unchanged (full pretty JSON via {@link renderContent}).
 *
 * @module lib/render
 */

import type { Route } from "./routes.ts"

const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const RESET = "\x1b[22m" // resets BOTH bold + dim (intensity)
const RED = "\x1b[31m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const CYAN = "\x1b[36m"
const GRAY = "\x1b[90m"
const RESET_FG = "\x1b[39m"

export function dim(s: string): string {
  return `${DIM}${s}${RESET}`
}
export function bold(s: string): string {
  return `${BOLD}${s}${RESET}`
}
export function red(s: string): string {
  return `${RED}${s}${RESET_FG}`
}
export function green(s: string): string {
  return `${GREEN}${s}${RESET_FG}`
}
export function yellow(s: string): string {
  return `${YELLOW}${s}${RESET_FG}`
}
export function cyan(s: string): string {
  return `${CYAN}${s}${RESET_FG}`
}
export function gray(s: string): string {
  return `${GRAY}${s}${RESET_FG}`
}

/** A gray middot bullet for separating chunks on one line. */
const DOT = gray("·")

// ---------------------------------------------------------------------------
// Small pure string helpers
// ---------------------------------------------------------------------------

/** Read a field as a non-empty string, else "". Defensive (post-validation). */
function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}

/** Collapse all whitespace to single spaces and ellipsize to `max`. For
 *  single-line headers, where a multi-line JS expr must become one row. Pure. */
export function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim()
  if (one.length <= max) return one
  return `${one.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/** Truncate to `max` PRESERVING internal whitespace (so JSON indentation and
 *  code survive). Only the tail is cut. Pure. */
export function clipEnd(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`
}

/** Shorten a long CDP target/session id to `head…tail` so the header stays
 *  scannable. Short ids pass through unchanged. Pure. */
export function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 9)}…${id.slice(-4)}` : id
}

/** Stringify a value for a result/params preview, tolerating `undefined`,
 *  cycles, and BigInt without throwing. Pure. */
function safeStringify(v: unknown): string {
  if (v === undefined) return "undefined"
  if (typeof v === "string") return v
  try {
    const json = JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val), 2)
    return json ?? String(v)
  } catch {
    return String(v)
  }
}

/** A compact one-line JSON of `params` for the header, or "" when empty. Pure. */
function compactParams(p: unknown): string {
  if (!p || typeof p !== "object" || Array.isArray(p)) return ""
  if (Object.keys(p as object).length === 0) return ""
  try {
    return clip(JSON.stringify(p), 56)
  } catch {
    return ""
  }
}

// ---------------------------------------------------------------------------
// Header: a one-line "what is being issued" summary (the `displayHeader` slot)
// ---------------------------------------------------------------------------

/**
 * One-line description of the REQUEST being issued, for the header slot the
 * host paints after `╭ ◉ ChromeCDP`. Names the action and its primary
 * argument so the user can read, at a glance, what the model just told the
 * browser to do. Single-line (the host requires it). Pure.
 *
 * Examples:
 *   eval ⟩ 6A21F2A0…b3c4  document.cookie + localStorage
 *   send ⟩ Network.getResponseBody  {"requestId":"42.7"}
 *   nav  ⟩ 6A21F2A0…b3c4  → https://example.com
 *   targets
 */
export function describeRequest(route: Route, body: Record<string, unknown>): string {
  const action = bold(cyan(route))
  const at = gray("⟩")
  const target = str(body.target)
  switch (route) {
    case "eval":
      return `${action} ${at} ${dim(shortId(target))}  ${clip(str(body.expr), 56)}`
    case "frameeval":
      return `${action} ${at} ${dim(`⊂${str(body.urlSub)}`)}  ${clip(str(body.expr), 48)}`
    case "nav":
      return `${action} ${at} ${dim(shortId(target))}  ${gray("→")} ${clip(str(body.url), 56)}`
    case "newtab":
      return `${action}  ${gray("→")} ${clip(str(body.url) || "about:blank", 60)}`
    case "send": {
      const method = bold(str(body.method))
      const p = compactParams(body.params)
      return p ? `${action} ${at} ${method}  ${dim(p)}` : `${action} ${at} ${method}`
    }
    case "setdownload":
      return `${action} ${at} ${dim(shortId(target))}  ${clip(str(body.dir), 48)}`
    case "closetarget":
    case "activatetarget":
    case "getinfo":
      return `${action} ${at} ${dim(shortId(target))}`
    case "events": {
      const bits: string[] = []
      if (str(body.filter)) bits.push(`filter=${str(body.filter)}`)
      if (typeof body.since === "number") bits.push(`since=${body.since}`)
      if (typeof body.limit === "number") bits.push(`limit=${body.limit}`)
      if (body.clear === true) bits.push("clear")
      return bits.length ? `${action}  ${dim(bits.join(" "))}` : action
    }
    case "record":
      return `${action}  ${body.on === false ? yellow("off") : green("on")}`
    default:
      // ping, targets, alltargets, downloads — no arguments worth showing.
      return action
  }
}

// ---------------------------------------------------------------------------
// Body: request-first multi-line block (the `display` slot)
// ---------------------------------------------------------------------------

const MAX_EXPR_LINES = 18
const MAX_PARAM_LINES = 12
const MAX_RESULT_LINES = 14
const COL = 112

/** The JS expression, shown verbatim across rows with a `❯` prompt. Pure. */
function exprBlock(expr: string): string[] {
  const raw = expr.split("\n")
  const shown = raw.slice(0, MAX_EXPR_LINES)
  const out = shown.map((ln, i) => `${i === 0 ? cyan("❯") : " "} ${clipEnd(ln, COL)}`)
  if (raw.length > shown.length) out.push(dim(`  … +${raw.length - shown.length} more line(s)`))
  return out
}

/** The request portion of the body: what we're telling the browser to do. Pure. */
function requestSection(route: Route, body: Record<string, unknown>): string[] {
  const lines: string[] = []
  const target = str(body.target)
  const tabLine = (id: string) => `${dim("tab")}  ${dim(shortId(id))}`
  switch (route) {
    case "eval":
      if (target) lines.push(tabLine(target))
      lines.push(...exprBlock(str(body.expr)))
      return lines
    case "frameeval":
      lines.push(`${dim("frame")}  ${dim(`⊂ ${str(body.urlSub)}`)}`)
      lines.push(...exprBlock(str(body.expr)))
      return lines
    case "send": {
      lines.push(`${cyan("λ")} ${bold(str(body.method))}`)
      const scope = target
        ? `tab ${shortId(target)}`
        : str(body.sessionId)
          ? `session ${shortId(str(body.sessionId))}`
          : "browser-global"
      lines.push(`${dim("scope")}  ${dim(scope)}`)
      const params = body.params
      if (params && typeof params === "object" && Object.keys(params).length > 0) {
        const pj = safeStringify(params).split("\n")
        lines.push(dim("params"))
        for (const ln of pj.slice(0, MAX_PARAM_LINES)) lines.push(dim(clipEnd(ln, COL)))
        if (pj.length > MAX_PARAM_LINES) lines.push(dim(`… +${pj.length - MAX_PARAM_LINES} more`))
      }
      return lines
    }
    case "nav":
      if (target) lines.push(tabLine(target))
      lines.push(`${cyan("→")} ${clipEnd(str(body.url), COL)}`)
      return lines
    case "newtab":
      lines.push(`${cyan("→")} ${clipEnd(str(body.url) || "about:blank", COL)}`)
      return lines
    case "setdownload":
      if (target) lines.push(tabLine(target))
      lines.push(`${dim("dir")}  ${clipEnd(str(body.dir), COL)}`)
      return lines
    case "closetarget":
    case "activatetarget":
    case "getinfo":
      lines.push(tabLine(target))
      return lines
    case "events": {
      const bits: string[] = []
      if (str(body.filter)) bits.push(`filter ${str(body.filter)}`)
      if (typeof body.since === "number") bits.push(`since ${body.since}`)
      if (typeof body.limit === "number") bits.push(`limit ${body.limit}`)
      if (str(body.sessionId)) bits.push(`session ${shortId(str(body.sessionId))}`)
      if (body.clear === true) bits.push("clear after")
      lines.push(
        dim(
          bits.length
            ? `drain buffered events ${DOT} ${bits.join(` ${DOT} `)}`
            : "drain all buffered events",
        ),
      )
      return lines
    }
    case "record":
      lines.push(
        dim(body.on === false ? "stop buffering CDP events" : "start buffering CDP events"),
      )
      return lines
    case "targets":
      lines.push(dim("list open page tabs"))
      return lines
    case "alltargets":
      lines.push(dim("list every target (pages, iframes, workers)"))
      return lines
    case "downloads":
      lines.push(dim("list tracked downloads"))
      return lines
    default:
      // ping
      lines.push(dim("check daemon + browser liveness"))
      return lines
  }
}

/** Pull a human error message out of a daemon body, or null on success. Pure. */
function extractError(resBody: unknown): string | null {
  if (resBody && typeof resBody === "object") {
    const o = resBody as Record<string, unknown>
    if (typeof o.error === "string") return o.error
    const r = o.result
    if (r && typeof r === "object" && typeof (r as Record<string, unknown>).__error === "string") {
      return (r as Record<string, unknown>).__error as string
    }
  }
  return null
}

/** For `{result: value}` bodies (eval/send/frameeval), preview the inner value;
 *  otherwise preview the body as-is (arrays for targets/downloads, etc). Pure. */
function unwrapResult(resBody: unknown): unknown {
  if (resBody && typeof resBody === "object" && !Array.isArray(resBody) && "result" in resBody) {
    return (resBody as Record<string, unknown>).result
  }
  return resBody
}

/** A short, dimmed preview of the result, capped in line count (the full JSON
 *  always lives in the model-facing `content`). Pure. */
function resultSection(resBody: unknown): string[] {
  const err = extractError(resBody)
  if (err) return [`${red("✘")} ${red(clip(err, 200))}`]

  const preview = unwrapResult(resBody)
  if (preview === undefined || preview === null) {
    return [`${gray("⤷")} ${dim("result")}  ${dim(preview === null ? "null" : "undefined")}`]
  }
  const rawLines = safeStringify(preview).split("\n")
  // Single short scalar: keep it on the header-ish line.
  if (rawLines.length === 1 && rawLines[0].length <= COL - 12) {
    return [`${gray("⤷")} ${dim("result")}  ${dim(rawLines[0])}`]
  }
  const out = [`${gray("⤷")} ${dim("result")}`]
  for (const ln of rawLines.slice(0, MAX_RESULT_LINES)) out.push(dim(clipEnd(ln, COL)))
  if (rawLines.length > MAX_RESULT_LINES) {
    out.push(dim(`… +${rawLines.length - MAX_RESULT_LINES} more line(s)`))
  }
  return out
}

/**
 * The full transcript body for the `display` slot: the request (what we issued)
 * followed by a compact result preview. The host wraps each `\n`-split line in
 * the `│` gutter; the closer row carries {@link summarize} via `displayFooter`.
 * Pure.
 */
export function renderDisplay(
  route: Route,
  reqBody: Record<string, unknown>,
  resBody: unknown,
): string {
  return [...requestSection(route, reqBody), ...resultSection(resBody)].join("\n")
}

/** One-line summary of a route result for the transcript footer/closer. */
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
