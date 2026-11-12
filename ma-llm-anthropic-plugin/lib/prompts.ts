// source: plugin-api-adjacent core src/prompts/prompts.ts (vendored minimal slice for Wave G self-containment)
/**
 * Minimal `%%name%%` templating for the Anthropic plugin's own `prompts/` dir
 * (identity.claude-code.md, billing.tmpl.md). A repo-separated plugin cannot
 * import core `src/prompts/prompts.ts`, so the tiny slice it needs (the
 * `%%name%%` substitution) is vendored here. The prompt text itself arrives
 * through `with { type: "text" }` imports at the call site, never a disk read,
 * so it works the same from the checkout and from a compiled binary.
 *
 * @module lib/prompts
 */

/** Matches `%%name%%` (required) and `%%name?%%` (optional). */
const PLACEHOLDER_RE = /%%([A-Za-z0-9_.-]+)(\?)?%%/g

/** A value that can be substituted into a template placeholder. */
export type PromptVar = string | number | boolean | null | undefined

/** Variable bag passed to {@link renderTemplate}. */
export type PromptVars = Record<string, PromptVar>

/** Thrown when a REQUIRED `%%name%%` placeholder has no supplied value. */
export class PromptTemplateError extends Error {
  readonly missing: string[]
  readonly source?: string
  constructor(missing: string[], source?: string) {
    const where = source ? ` in ${source}` : ""
    super(`prompt template${where} is missing required variable(s): ${missing.join(", ")}`)
    this.name = "PromptTemplateError"
    this.missing = missing
    this.source = source
  }
}

/** Options for {@link renderTemplate}. */
export interface RenderOptions {
  trim?: boolean
  source?: string
}

/** Render a template string by substituting `%%name%%` placeholders. Pure (no IO). */
export function renderTemplate(
  template: string,
  vars: PromptVars = {},
  opts: RenderOptions = {},
): string {
  const missing = new Set<string>()
  let droppedOptional = false
  const rendered = template.replace(PLACEHOLDER_RE, (full, rawName: string, optional?: string) => {
    const value = vars[rawName]
    const present = value !== undefined && value !== null
    if (present) return String(value)
    if (optional) {
      droppedOptional = true
      return ""
    }
    missing.add(rawName)
    return full
  })
  if (missing.size > 0) throw new PromptTemplateError([...missing], opts.source)
  let out = rendered
  if (droppedOptional) {
    out = out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n")
  }
  return opts.trim === false ? out : out.trim()
}
