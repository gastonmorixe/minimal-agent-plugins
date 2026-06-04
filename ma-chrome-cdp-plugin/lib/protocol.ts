/**
 * Pure Chrome DevTools Protocol (CDP) helpers.
 *
 * Everything here is side-effect free so it can be unit-tested without a
 * browser or a socket: building JSON-RPC request frames, parsing the
 * `DevToolsActivePort` file, deriving the browser websocket URL, and
 * classifying inbound CDP messages (command replies vs. the events we care
 * about: target attach/detach and download progress).
 *
 * The stateful pieces (the live WebSocket, session bookkeeping) live in
 * `cdp-connection.ts` and lean on these helpers.
 *
 * @module lib/protocol
 */

/** A JSON-RPC request frame sent to the browser. */
export interface CdpRequest {
  id: number
  method: string
  params: Record<string, unknown>
  /** Flattened session routing for page/frame-scoped commands. */
  sessionId?: string
}

/** Anything the browser sends back: a reply (has `id`) or an event (has `method`). */
export interface CdpInbound {
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { code: number; message: string }
  sessionId?: string
}

/** Build a CDP request frame. Pure: the caller owns id allocation. */
export function buildRequest(
  id: number,
  method: string,
  params: Record<string, unknown> = {},
  sessionId?: string,
): CdpRequest {
  const msg: CdpRequest = { id, method, params }
  if (sessionId) msg.sessionId = sessionId
  return msg
}

/**
 * Parse a `DevToolsActivePort` file's contents.
 *
 * Chrome writes two lines into `<user-data-dir>/DevToolsActivePort`:
 *   line 1: the port number
 *   line 2: the browser websocket path, e.g. `/devtools/browser/<uuid>`
 *
 * We read this file rather than hitting `GET /json/version` because newer
 * Chrome/Chromium block the `/json` HTTP endpoints with DNS-rebind protection
 * (they 404 unless the Host header matches), while the file is always present.
 */
export function parseDevToolsActivePort(contents: string): { port: number; wsPath: string } {
  const lines = contents.trim().split("\n")
  if (lines.length < 2) {
    throw new Error("DevToolsActivePort malformed: expected 2 lines (port, ws path)")
  }
  const port = Number.parseInt(lines[0]?.trim() ?? "", 10)
  const wsPath = (lines[1] ?? "").trim()
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`DevToolsActivePort: bad port ${JSON.stringify(lines[0])}`)
  }
  if (!wsPath.startsWith("/devtools/browser/")) {
    throw new Error(`DevToolsActivePort: bad ws path ${JSON.stringify(wsPath)}`)
  }
  return { port, wsPath }
}

/**
 * Derive the browser websocket URL. Connecting over `127.0.0.1` (not
 * `localhost`) avoids a DNS lookup and matches what Chrome advertises.
 */
export function browserWsUrl(port: number, wsPath: string): string {
  return `ws://127.0.0.1:${port}${wsPath}`
}

/** A download as tracked from `Browser.downloadWillBegin` + `downloadProgress`. */
export interface DownloadRecord {
  guid: string
  url: string
  file: string
  state: "begin" | "inProgress" | "completed" | "canceled"
}

/** Discriminated result of classifying one inbound message. */
export type Classified =
  | {
      kind: "reply"
      id: number
      error?: { code: number; message: string }
      result?: Record<string, unknown>
    }
  | { kind: "attached"; sessionId: string; url: string; targetType: string }
  | { kind: "detached"; sessionId: string }
  | { kind: "downloadBegin"; guid: string; url: string; file: string }
  | { kind: "downloadProgress"; guid: string; state: DownloadRecord["state"] }
  | { kind: "ignored" }

/**
 * Classify an inbound CDP message into the small set of things the daemon
 * acts on. Keeping this pure makes the message-routing logic trivially
 * testable: feed it a parsed frame, assert the discriminant.
 */
export function classifyInbound(m: CdpInbound): Classified {
  if (typeof m.id === "number") {
    return { kind: "reply", id: m.id, error: m.error, result: m.result }
  }
  switch (m.method) {
    case "Target.attachedToTarget": {
      const ti = (m.params?.targetInfo ?? {}) as { url?: string; type?: string }
      return {
        kind: "attached",
        sessionId: String(m.params?.sessionId ?? ""),
        url: ti.url ?? "",
        targetType: ti.type ?? "",
      }
    }
    case "Target.detachedFromTarget":
      return { kind: "detached", sessionId: String(m.params?.sessionId ?? "") }
    case "Browser.downloadWillBegin":
      return {
        kind: "downloadBegin",
        guid: String(m.params?.guid ?? ""),
        url: String(m.params?.url ?? ""),
        file: String(m.params?.suggestedFilename ?? ""),
      }
    case "Browser.downloadProgress":
      return {
        kind: "downloadProgress",
        guid: String(m.params?.guid ?? ""),
        state: (m.params?.state as DownloadRecord["state"]) ?? "inProgress",
      }
    default:
      return { kind: "ignored" }
  }
}

/**
 * Cap on retained download records. A long-lived daemon would otherwise grow
 * this list without bound, one entry per `downloadWillBegin` for the life of
 * the browser. We keep the most recent {@link MAX_DOWNLOAD_RECORDS}, which is
 * far more than the `downloads` route ever needs.
 */
export const MAX_DOWNLOAD_RECORDS = 200

/** Fold a classified download event into the running records list (pure). */
export function applyDownloadEvent(records: DownloadRecord[], ev: Classified): DownloadRecord[] {
  if (ev.kind === "downloadBegin") {
    const next = [
      ...records,
      { guid: ev.guid, url: ev.url, file: ev.file, state: "begin" as const },
    ]
    return next.length > MAX_DOWNLOAD_RECORDS ? next.slice(-MAX_DOWNLOAD_RECORDS) : next
  }
  if (ev.kind === "downloadProgress") {
    return records.map((r) => (r.guid === ev.guid ? { ...r, state: ev.state } : r))
  }
  return records
}
