const OPEN = "(?:<|\\uFF1C|\\uFE64|\\u2039|\\u2329|\\u3008|\\u276E|\\u02C2|&lt;|&#0*60;|&#x0*3c;)"
const WS = "[ \\t\\r\\n]*"
const PREFIX = "(?:ma|\\uFF4D\\uFF41)"
const COLON = "(?:[:\\uFF1A\\uFE55])"
const BARE = "(?:mode-change|memory-saved|short-term-memory|tui-preview)"
const SIGIL_RE = new RegExp(`${OPEN}(?=${WS}(?:/${WS})?(?:${PREFIX}${WS}${COLON}|${BARE}))`, "giu")

/**
 * Defang every sideband sigil (SB-NEU-1 to SB-NEU-4). Replaces only the
 * n-open part with `&lt;`. Idempotent. Text with no sigil is unchanged.
 */
export function neutralizeText(untrusted: string): string {
  return untrusted.replace(SIGIL_RE, "&lt;")
}
