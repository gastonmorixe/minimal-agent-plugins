/**
 * The `%%name%%` template engine. Pure, no IO.
 *
 * @module ma-prompt-template-plugin/template
 */

/** Matches `%%name%%` (required) and `%%name?%%` (optional). */
export const PLACEHOLDER_RE = /%%([A-Za-z0-9_.-]+)(\?)?%%/g

/** Variable values for a render. A null or undefined value counts as absent. */
export type TemplateVars = Readonly<Record<string, string | number | boolean | null | undefined>>

/** Options for {@link renderTemplate}. */
export interface RenderTemplateOptions {
  /** Trim the final string. Default true. */
  trim?: boolean
  /** Source path, used only in the error message. */
  source?: string
}

/** Thrown when required placeholders have no value. Lists every missing name. */
export class PromptTemplateError extends Error {
  /** The required placeholder names with no value. */
  readonly missing: string[]
  /** Absolute path of the template file, when known. */
  readonly source?: string

  constructor(missing: string[], source?: string) {
    const where = source ? ` in ${source}` : ""
    super(`prompt template${where} is missing required variable(s): ${missing.join(", ")}`)
    this.name = "PromptTemplateError"
    this.missing = missing
    this.source = source
  }
}

/**
 * Substitute placeholders in `template`.
 *
 * @throws PromptTemplateError when a required placeholder has no value.
 */
export function renderTemplate(
  template: string,
  vars: TemplateVars = {},
  opts: RenderTemplateOptions = {},
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

  if (missing.size > 0) {
    throw new PromptTemplateError([...missing], opts.source)
  }

  // Normalize whitespace only when an optional slot emptied, so templates
  // without optional slots stay byte-identical to their source.
  let out = rendered
  if (droppedOptional) {
    out = out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n")
  }
  return opts.trim === false ? out : out.trim()
}
