/**
 * Encode `aiserver.v1.AvailableModelsRequest`.
 *
 * Cursor CLI (2026.08.11) fetches the parameterized catalog with
 * `use_model_parameters=true` and `do_not_use_markdown=true`. An empty body
 * returns the legacy exploded SKU list (`cursor-grok-4.6-high` as a parent
 * name) with no parameter definitions — AgentService/Run then rejects those
 * ids with Connect `resource_exhausted`.
 *
 * @module llm/providers/cursor/proto/available-models-request
 */

import { concat, encBool } from "./wire.ts"

export type AvailableModelsRequestOpts = {
  /** Field 5. When true, parents expose parameter_definitions + variants. */
  useModelParameters?: boolean
  /** Field 7. CLI always sets this on the parameterized fetch. */
  doNotUseMarkdown?: boolean
  /** Field 8. Explode variants in the picker list. */
  variantsWillBeShownInExplodedList?: boolean
}

/** Encode an AvailableModelsRequest protobuf body. */
export function encodeAvailableModelsRequest(opts: AvailableModelsRequestOpts = {}): Uint8Array {
  return concat(
    encBool(5, opts.useModelParameters ?? true),
    encBool(7, opts.doNotUseMarkdown ?? true),
    encBool(8, opts.variantsWillBeShownInExplodedList ?? false),
  )
}
