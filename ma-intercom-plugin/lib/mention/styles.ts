/**
 * Pure buffer-style computation for at-mention tokens.
 *
 * For each at-token in the buffer that matches at least one peer (score \>= 0
 * against the full token body after the at-sign), emit a span covering the whole
 * `at-token` with violet/purple bold SGR. Clear styles when no matches.
 *
 * Handlers emit the spans on `editor.buffer.styles` (core channel being
 * wired in parallel). Pure code does not talk to the host.
 *
 */

import { scorePeer } from "./overlay.ts"
import { mentionTokenSgr } from "./palette.ts"
import type { BufferStyleSpan, PeerCandidate } from "./types.ts"

/** Match every `at-token` (including empty body after a lone `@`). */
const TOKEN_RE = /(^|[\s([{])@([A-Za-z0-9_-]*)/g

/**
 * Compute style spans for matching at-tokens in `text`.
 *
 * A token matches when `scorePeer` returns a non-null result for the body
 * (empty body → every peer matches with score 0, so we still highlight a
 * lone `@` only when peers exist — call sites can pass an empty peer list
 * to clear).
 */
export function mentionStyleSpans(
  text: string,
  peers: readonly PeerCandidate[],
  sgr: string = mentionTokenSgr(),
): BufferStyleSpan[] {
  if (!text || peers.length === 0) return []

  const spans: BufferStyleSpan[] = []
  const re = new RegExp(TOKEN_RE.source, "g")
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const prefix = m[1] ?? ""
    const body = m[2] ?? ""
    const at = m.index + prefix.length
    const end = at + 1 + body.length

    // Require at least one peer match for the body. Empty body highlights
    // only when peers exist (autocomplete is openable).
    let matched = false
    if (body === "") {
      matched = peers.length > 0
    } else {
      for (const peer of peers) {
        if (scorePeer(peer, body) !== null) {
          matched = true
          break
        }
      }
    }
    if (matched) spans.push({ start: at, end, style: sgr })
  }
  return spans
}
