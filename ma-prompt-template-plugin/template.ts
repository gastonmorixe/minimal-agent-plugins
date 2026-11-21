/**
 * The `%%name%%` template engine and the `%%sideband:...%%` call engine. The
 * code lives in `ma-template-kit`; this module re-exports it so the plugin's
 * imports stay the same.
 *
 * @module ma-prompt-template-plugin/template
 */

export {
  type ExpandTemplateContext,
  expandTemplate,
  PLACEHOLDER_RE,
  PromptTemplateError,
  PromptTemplateSyntaxError,
  type RenderTemplateOptions,
  renderTemplate,
  type TemplateVars,
} from "../ma-template-kit/src/index.ts"
