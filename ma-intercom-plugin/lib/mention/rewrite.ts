/**
 * Pure rewrite: expand resolved at-tokens in buffer text into peer XML for
 * the model path (turn.willStart chain).
 *
 * Display / scrollback keep the original at-token; only the model-facing
 * text is rewritten via formatPeerMentionXml (see PROMPTS.ts).
 *
 * Rules:
 *   - Replace only tokens that uniquely resolve (or have a single best match).
 *   - Unmatched / ambiguous at-tokens left as-is.
 *   - XML attrs escaped. Body is the original at-token.
 */

import { peerSlug, scorePeer } from "./overlay.ts"
import { formatPeerMentionXml } from "./PROMPTS.ts"
import type { PeerCandidate } from "./types.ts"

/** Match every `at-token` in a buffer (not just the active one under the cursor). */
const TOKEN_RE = /(^|[\s([{])@([A-Za-z0-9_-]+)/g

/**
 * Resolve `body` (the text after `@`) against peers.
 *
 * Unique when exactly one peer matches with score \>= 0, or when multiple match
 * but exactly one is an exact name / exact short / exact full-sid hit.
 * Ambiguous when 2+ peers share the best tier without an exact winner.
 */
export function resolveMentionPeer(
  body: string,
  peers: readonly PeerCandidate[],
): PeerCandidate | null {
  if (!body) return null
  const lower = body.toLowerCase()

  // Exact name (case-insensitive).
  const exactName = peers.filter((p) => p.name?.toLowerCase() === lower)
  if (exactName.length === 1) return exactName[0]!
  if (exactName.length > 1) return null // ambiguous exact names

  // Exact short sid.
  const exactShort = peers.filter((p) => p.short.toLowerCase() === lower)
  if (exactShort.length === 1) return exactShort[0]!
  if (exactShort.length > 1) return null

  // Exact full sid.
  const exactSid = peers.filter((p) => p.sid.toLowerCase() === lower)
  if (exactSid.length === 1) return exactSid[0]!

  // Prefix / fuzzy: collect positive scores.
  const scored: { peer: PeerCandidate; score: number }[] = []
  for (const peer of peers) {
    const s = scorePeer(peer, body)
    if (s && s.score >= 0) scored.push({ peer, score: s.score })
  }
  if (scored.length === 0) return null
  if (scored.length === 1) return scored[0]!.peer

  // Prefer unique prefix of name or short.
  const namePrefix = peers.filter(
    (p) => p.name !== undefined && p.name.toLowerCase().startsWith(lower),
  )
  if (namePrefix.length === 1) return namePrefix[0]!
  const shortPrefix = peers.filter((p) => p.short.toLowerCase().startsWith(lower))
  if (shortPrefix.length === 1) return shortPrefix[0]!
  const sidPrefix = peers.filter((p) => p.sid.toLowerCase().startsWith(lower))
  if (sidPrefix.length === 1) return sidPrefix[0]!

  // Unique top score wins; ties stay unresolved.
  scored.sort((a, b) => b.score - a.score)
  if (scored[0]!.score > scored[1]!.score) return scored[0]!.peer
  return null
}

/**
 * Build the peer XML tag for a resolved mention.
 * Delegates to {@link formatPeerMentionXml} so the wire form lives in PROMPTS.
 */
export function peerXml(peer: PeerCandidate, originalToken: string): string {
  return formatPeerMentionXml({
    sid: peer.sid,
    ...(peer.name ? { name: peer.name } : {}),
    body: originalToken,
  })
}

// Re-export escape helpers for tests / callers that previously imported from here.
export { escapeXmlAttr } from "./PROMPTS.ts"

/**
 * Rewrite every uniquely-resolved `at-token` in `text` to peer XML.
 * Unmatched / ambiguous tokens are left as-is.
 */
export function rewriteMentions(text: string, peers: readonly PeerCandidate[]): string {
  if (!text || peers.length === 0) return text

  // Walk with a fresh regex each call (global lastIndex).
  const re = new RegExp(TOKEN_RE.source, "g")
  let out = ""
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const prefix = m[1] ?? ""
    const body = m[2] ?? ""
    // Absolute start of `@`.
    const at = m.index + prefix.length
    const tokenEnd = at + 1 + body.length
    const original = text.slice(at, tokenEnd) // `@body`

    const peer = resolveMentionPeer(body, peers)
    out += text.slice(last, at)
    if (peer) {
      out += peerXml(peer, original)
    } else {
      out += original
    }
    last = tokenEnd
  }
  out += text.slice(last)
  return out
}

// Re-export for consumers that only need the slug helper.
export { peerSlug }
