// source: plugin-api-adjacent core src/prompts/prompts.ts (vendored minimal slice for Wave G self-containment)
/**
 * Minimal prompt loader + `%%name%%` templating for the Anthropic plugin's own
 * `prompts/` dir (identity.claude-code.md, billing.tmpl.md). A repo-separated
 * plugin cannot import core `src/prompts/prompts.ts`, so the tiny slice it needs
 * (renderPrompt + promptPath + the `%%name%%` substitution) is vendored here.
 *
 * @module lib/prompts
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** Matches `%%name%%` (required) and `%%name?%%` (optional). */
const PLACEHOLDER_RE = /%%([A-Za-z0-9_.-]+)(\?)?%%/g

/** A value that can be substituted into a template placeholder. */
export type PromptVar = string | number | boolean | null | undefined

/** Variable bag passed to {@link renderTemplate} / {@link renderPrompt}. */
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

/** Options for {@link renderTemplate} / {@link renderPrompt}. */
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

/** In-process cache of raw file contents, keyed by absolute path. */
const fileCache = new Map<string, string>()

/** Read a prompt file's raw text, memoized by absolute path. */
export function loadPromptText(absPath: string): string {
  const cached = fileCache.get(absPath)
  if (cached !== undefined) return cached
  const text = readFileSync(absPath, "utf-8")
  fileCache.set(absPath, text)
  return text
}

/** Load a prompt file and render its placeholders in one step. */
export function renderPrompt(
  absPath: string,
  vars: PromptVars = {},
  opts: RenderOptions = {},
): string {
  return renderTemplate(loadPromptText(absPath), vars, { ...opts, source: opts.source ?? absPath })
}

/** Resolve an absolute path to a prompt file relative to the CALLING module. */
export function promptPath(meta: ImportMeta, ...segments: string[]): string {
  const dir = meta.dirname ?? dirname(fileURLToPath(meta.url))
  return join(dir, ...segments)
}

/** Clear the raw-file cache. Tests only. */
export function clearPromptCache(): void {
  fileCache.clear()
}
