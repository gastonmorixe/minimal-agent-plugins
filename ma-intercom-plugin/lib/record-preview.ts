/**
 * Build the one-line preview text of a session record from the data the host
 * gives (`RecordView.parts`). Core holds no prefix text, so this plugin adds
 * it. Same prefix rules as the session-history plugin (kept local: a plugin
 * cannot import another plugin). Pure.
 *
 * @module lib/record-preview
 */

import type { BodyPart } from "./host-types.ts"

function partText(p: BodyPart): string {
  switch (p.kind) {
    case "thinking":
      return `[thinking] ${p.text}`
    case "tool_use":
      return `[tool_use ${p.toolName}] ${p.text}`
    case "message":
      return `${p.role}: ${p.text}`
    default:
      return p.text
  }
}

/** Full body text (not clipped): prefixed parts joined by a newline. */
export function bodyFromParts(parts: readonly BodyPart[]): string {
  return parts.map(partText).join("\n")
}
