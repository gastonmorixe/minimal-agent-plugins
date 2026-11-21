/**
 * Public entry of `ma-template-kit`.
 *
 * @module ma-template-kit
 */

export {
  type ExpandTemplateContext,
  type ExpandTemplateOptions,
  expandTemplate,
  parseSidebandCall,
  SIDEBAND_OPS,
  type SidebandCall,
  type SidebandCallAttr,
  type SidebandCallMessage,
  type SidebandCallValue,
  type SidebandOp,
  type TemplateSideband,
} from "./calls.ts"
export {
  type LazyVar,
  type LazyVars,
  PLACEHOLDER_RE,
  type Placeholder,
  PromptTemplateError,
  PromptTemplateSyntaxError,
  type RenderTemplateOptions,
  renderLazy,
  renderTemplate,
  scanPlaceholders,
  type TemplateVar,
  type TemplateVars,
} from "./template.ts"
