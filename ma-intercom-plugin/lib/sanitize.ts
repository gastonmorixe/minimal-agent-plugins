/**
 * Neutralize peer-controlled text before it enters another session's trusted
 * model context.
 *
 * Intercom carries messages between independent sessions. A message body, and a
 * sender's self-reported identity fields (short id, model, cwd), and a peer's
 * activity label are all written by a DIFFERENT process we don't trust. If we
 * splice them verbatim into the `<ma::agent::intercom-inbox>` attachment, the
 * roster/inspect renders, or a `prompt.inject` nudge, a hostile or careless peer
 * could:
 *
 *   - emit a forged `</ma::agent::intercom-inbox>` to break out of the data
 *     block, or
 *   - emit a fake `<ma::agent::...>` / `<ma::sys::...>` block to impersonate a
 *     trusted runtime/system instruction in the reader's context.
 *
 * The defense: the `<ma::` sigil is what the host's scanner and the model treat
 * as authoritative framing, so we declaw exactly that sequence (and stray angle
 * brackets that could start a tag) in any peer-sourced string. We keep it
 * readable rather than aggressively stripping: `<ma::` becomes a visibly inert
 * `‹ma::` look-alike, and bare `<`/`>` are escaped to their HTML entities so the
 * text still reads naturally but can never be parsed as a tag.
 *
 * Pure. Applied at every boundary where peer text crosses into model-facing
 * output (see render.ts, beat.ts).
 *
 * @module lib/sanitize
 */

/** Max length we keep for a single peer-sourced field before clipping. */
const MAX_FIELD = 4_000

/**
 * Make one line of peer-controlled text safe to embed in model-facing output.
 *
 * - Neutralizes the `<ma::` framing sigil (case-insensitive) so no peer string
 *   can forge or close a `<ma::...>` block.
 * - Escapes any remaining `<` / `>` so a stray angle bracket can't begin a tag.
 * - Clips to {@link MAX_FIELD} so one field can't dominate the reader's context.
 *
 * Newlines are preserved (callers that need a single line strip them first).
 */
export function sanitizePeerText(input: string): string {
  const clipped = input.length > MAX_FIELD ? `${input.slice(0, MAX_FIELD)}…[clipped]` : input
  return (
    clipped
      // Declaw the authoritative framing sigil first (covers both openers and
      // closers, since both start with `<` + optional `/` + `ma::`).
      .replace(/<(\/?)ma::/gi, "‹$1ma::")
      // Escape any other angle brackets so nothing else can parse as a tag.
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
  )
}

/** Sanitize + collapse to a single line (for headers, labels, nudges). */
export function sanitizePeerLine(input: string): string {
  return sanitizePeerText(input.replace(/\s+/g, " ").trim())
}
