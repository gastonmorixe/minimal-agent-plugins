/**
 * Output cap for hook context and reasons (SPEC.md "Output cap"): text over
 * the cap is saved to a file and a 2,000-char preview is kept.
 *
 * The plugin API has no session blob store port today, so the full text goes
 * to `<agent home>/hooks-output/<sha256>.txt`.
 *
 * @module engine/output-cap
 */

import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** Preview length kept when text is over the cap. */
export const PREVIEW_CHARS = 2000

/**
 * Cap one text. Returns it unchanged when within `cap`. Otherwise saves the
 * full text under `outDir` (when given) and returns a preview plus a note.
 */
export function capText(text: string, cap: number, outDir?: string): string {
  if (text.length <= cap) return text
  let where = "not saved"
  if (outDir) {
    try {
      const sha = createHash("sha256").update(text).digest("hex").slice(0, 16)
      mkdirSync(outDir, { recursive: true })
      const path = join(outDir, `${sha}.txt`)
      writeFileSync(path, text)
      where = `full text at ${path}`
    } catch {
      // keep the preview even when the save fails
    }
  }
  return `${text.slice(0, PREVIEW_CHARS)}\n[hook output truncated: ${text.length} chars, ${where}]`
}
