/**
 * Pure rewrite: expand resolved `&name` tokens into the prompt body for the
 * model path only.
 *
 * Display and scrollback keep the original `&name` token. Only the
 * model-facing text is rewritten via the `turn.willStart` chain hook, the
 * same seam the intercom plugin uses for `@Name`.
 *
 * Rules:
 *   - Replace only tokens that uniquely resolve (exact or single best match).
 *   - Unmatched / ambiguous tokens are left as-is, so a stray `&` never
 *     destroys the message.
 *   - Idempotent: an already-expanded body contains no `&name` token, and the
 *     regex only matches `&` at a word boundary.
 *
 * @module lib/rewrite
 */

import type { Prompt } from "./store.ts"

/** Match every `&token` at a word boundary (not just the one at the cursor). */
export const TOKEN_RE = /(^|[\s([{])&([a-zA-Z0-9_-]+)/g

/**
 * Resolve `body` (the text after `&`) against the library.
 *
 * Exact (case-insensitive) match wins. Otherwise a single positive-scored
 * prefix match wins. Ambiguous matches stay unresolved.
 */
export function resolvePromptToken(body: string, prompts: readonly Prompt[]): Prompt | null {
  if (!body) return null
  const lower = body.toLowerCase()

  const exact = prompts.filter((p) => p.slug.toLowerCase() === lower)
  if (exact.length === 1) return exact[0]!
  if (exact.length > 1) return null

  const prefix = prompts.filter((p) => p.slug.toLowerCase().startsWith(lower))
  if (prefix.length === 1) return prefix[0]!

  return null
}

/**
 * Rewrite every uniquely-resolved `&token` in `text` to the prompt body.
 * Unmatched / ambiguous tokens are left as-is.
 */
export function rewritePrompts(text: string, prompts: readonly Prompt[]): string {
  if (!text || prompts.length === 0) return text

  const re = new RegExp(TOKEN_RE.source, "g")
  let out = ""
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const prefix = m[1] ?? ""
    const body = m[2] ?? ""
    const amp = m.index + prefix.length
    const tokenEnd = amp + 1 + body.length
    const original = text.slice(amp, tokenEnd)

    const prompt = resolvePromptToken(body, prompts)
    out += text.slice(last, amp)
    out += prompt ? prompt.body : original
    last = tokenEnd
  }
  out += text.slice(last)
  return out
}
