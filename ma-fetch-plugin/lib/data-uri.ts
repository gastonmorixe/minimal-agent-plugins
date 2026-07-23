/**
 * L0 producer scrub: strip oversized `data:*;base64,…` URIs from Fetch
 * markdown/text output before they reach the agent core.
 *
 * Core also runs an identical safety net (`embedded-payload-scrub` in
 * tool-round). This producer-side pass keeps the default path clean so
 * TUI previews and plugin-local display never see multi-KB base64 even
 * before core touches the result.
 *
 * Kept local to the plugin (no core import) — plugins must run without a
 * core workspace link. Stub tag names match core so greps / model
 * instructions stay consistent.
 *
 * @module lib/data-uri
 */

/** Minimum base64 payload length before a data-URI is redacted. */
export const FETCH_MIN_BASE64_CHARS = 256

// Continuous base64 only — see core embedded-payload-scrub.ts for why
// whitespace inside the payload is unsafe (swallows prose / next words).
const DATA_URI_RE =
  /data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+)((?:;[a-zA-Z0-9=._+-]+)*)?(;base64),([A-Za-z0-9+/=]+)/gi

/**
 * Replace oversized data-URIs with `<ma::agent::redacted-asset …/>` stubs.
 * No-op when nothing matches. Idempotent for already-clean text.
 */
export function stripDataUris(
  input: string,
  minBase64Chars: number = FETCH_MIN_BASE64_CHARS,
): string {
  if (!input.includes("data:")) return input

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
      return (
        `<ma::agent::redacted-asset kind="data_uri" mime="${mime.toLowerCase()}" ` +
        `size="${size}" chars_removed="${b64.length}" tool="Fetch" />`
      )
    },
  )

  if (removed === 0) return input
  const withoutPrior = text.replace(/\n*\n<ma::agent::context-sanitizer\b[^>]*\/>\s*$/u, "")
  return (
    `${withoutPrior}\n\n` +
    `<ma::agent::context-sanitizer removed="${removed}" kinds="data_uri" ` +
    `chars_removed="${charsRemoved}" tool="Fetch" />`
  )
}
