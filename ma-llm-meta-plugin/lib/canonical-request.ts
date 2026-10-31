/**
 * `CanonicalRequest`, widened with this adapter's prompt-cache vendor-override
 * knobs (`vendor.openai.promptCacheKey` / `promptCacheRetention`).
 *
 * `@minimal-agent/core`'s published `OpenAIVendorOpts` does not expose these
 * two fields (S42 finding, reported upstream in the plugins-repo de-vendoring
 * change: the old vendored copy of this module had them, core's current
 * leaf contract does not). Nothing else about the host's `CanonicalRequest`
 * changes here -- every other type in this module is the real host type,
 * re-exported unchanged.
 *
 * @module lib/canonical-request
 */

import type {
  CanonicalRequest as HostCanonicalRequest,
  OpenAIVendorOpts as HostOpenAIVendorOpts,
} from "@minimal-agent/core/plugin-api/llm/canonical-request"

export type {
  AnthropicVendorOpts,
  CanonicalResponseSummary,
  GenerationConfig,
  HuggingFaceVendorOpts,
  OutputFormat,
  RequestMetadata,
  ThinkingConfig,
} from "@minimal-agent/core/plugin-api/llm/canonical-request"

/** Host `OpenAIVendorOpts`, plus the prompt-cache override knobs this adapter reads. */
export interface OpenAIVendorOpts extends HostOpenAIVendorOpts {
  /**
   * Prompt-cache routing key override (Responses + Chat). Combined with the
   * prompt prefix hash to stick related requests on the same cache shard.
   * Hosts usually leave it unset and let the adapter default to
   * `metadata.sessionId`.
   */
  promptCacheKey?: string
  /** Optional retention hint (`"in-memory" | "24h"`). */
  promptCacheRetention?: string
}

/** Host `CanonicalRequest`, with `vendor.openai` widened to {@link OpenAIVendorOpts}. */
export interface CanonicalRequest extends Omit<HostCanonicalRequest, "vendor"> {
  vendor?: Omit<NonNullable<HostCanonicalRequest["vendor"]>, "openai"> & {
    openai?: OpenAIVendorOpts
  }
}
