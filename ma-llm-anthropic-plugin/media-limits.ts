/**
 * Anthropic-specific media limits, as data. Implements the
 * `ProviderAdapter.mediaLimits(model)` hook (see the adapter); core never
 * imports this module — it reaches limits ONLY through the hook, falling
 * back to the neutral `src/media/default-limits.ts` floor. Numbers come
 * from the reconciled spec
 * `private/multimodality-ingestion/anthropic/10-anthropic-image-ingestion.md`.
 *
 * The accepted MIME set is per model: the model's resolved
 * `Capabilities.inputMimeTypes` (see `capabilities.ts`).
 *
 * @module llm/providers/anthropic/media-limits
 */

import {
  type Capabilities,
  resolveInputMimeTypes,
} from "@minimal-agent/core/plugin-api/llm/capabilities"

import {
  ANTHROPIC_DOCUMENT_INPUT_MIME_TYPES,
  ANTHROPIC_IMAGE_INPUT_MIME_TYPES,
} from "./capabilities.ts"
import type { MediaLimits } from "./lib/host-types.ts"

/** Image formats Anthropic vision accepts (no animation). */
export const ANTHROPIC_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(
  ANTHROPIC_IMAGE_INPUT_MIME_TYPES,
)

/** Document formats accepted via the `document` block (PDF and text-like types). */
export const ANTHROPIC_DOCUMENT_MIME_TYPES: ReadonlySet<string> = new Set(
  ANTHROPIC_DOCUMENT_INPUT_MIME_TYPES,
)

/** The provider default accepted set, for a model with no `inputMimeTypes`. */
const ANTHROPIC_DEFAULT_MIME_TYPES: readonly string[] = [
  ...ANTHROPIC_IMAGE_INPUT_MIME_TYPES,
  ...ANTHROPIC_DOCUMENT_INPUT_MIME_TYPES,
]

/** The model facts that {@link anthropicMediaLimits} reads. */
export interface AnthropicMediaLimitsInput {
  contextWindow?: number
  /** The model capabilities. Absent: the provider default set (images and documents). */
  capabilities?: Partial<Pick<Capabilities, "modalities" | "inputMimeTypes">>
}

/**
 * Build the {@link MediaLimits} for an Anthropic model.
 *
 * - Accepted types: the model's resolved input MIME list
 *   (`resolveInputMimeTypes`: `inputMimeTypes`, else the provider default
 *   filtered by the modality flags).
 * - 32 MB request budget is the hard API wall.
 * - 5 MB/item is a sane TUI default (configurable later), well under the wall.
 * - 100 images/request for 200k-context models, 600 otherwise.
 * - 8000px is the documented max dimension (we reject rather than resize).
 */
export function anthropicMediaLimits(opts?: AnthropicMediaLimitsInput): MediaLimits {
  const is200k = (opts?.contextWindow ?? 0) >= 200_000
  return {
    acceptedMimeTypes: new Set(anthropicInputMimeTypes(opts?.capabilities)),
    maxBytesPerItem: 5 * 1024 * 1024,
    maxRequestBytes: 32 * 1024 * 1024,
    maxItemsPerRequest: is200k ? 100 : 600,
    maxDimension: 8000,
  }
}

/**
 * The input MIME types of an Anthropic model: its `inputMimeTypes`, else the
 * provider default set filtered by its modality flags. A partial record with
 * neither field (a header-only stub) gets the provider default set.
 *
 * @param caps - The model capabilities. Absent: the provider default set.
 * @returns The accepted types, lowercase.
 */
export function anthropicInputMimeTypes(
  caps?: Partial<Pick<Capabilities, "modalities" | "inputMimeTypes">>,
): readonly string[] {
  if (!caps || (caps.inputMimeTypes === undefined && caps.modalities === undefined)) {
    return ANTHROPIC_DEFAULT_MIME_TYPES
  }
  return resolveInputMimeTypes(
    {
      modalities: caps.modalities ?? { image: true, audio: false, pdf: true, video: false },
      ...(caps.inputMimeTypes !== undefined && { inputMimeTypes: caps.inputMimeTypes }),
    },
    ANTHROPIC_DEFAULT_MIME_TYPES,
  )
}
