/**
 * Render the header template. Pure apart from the variable getters.
 *
 * @module header-template/lib/render
 */

import { PromptTemplateError, renderLazy } from "../../ma-template-kit/src/index.ts"

import { buildVars, type VarsInput } from "./vars.ts"

/** The env var the host sets from `--header-format` / config `headerFormat`. */
export const HEADER_FORMAT_ENV = "MINIMAL_AGENT_HEADER_FORMAT"

/** The result of {@link renderHeader}. */
export type HeaderRender =
  | { kind: "off" }
  | { kind: "ok"; text: string }
  | { kind: "error"; message: string }

/**
 * Turn the two-char sequence `\n` into a newline, so a one-line shell
 * argument can hold a multi-line header.
 */
export function unescapeNewlines(template: string): string {
  return template.replaceAll("\\n", "\n")
}

/** Render `template` against the session facts. An empty template is off. */
export function renderHeader(template: string | undefined, input: VarsInput): HeaderRender {
  if (template === undefined || template.trim() === "") return { kind: "off" }
  try {
    const text = renderLazy(unescapeNewlines(template), buildVars(input), { trim: false })
    // Close any open style so the answer below is not tinted.
    return { kind: "ok", text: input.color ? `${text}\x1b[0m` : text }
  } catch (e) {
    if (e instanceof PromptTemplateError) {
      return {
        kind: "error",
        message: `header-format: no value for ${e.missing.map((n) => `%%${n}%%`).join(", ")} (use %%name?%% for optional values)`,
      }
    }
    return {
      kind: "error",
      message: `header-format: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}
