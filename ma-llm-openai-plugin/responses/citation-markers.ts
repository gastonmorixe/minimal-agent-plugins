/**
 * Strip OpenAI citation markers from assistant text.
 *
 * OpenAI models are trained to cite web results with a marker made of three
 * private-use characters:
 *
 *   U+E200 `cite` U+E202 `turn0search0` U+E202 `turn0search1` U+E201
 *
 * ChatGPT replaces the marker with a source chip. Through the API with a
 * custom function tool nothing resolves it (`annotations` stays empty), so the
 * marker reaches the user as unprintable glyphs plus `citeturn0search0`.
 *
 * This filter runs on canonical events, AFTER the network layer handed the
 * raw bytes to its observers. The net-dbg capture and any raw network
 * observer therefore still see what OpenAI sent.
 *
 * Rules:
 * - Only a well-formed marker is dropped. U+E200 is also a Nerd Font glyph, so
 *   a lone or malformed one passes through unchanged.
 * - A marker can be split across deltas. Text from U+E200 is held back until
 *   the marker closes, breaks the grammar, or passes {@link MAX_MARKER_CHARS}.
 * - Held text is never lost: it is flushed unchanged when the block or the
 *   stream ends.
 * - Spaces and tabs directly before a dropped marker are dropped with it.
 *
 * @module llm/providers/openai/responses/citation-markers
 */

import type { CanonicalEvent } from "@minimal-agent/core/plugin-api/llm/canonical-events"

const OPEN = "\uE200"
const SEPARATOR = "\uE202"
const CLOSE = "\uE201"

/** Longest marker (open to close, inclusive) the filter drops or holds back. */
export const MAX_MARKER_CHARS = 256

/** One complete marker: open, a kind word, one or more references, close. */
const COMPLETE_MARKER = new RegExp(
  `^${OPEN}[a-z_]{1,32}(?:${SEPARATOR}[^${OPEN}-${SEPARATOR}\\n]{1,128})+${CLOSE}$`,
)

/** A prefix that can still grow into a complete marker. */
const MARKER_PREFIX = new RegExp(
  `^${OPEN}[a-z_]{0,32}(?:${SEPARATOR}[^${OPEN}-${SEPARATOR}\\n]{0,128})*$`,
)

const TRAILING_BLANKS = /[ \t]+$/

/** Split `text` into its body and its run of trailing spaces and tabs. */
function splitTrailingBlanks(text: string): [body: string, blanks: string] {
  const match = TRAILING_BLANKS.exec(text)
  if (!match) return [text, ""]
  return [text.slice(0, match.index), match[0]]
}

/**
 * Incremental stripper for one text block. Feed it the deltas in order with
 * {@link CitationMarkerStripper.push}, then call
 * {@link CitationMarkerStripper.flush} once at the end of the block.
 */
export class CitationMarkerStripper {
  /** Text not emitted yet: trailing blanks, then an optional open marker. */
  private held = ""

  /**
   * Add a delta.
   *
   * @returns The text that is safe to emit now. It can be empty.
   */
  push(delta: string): string {
    let rest = this.held + delta
    this.held = ""
    let out = ""
    while (rest.length > 0) {
      const open = rest.indexOf(OPEN)
      if (open === -1) {
        // Hold trailing blanks: a marker may start in the next delta.
        const [body, blanks] = splitTrailingBlanks(rest)
        out += body
        this.held = blanks
        break
      }
      const close = rest.indexOf(CLOSE, open + 1)
      const candidate = close === -1 ? rest.slice(open) : rest.slice(open, close + 1)
      if (close === -1 && candidate.length < MAX_MARKER_CHARS && MARKER_PREFIX.test(candidate)) {
        // The marker is still open. Keep it, and the blanks before it.
        const [body, blanks] = splitTrailingBlanks(rest.slice(0, open))
        out += body
        this.held = blanks + candidate
        break
      }
      if (close !== -1 && candidate.length <= MAX_MARKER_CHARS && COMPLETE_MARKER.test(candidate)) {
        out += splitTrailingBlanks(rest.slice(0, open))[0]
        rest = rest.slice(close + 1)
        continue
      }
      // Not a marker: emit the open character as text and scan on.
      out += rest.slice(0, open + 1)
      rest = rest.slice(open + 1)
    }
    return out
  }

  /**
   * End the block.
   *
   * @returns The held text, unchanged. An unfinished marker is not dropped.
   */
  flush(): string {
    const out = this.held
    this.held = ""
    return out
  }
}

/**
 * Strip every complete citation marker from a whole string.
 *
 * @returns `text` without the markers and without the blanks before them.
 */
export function stripCitationMarkersFromText(text: string): string {
  if (!text.includes(OPEN)) return text
  const stripper = new CitationMarkerStripper()
  return stripper.push(text) + stripper.flush()
}

/**
 * Remove citation markers from the text blocks of a canonical event stream.
 * Events other than text events pass through unchanged and in order.
 *
 * @yields The same events, with marker-free `text_delta` and `text_stop`.
 */
export async function* stripCitationMarkers(
  events: AsyncIterable<CanonicalEvent>,
): AsyncIterable<CanonicalEvent> {
  const blocks = new Map<number, CitationMarkerStripper>()

  /**
   * Drain the held text of every open block.
   *
   * @returns One `text_delta` per block that held text.
   */
  const flushAll = (): CanonicalEvent[] => {
    const out: CanonicalEvent[] = []
    for (const [index, stripper] of blocks) {
      const text = stripper.flush()
      if (text) out.push({ type: "text_delta", index, text })
    }
    blocks.clear()
    return out
  }

  for await (const ev of events) {
    switch (ev.type) {
      case "text_delta": {
        let stripper = blocks.get(ev.index)
        if (!stripper) {
          stripper = new CitationMarkerStripper()
          blocks.set(ev.index, stripper)
        }
        const text = stripper.push(ev.text)
        if (text) yield { ...ev, text }
        break
      }
      case "text_stop": {
        const text = blocks.get(ev.index)?.flush()
        blocks.delete(ev.index)
        if (text) yield { type: "text_delta", index: ev.index, text }
        yield ev.finalText === undefined
          ? ev
          : { ...ev, finalText: stripCitationMarkersFromText(ev.finalText) }
        break
      }
      case "text_start":
      case "thinking_start":
      case "tool_use_start":
      case "message_delta":
      case "message_stop":
      case "stream_error":
        // Another block starts, or the message ends. A text block that never
        // got its `text_stop` must deliver its held text first, in order.
        yield* flushAll()
        yield ev
        break
      default:
        yield ev
    }
  }
  yield* flushAll()
}
