/**
 * L0 producer scrub: strip oversized `data:*;base64,…` URIs from Fetch
 * markdown/text output before they reach the agent core.
 *
 * Core also runs an identical safety net (`embedded-payload-scrub` in
 * tool-round). This producer-side pass keeps the default path clean so
 * TUI previews and plugin-local display never see multi-KB base64 even
 * before core touches the result.
 *
 * Kept local to the plugin (no core scrub import). The codec of the
 * session sideband API writes the stub and footer tags (kinds
 * `redacted-asset` and `context-sanitizer`), so they match core.
 *
 * @module lib/data-uri
 */

import type { SidebandApi } from "@minimal-agent/core/plugin-api/types/sideband"

/** The slice of the session sideband API that the scrub uses. */
export type ScrubSideband = Pick<SidebandApi, "ready" | "render" | "trailing">

/** Minimum base64 payload length before a data-URI is redacted. */
export const FETCH_MIN_BASE64_CHARS = 256

// Continuous base64 only — see core embedded-payload-scrub.ts for why
// whitespace inside the payload is unsafe (swallows prose / next words).
const DATA_URI_RE =
  /data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+)((?:;[a-zA-Z0-9=._+-]+)*)?(;base64),([A-Za-z0-9+/=]+)/gi

/**
 * `text` without a self-closing `context-sanitizer` footer at its end. The
 * footer must start a line; the line feeds before it go too. Only the last
 * line is parsed (a page can be large).
 */
export function withoutFooter(text: string, sb: Pick<SidebandApi, "trailing">): string {
  const lineStart = text.trimEnd().lastIndexOf("\n") + 1
  if (lineStart === 0) return text
  const { nodes } = sb.trailing(text.slice(lineStart), { kinds: ["context-sanitizer"] })
  const last = nodes[nodes.length - 1]
  if (last === undefined || !last.selfClosing || last.span.start !== 0) return text
  return text.slice(0, lineStart).replace(/\n+$/u, "")
}

/**
 * Replace oversized data-URIs with `redacted-asset` stubs and add one
 * `context-sanitizer` footer (an old footer at the end is replaced).
 * No-op when nothing matches. Idempotent for already-clean text.
 * With no `sb` or no codec the input does not change: a stub with no tag
 * would remove data with no notice.
 */
export function stripDataUris(
  input: string,
  sb: ScrubSideband | undefined,
  minBase64Chars: number = FETCH_MIN_BASE64_CHARS,
): string {
  if (!input.includes("data:") || sb === undefined || !sb.ready) return input

  let removed = 0
  let charsRemoved = 0
  const text = input.replace(
    DATA_URI_RE,
    (_full, mime: string, _params: string, _flag: string, payload: string) => {
      const b64 = payload.replace(/\s+/g, "")
      if (b64.length < minBase64Chars) return _full
      removed++
      charsRemoved += b64.length
      const approxBytes = Math.floor((b64.length * 3) / 4)
      const size =
        approxBytes >= 1024
          ? `${(approxBytes / 1024).toFixed(1).replace(/\.0$/, "")}KB`
          : `${approxBytes}B`
      return sb.render("redacted-asset", {
        attrs: {
          kind: "data_uri",
          mime: mime.toLowerCase(),
          size,
          "chars-removed": b64.length,
          tool: "Fetch",
        },
      })
    },
  )

  if (removed === 0) return input
  const footer = sb.render("context-sanitizer", {
    attrs: { removed, kinds: "data_uri", "chars-removed": charsRemoved, tool: "Fetch" },
  })
  return `${withoutFooter(text, sb)}\n\n${footer}`
}
