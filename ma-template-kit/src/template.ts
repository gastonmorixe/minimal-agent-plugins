/**
 * The `%%name%%` template engine. Pure, no IO.
 *
 * Grammar:
 *
 * - `%%name%%` is required. A missing, `null`, or `undefined` value throws
 *   {@link PromptTemplateError}.
 * - `%%name?%%` is optional. A missing value renders as the empty string.
 *   When an optional slot empties, trailing spaces before a newline are
 *   removed and runs of 3+ newlines collapse to 2, so a line-only slot
 *   leaves no blank-line scar.
 * - `name` matches `[A-Za-z0-9_.-]+`, so dotted names like `sid.short` work.
 *
 * There is no escape syntax. A template cannot hold a literal `%%name%%` for
 * a name that is a valid placeholder.
 *
 * @module ma-template-kit/template
 */

/** Matches `%%name%%` (required) and `%%name?%%` (optional). */
export const PLACEHOLDER_RE = /%%([A-Za-z0-9_.-]+)(\?)?%%/g

/** One variable value. A null or undefined value counts as absent. */
export type TemplateVar = string | number | boolean | null | undefined

/** Variable values for a render. */
export type TemplateVars = Readonly<Record<string, TemplateVar>>

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

  /**
   * Build the error message from the missing names.
   *
   * @param missing - Required placeholder names with no value.
   * @param source - Template path, when known.
   */
  constructor(missing: string[], source?: string) {
    const where = source ? ` in ${source}` : ""
    super(`prompt template${where} is missing required variable(s): ${missing.join(", ")}`)
    this.name = "PromptTemplateError"
    this.missing = missing
    this.source = source
  }
}

/** One placeholder found by {@link scanPlaceholders}. */
export interface Placeholder {
  /** The variable name. */
  name: string
  /** True when every use of the name is optional (`%%name?%%`). */
  optional: boolean
}

/**
 * List the placeholders of a template, in first-use order, one entry per
 * name. A name used both ways counts as required.
 */
export function scanPlaceholders(template: string): Placeholder[] {
  const order: string[] = []
  const required = new Set<string>()
  for (const m of template.matchAll(new RegExp(PLACEHOLDER_RE.source, "g"))) {
    const name = m[1] ?? ""
    if (!order.includes(name)) order.push(name)
    if (!m[2]) required.add(name)
  }
  return order.map((name) => ({ name, optional: !required.has(name) }))
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

/** A variable whose value is computed only when a template uses it. */
export type LazyVar = TemplateVar | (() => TemplateVar)

/** Lazy variables for {@link renderLazy}. */
export type LazyVars = Readonly<Record<string, LazyVar>>

/**
 * Render with lazy variables: only the names the template uses are
 * computed, each once. A function that throws counts as absent.
 *
 * @throws PromptTemplateError when a required placeholder has no value.
 */
export function renderLazy(
  template: string,
  vars: LazyVars,
  opts: RenderTemplateOptions = {},
): string {
  const resolved: Record<string, TemplateVar> = {}
  for (const { name } of scanPlaceholders(template)) {
    if (!Object.hasOwn(vars, name)) continue
    const v = vars[name]
    if (typeof v !== "function") {
      resolved[name] = v
      continue
    }
    try {
      resolved[name] = v()
    } catch {
      resolved[name] = undefined
    }
  }
  return renderTemplate(template, resolved, opts)
}
