/**
 * Public entry of `ma-template-kit`.
 *
 * @module ma-template-kit
 */

export {
  type LazyVar,
  type LazyVars,
  PLACEHOLDER_RE,
  type Placeholder,
  PromptTemplateError,
  type RenderTemplateOptions,
  renderLazy,
  renderTemplate,
  scanPlaceholders,
  type TemplateVar,
  type TemplateVars,
} from "./template.ts"
