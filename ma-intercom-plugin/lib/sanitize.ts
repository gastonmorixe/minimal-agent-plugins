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

import { MAX_BODY_LEN } from "./envelope.ts"

/**
 * Max length we keep for a single peer-sourced field before clipping.
 *
 * Tied to {@link MAX_BODY_LEN} so a delivered body that survived the send clamp
 * is not re-clipped on the reader side. Safety ceiling against a hostile/
 * corrupt peer record, not a UX limit.
 */
const MAX_FIELD = MAX_BODY_LEN

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

// ---------------------------------------------------------------------------
// Terminal-facing sanitizers (human display, NOT model context)
// ---------------------------------------------------------------------------

/**
 * Make peer text safe to print to a HUMAN terminal.
 *
 * This is a different threat model from {@link sanitizePeerText}. Terminal
 * output never enters a model's context, so the `<ma::` framing declaw and the
 * `<`/`>` → `&lt;`/`&gt;` HTML-escape are wrong here (that escape is what made
 * the arrival box render `&lt;/&gt;` literally). What a terminal DOES need
 * defending against is a peer smuggling raw escape sequences: a hostile body
 * could carry ANSI/OSC/CSI codes to move the cursor, recolor the whole screen,
 * set the window title, or hide a payload. So we strip:
 *
 *   - ESC-introduced sequences (CSI `\x1b[…`, OSC `\x1b]…`, and any other
 *     `\x1b`-led control), and a bare CSI/OSC via the C1 byte,
 *   - other C0 control chars except the ones a multi-line body legitimately
 *     uses (`\n`, `\t`).
 *
 * The frame color/glyphs the user sees come from OUR trusted styling around
 * this text, never from the peer. Clips to {@link MAX_FIELD}. Newlines kept.
 */
export function sanitizeTerminalText(input: string): string {
  const clipped = input.length > MAX_FIELD ? `${input.slice(0, MAX_FIELD)}…[clipped]` : input
  return (
    clipped
      // ESC-led sequences: CSI (`\x1b[`…final), OSC (`\x1b]`…BEL or ST), and any
      // other single ESC-led control. Order matters: match the longer forms first.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point.
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "") // OSC … BEL/ST
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point.
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]?/g, "") // CSI
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point.
      .replace(/\x1b./g, "") // any other ESC-led pair
      // Bare C1 CSI/OSC introducers (0x9b / 0x9d) a peer might use to bypass ESC.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point.
      .replace(/[\x9b\x9d][^\x07]*\x07?/g, "")
      // Remaining C0/C1 controls except \t (\x09) and \n (\x0a).
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point.
      .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
  )
}

/** Terminal-safe + collapse to a single line (for the arrival header row). */
export function sanitizeTerminalLine(input: string): string {
  return sanitizeTerminalText(input.replace(/\s+/g, " ").trim())
}
