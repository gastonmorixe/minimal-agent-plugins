/**
 * Paste refs in the title text.
 *
 * The paste plugin (`ma-paste-plugin`) keeps a large paste in a session file
 * and puts a short ref node in the prompt text. The paste plugin expands the
 * ref only for the main model (`message.willSend`). The `prompt.submitted`
 * text that the title plugin gets still has the ref. Thus the title plugin
 * asks core for the text of each ref: `ctx.sideband.display` in full mode,
 * with the sid and a byte cap. Core calls the display handler of the paste
 * plugin. That handler checks the id and the sid and reads the file. The
 * title plugin reads no file and knows no path.
 *
 * Rules:
 * - The call asks only for the paste kind. Each other node stays in the text
 *   as it is, so the tag strip after this step removes it. The display label
 *   of another kind never goes to the model.
 * - The display text is not neutralized: it can hold a sideband tag. The
 *   caller must run the tag strip after this step (`cleanPromptText`).
 * - A ref with a body gives its body. A ref with `missing: true`, with no
 *   text, with no display, or a host with no `display` (an old host) gives
 *   {@link PASTE_MISSING_MARKER}.
 * - Each text has a maximum of {@link PASTE_MAX_CHARS} code points, then
 *   {@link PASTE_CUT_MARKER}. A text that core marks `truncated` also gets
 *   the marker.
 *
 * @module lib/paste
 */

import type { SidebandNodeView, TitleSideband } from "./host-types.ts"

/** The sideband kind of a paste ref (declared by `ma-paste-plugin`). */
export const PASTE_KIND = "paste"

/** Max code points of the text of one paste. */
export const PASTE_MAX_CHARS = 600

/**
 * The byte cap of one display call (`maxBytes`). A UTF-8 code point has 4
 * bytes or fewer, and CRLF gives one code point for 2 bytes. Thus this many
 * bytes always give more than {@link PASTE_MAX_CHARS} code points when the
 * file is longer.
 */
export const PASTE_DISPLAY_BYTES = 8192

/** The text after the head of a long paste. */
export const PASTE_CUT_MARKER = "(rest of the pasted text omitted)"

/** The text in place of a ref with no readable file. */
export const PASTE_MISSING_MARKER = "(pasted text)"

/** Change CRLF and CR to LF, then keep the head of a long text. */
function capPaste(text: string, truncated: boolean): string {
  const points = Array.from(text.replace(/\r\n?/g, "\n"))
  if (points.length <= PASTE_MAX_CHARS && !truncated) return points.join("")
  return `${points.slice(0, PASTE_MAX_CHARS).join("")}\n${PASTE_CUT_MARKER}`
}

/** The text of one paste node with no display: its body, else the marker. */
function fallbackText(node: SidebandNodeView): string {
  return node.selfClosing ? PASTE_MISSING_MARKER : capPaste(node.body ?? "", false)
}

/** Put the marker (or the body) in place of each paste ref. */
function withoutDisplay(text: string, sb: TitleSideband): string {
  return sb.replace(text, fallbackText, { kinds: [PASTE_KIND] })
}

/**
 * Put the text of each paste ref of `text` in place of the ref. See the
 * module doc for the rules.
 *
 * @param text - The prompt text, after the `&name` tokens are gone.
 * @param sb - The session sideband API.
 * @param sid - The captured sid. Absent: the handler has no file to read.
 * @returns The text with no paste ref. Other nodes stay.
 */
export function expandPasteRefs(text: string, sb: TitleSideband, sid: string | undefined): string {
  if (!sb.has(text, { kinds: [PASTE_KIND] })) return text
  const display = sb.display
  if (typeof display !== "function") return withoutDisplay(text, sb)
  let segments: ReturnType<NonNullable<TitleSideband["display"]>>["segments"]
  try {
    segments = display.call(sb, text, {
      mode: "full",
      ...(sid !== undefined ? { sid } : {}),
      maxBytes: PASTE_DISPLAY_BYTES,
      kinds: [PASTE_KIND],
    }).segments
  } catch {
    return withoutDisplay(text, sb)
  }
  const out: string[] = []
  for (const seg of segments) {
    if (seg.type === "text") {
      // A paste node with no display stays in a text segment. Only the
      // source text is parsed again, never the inserted paste text.
      out.push(withoutDisplay(seg.text, sb))
      continue
    }
    if (seg.kind !== PASTE_KIND) {
      // A host that ignores `kinds`: keep the source text for the tag strip.
      out.push(text.slice(seg.node.span.start, seg.node.span.end))
      continue
    }
    const d = seg.display
    if (d.missing === true || typeof d.text !== "string") {
      out.push(fallbackText(seg.node))
      continue
    }
    out.push(capPaste(d.text, d.truncated === true))
  }
  return out.join("")
}
