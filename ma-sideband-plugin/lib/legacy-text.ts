import type { SidebandNode } from "./types.ts"

/**
 * Old bracket notices (design 40, section 2b). Read only: no code renders
 * them here. A notice is form `v1-text`. It counts only after 2 line feeds,
 * because `[note:` can occur in normal text.
 */
const LEGACY_TEXT: readonly { prefix: string; kind: string }[] = [
  { prefix: "[truncated:", kind: "output-truncated" },
  { prefix: "[note:", kind: "output-streak" },
]

/** The join before a notice. */
export const LEGACY_TEXT_JOIN = "\n\n"

/** The prefixes with the join, for a search from the end. */
export const LEGACY_TEXT_PROBES: readonly string[] = LEGACY_TEXT.map(
  (l) => `${LEGACY_TEXT_JOIN}${l.prefix}`,
)

function closeOf(text: string, from: number): number {
  // The notice ends at the `]` that closes its `[`, on the same line. A line
  // feed before it means no notice here (-1). Reads one line only: linear.
  let depth = 0
  for (let i = from; i < text.length; i++) {
    const c = text.charAt(i)
    if (c === "\n") return -1
    if (c === "[") depth++
    else if (c === "]") {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return -1
}

/** Read the old bracket notices of `text` (each after 2 line feeds). */
export function readLegacyText(text: string): SidebandNode[] {
  const out: SidebandNode[] = []
  for (const l of LEGACY_TEXT) {
    const probe = `${LEGACY_TEXT_JOIN}${l.prefix}`
    let from = 0
    for (;;) {
      const at = text.indexOf(probe, from)
      if (at < 0) break
      const start = at + LEGACY_TEXT_JOIN.length
      const end = closeOf(text, start)
      if (end < 0) {
        // Not closed on its line: no notice here. Look for a later one.
        from = start
        continue
      }
      out.push({
        kind: l.kind,
        attrs: {},
        body: text.slice(start + l.prefix.length, end - 1).trim(),
        selfClosing: true,
        form: "v1-text",
        span: { start, end },
        open: { start, end },
      })
      from = end
    }
  }
  return out.sort((a, b) => a.span.start - b.span.start)
}

/**
 * The starts of the trailing annotations of a tool result, with their join.
 * Same list as the core and CLI prefix lists (tool-preview-budget.ts:44-59,
 * session-replay-derivers.ts:88-102), in one place.
 */
const PROBES: readonly string[] = [
  ...LEGACY_TEXT_PROBES,
  "\n\n<ma::agent::output-preview",
  "\n\n<ma::agent::diagnostics",
  "\n\n<ma::agent::mode-active",
  "\n\n<ma::tui-preview",
]

/**
 * Start of the annotation region at the end of `text`, or `text.length` when
 * there is none. The earliest last occurrence of a probe. Linear, from the
 * end, builds no node.
 *
 * A hint only; a caller must verify the nodes after the cut. The probes are
 * text matches, so a probe inside tool output (not an annotation) also moves
 * the cut. Core does this check since commit 9d50dfb0.
 */
export function trailingStart(text: string): number {
  let earliest = -1
  for (const p of PROBES) {
    const i = text.lastIndexOf(p)
    if (i >= 0 && (earliest < 0 || i < earliest)) earliest = i
  }
  return earliest < 0 ? text.length : earliest
}
