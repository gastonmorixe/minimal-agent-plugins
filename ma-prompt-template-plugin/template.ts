/**
 * The `%%name%%` template engine. The code lives in `ma-template-kit`; this
 * module re-exports it so the plugin's imports stay the same.
 *
 * @module ma-prompt-template-plugin/template
 */

export {
  PLACEHOLDER_RE,
  PromptTemplateError,
  type RenderTemplateOptions,
  renderTemplate,
  type TemplateVars,
} from "../ma-template-kit/src/index.ts"
