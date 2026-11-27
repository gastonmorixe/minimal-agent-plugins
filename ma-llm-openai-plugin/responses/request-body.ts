/**
 * Canonical → OpenAI Responses API request body.
 *
 * Surface reference: https://platform.openai.com/docs/api-reference/responses
 *
 * Key differences from Chat Completions:
 *
 * - `instructions: string` replaces the system message at the head of
 *   `messages[]` — pure prefix, no role wrapping.
 * - `input` is either a string OR an array of `InputItem` (message,
 *   function_call, function_call_output, image, file, computer_call).
 * - `tools[]` are **flat** `{type:"function", name, description, parameters, strict?}`
 *   — no nested `function` wrapper. Server tools
 *   live alongside as `{type:"web_search_preview"}` etc.
 * - `reasoning: {effort, summary?}` replaces `reasoning_effort`.
 * - `max_output_tokens` replaces `max_tokens` / `max_completion_tokens`.
 * - `previous_response_id` enables stateful mode: send only the new
 *   turn's items, the server replays the chain.
 * - `store`, `include`, `metadata` work like Chat but `metadata` is
 *   string→string only.
 *
 * @module llm/providers/openai/responses/request-body
 */

import type {
  CanonicalBlock,
  CanonicalMessage,
  FileBlock,
} from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import type {
  CanonicalToolDefinition,
  ToolChoice,
} from "@minimal-agent/core/plugin-api/llm/canonical-tools"
import type { ServerToolId } from "@minimal-agent/core/plugin-api/llm/capabilities"
import { unsupportedAttachmentText } from "@minimal-agent/core/plugin-api/llm/modality-check"
import { hoistToolResultMedia } from "@minimal-agent/core/plugin-api/llm/tool-result-media"

import { sanitizeSchemaName, wantsStrictSchema } from "../chat/request-body.ts"
import type { CanonicalRequest } from "../lib/canonical-request.ts"
import type { ModelEntry } from "../lib/host-types.ts"

import { toStrictParameters } from "./strict-tools.ts"

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export interface OpenAIResponsesRequestBody {
  model: string
  instructions?: string
  input: string | OpenAIResponsesInputItem[]
  previous_response_id?: string
  tools?: OpenAIResponsesTool[]
  tool_choice?: "auto" | "none" | "required" | { type: "function"; name: string }
  parallel_tool_calls?: boolean
  reasoning?: {
    effort?: "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
    summary?: "auto" | "concise" | "detailed"
  }
  /**
   * Text output config. The Responses API has NO top-level
   * `response_format` (that is Chat Completions). Structured output goes in
   * `text.format`, flat (no `json_schema` wrapper). See
   * research/spec-oneshot/R1-strict-fields.md section 3.1.
   */
  text?: { format: OpenAIResponsesTextFormat }
  max_output_tokens?: number
  stream?: boolean
  store?: boolean
  /** Compute/capacity lane. `auto|default|flex|scale|priority`. */
  service_tier?: "auto" | "default" | "flex" | "scale" | "priority" | "ultrafast"
  include?: string[]
  metadata?: Record<string, string>
  user?: string
  /**
   * Routes requests that share a long common prefix onto the same cache
   * shard. Required for reliable matching on GPT-5.6+; without it, hits
   * are best-effort and intermittent zeros are common under tool-loop RPM.
   * See https://developers.openai.com/api/docs/guides/prompt-caching
   */
  prompt_cache_key?: string
  /** Retention hint (`in-memory` | `24h`). Optional; server default applies. */
  prompt_cache_retention?: string
}

/** `text.format` on the Responses API (`ResponseFormatTextConfig`). */
export type OpenAIResponsesTextFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; name: string; schema: object; strict?: boolean }

/**
 * Service tiers OpenAI's Responses API accepts. The neutral
 * `req.serviceTier` (opaque string) is validated against this set in the
 * plugin; an unrecognized value is dropped (not sent), so a value meant for
 * a different provider can't 400 here. See OpenAI priority/flex-processing
 * docs. `scale` is the enterprise Scale-tier value, kept for completeness.
 *
 * Codex Fast mode is labeled `"fast"` in the catalog
 * (`additional_speed_tiers`, service-tier display name) but the request
 * value is still `"priority"` (Codex Fast request value).
 */
export const OPENAI_SERVICE_TIERS = new Set([
  "auto",
  "default",
  "flex",
  "scale",
  "priority",
  "ultrafast",
])

/**
 * Ultrafast is Responses-API only (developers.openai.com/api/docs/guides/ultrafast-mode,
 * 2026-09-29: `gpt-6-astra` with `service_tier: "ultrafast"`, preview for
 * gpt-5.6-sol). The Codex catalog lists no Ultrafast tier, so it is never
 * implied by `speed:"fast"`. Callers opt in with `serviceTier: "ultrafast"`.
 */
export const OPENAI_ULTRAFAST_SERVICE_TIER = "ultrafast"

/**
 * Wire model ids that accept `service_tier: "ultrafast"`. Verified live on
 * 2026-09-29 with an API key: `gpt-6-astra` returns 200 (tier=ultrafast),
 * `gpt-6.1-sol` and `gpt-6-luna` return 400 "Invalid service_tier argument".
 */
export const OPENAI_ULTRAFAST_MODELS: ReadonlySet<string> = new Set(["gpt-6-astra"])

/** Wire value for Codex / ChatGPT Fast mode (`speed:"fast"` / `/fast`). */
export const OPENAI_FAST_SERVICE_TIER = "priority"

/**
 * Resolve the OpenAI `service_tier` wire value.
 *
 * Precedence: `vendor.openai.serviceTier`, then canonical `serviceTier`,
 * then `speed:"fast"` on a fast-capable model. `"fast"` is an alias of
 * `"priority"` (Codex `from_request_value`). Unknown values are dropped.
 */
export function resolveOpenAIServiceTier(opts: {
  vendorTier?: string
  serviceTier?: string
  speedFast?: boolean
  /** Ultrafast is valid on the Responses surface only. Chat drops it. */
  allowUltrafast?: boolean
}): string | undefined {
  const raw =
    opts.vendorTier ?? opts.serviceTier ?? (opts.speedFast ? OPENAI_FAST_SERVICE_TIER : undefined)
  if (raw === undefined) return undefined
  const wire = raw === "fast" ? OPENAI_FAST_SERVICE_TIER : raw
  if (wire === OPENAI_ULTRAFAST_SERVICE_TIER && !opts.allowUltrafast) return undefined
  return OPENAI_SERVICE_TIERS.has(wire) ? wire : undefined
}

export type OpenAIResponsesInputItem =
  | OpenAIResponsesMessageItem
  | OpenAIResponsesFunctionCallItem
  | OpenAIResponsesFunctionCallOutputItem

export interface OpenAIResponsesMessageItem {
  type: "message"
  role: "user" | "assistant" | "system" | "developer"
  content: Array<
    | { type: "input_text"; text: string }
    | { type: "output_text"; text: string }
    | { type: "input_image"; image_url: string; detail?: "low" | "high" | "auto" }
    | { type: "input_image"; file_id: string; detail?: "low" | "high" | "auto" }
    | { type: "input_file"; file_id: string }
    | { type: "input_file"; file_data: string; filename: string }
    | { type: "input_file"; file_url: string; filename?: string }
  >
}

export interface OpenAIResponsesFunctionCallItem {
  type: "function_call"
  call_id: string
  name: string
  arguments: string
}

export interface OpenAIResponsesFunctionCallOutputItem {
  type: "function_call_output"
  call_id: string
  output: string
}

export type OpenAIResponsesTool =
  | {
      type: "function"
      name: string
      description?: string
      parameters: object
      strict?: boolean
    }
  | { type: "web_search_preview" }
  | { type: "file_search"; vector_store_ids: string[] }
  | { type: "code_interpreter"; container: { type: "auto" } }
  | {
      type: "computer_use_preview"
      display_width: number
      display_height: number
      environment: "browser" | "windows" | "mac"
    }

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Build the Responses API request body from a canonical request: maps
 * messages, tools, reasoning, and sampling knobs onto the responses wire
 * shape.
 */
export function buildOpenAIResponsesBody(
  req: CanonicalRequest,
  model: ModelEntry,
): OpenAIResponsesRequestBody {
  const body: OpenAIResponsesRequestBody = {
    model: model.vendorIds?.firstParty ?? req.modelId,
    instructions: buildInstructions(req),
    input: buildInputItems(req, model.id),
    store: false,
  }

  // Stateful mode: client sends only the new turn(s); server replays the chain.
  if (req.previousResponseId) body.previous_response_id = req.previousResponseId

  if (req.tools && req.tools.length > 0) body.tools = req.tools.map(toResponsesTool)
  if (req.toolChoice) body.tool_choice = toResponsesToolChoice(req.toolChoice)

  // Reasoning
  const isReasoningModel = model.capabilities.effort.levels.length > 0
  if (req.thinking?.mode === "adaptive" || isReasoningModel) {
    const reasoning: NonNullable<OpenAIResponsesRequestBody["reasoning"]> = {}
    if (req.effort && model.capabilities.effort.levels.includes(req.effort)) {
      reasoning.effort = req.effort as NonNullable<
        OpenAIResponsesRequestBody["reasoning"]
      >["effort"]
    }
    // Visible summary deltas opt-in
    if (
      (req.thinking?.mode === "adaptive" || req.thinking?.mode === "extended") &&
      (req.thinking.display === "visible" || req.thinking.display === "summary") &&
      model.capabilities.thinking.visible
    ) {
      reasoning.summary = "auto"
    }
    if (Object.keys(reasoning).length > 0) body.reasoning = reasoning
  }

  // Output format -> `text.format` (flat). Strict gate: SPEC-ONESHOT D-4.
  if (req.outputFormat) {
    const fmt = req.outputFormat
    if (fmt.type === "json_schema") {
      const format: Extract<OpenAIResponsesTextFormat, { type: "json_schema" }> = {
        type: "json_schema",
        name: sanitizeSchemaName(fmt.name),
        schema: fmt.schema,
      }
      if (wantsStrictSchema(fmt, model)) format.strict = true
      body.text = { format }
    } else {
      body.text = { format: { type: fmt.type === "json_object" ? "json_object" : "text" } }
    }
  }

  // Max output tokens
  if (req.generation?.maxOutputTokens !== undefined) {
    body.max_output_tokens = Math.min(
      req.generation.maxOutputTokens,
      model.capabilities.maxOutputTokens,
    )
  }

  body.stream = req.stream ?? true

  // OpenAI vendor opts
  const vendor = req.vendor?.openai
  if (vendor?.parallelToolCalls !== undefined) body.parallel_tool_calls = vendor.parallelToolCalls
  if (vendor?.store !== undefined) body.store = vendor.store
  if (vendor?.include) body.include = vendor.include
  if (vendor?.user) body.user = vendor.user
  if (req.metadata?.custom) body.metadata = { ...req.metadata.custom }

  // Prompt-cache routing key. GPT-5.6+ needs this for reliable matching;
  // session id is the natural sticky key for an agent tool loop (stable
  // prefix across turns of one conversation). Prefer an explicit vendor
  // override when a host wants to shard high-RPM traffic.
  const cacheKey =
    (typeof vendor?.promptCacheKey === "string" && vendor.promptCacheKey) ||
    req.metadata?.sessionId ||
    undefined
  if (cacheKey) body.prompt_cache_key = cacheKey
  if (typeof vendor?.promptCacheRetention === "string" && vendor.promptCacheRetention) {
    body.prompt_cache_retention = vendor.promptCacheRetention
  }

  // Provider-neutral service tier -> OpenAI `service_tier`. Validate against
  // the accepted set; drop (don't send) anything else. `vendor.serviceTier`
  // wins over the neutral field when both are set (explicit last-mile knob).
  // `speed:"fast"` (CLI `--fast`) maps to Codex Fast = wire `priority`.
  const tier = resolveOpenAIServiceTier({
    vendorTier: vendor?.serviceTier,
    serviceTier: req.serviceTier,
    speedFast: req.speed === "fast" && model.capabilities.speedFast,
    allowUltrafast: OPENAI_ULTRAFAST_MODELS.has(body.model),
  })
  if (tier !== undefined) {
    body.service_tier = tier as NonNullable<OpenAIResponsesRequestBody["service_tier"]>
  }

  return body
}

function buildInstructions(req: CanonicalRequest): string {
  if (!req.system || req.system.length === 0) return ""
  return req.system
    .map((b) => (b.type === "text" ? b.text : ""))
    .filter(Boolean)
    .join("\n\n")
}

function buildInputItems(req: CanonicalRequest, modelId: string): OpenAIResponsesInputItem[] {
  const items: OpenAIResponsesInputItem[] = []
  // A function_call_output takes only text here. Move tool result media to
  // the message item that follows the tool outputs.
  for (const msg of hoistToolResultMedia(req.messages)) {
    appendCanonicalMessage(items, msg, modelId)
  }
  return items
}

/** File name extension per document MIME type, for a default `filename`. */
const FILE_EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "text/tab-separated-values": "tsv",
  "text/html": "html",
  "text/css": "css",
  "application/json": "json",
  "application/xml": "xml",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
}

/** The `filename` to send: the source name, else `document.<ext>`. */
function inputFileName(filename: string | undefined, mediaType: string | undefined): string {
  if (filename) return filename
  const mime = mediaType?.split(";")[0]?.trim().toLowerCase() ?? ""
  return `document.${FILE_EXTENSION_BY_MIME[mime] ?? "bin"}`
}

/**
 * A file block as a Responses `input_file` part: `file_id` as is, base64 as a
 * data URL in `file_data` (with a `filename`), a url in `file_url`.
 */
function fileToInputPart(block: FileBlock): OpenAIResponsesMessageItem["content"][number] {
  const src = block.source
  if (src.kind === "file_id") return { type: "input_file", file_id: src.fileId }
  if (src.kind === "base64") {
    return {
      type: "input_file",
      file_data: `data:${src.mediaType};base64,${src.data}`,
      filename: inputFileName(src.filename, src.mediaType),
    }
  }
  return src.filename
    ? { type: "input_file", file_url: src.url, filename: src.filename }
    : { type: "input_file", file_url: src.url }
}

function appendCanonicalMessage(
  items: OpenAIResponsesInputItem[],
  msg: CanonicalMessage,
  modelId: string,
): void {
  if (msg.role === "tool") {
    for (const block of msg.content) {
      if (block.type === "tool_result") {
        const text = block.content
          .map((c) => (c.type === "text" ? c.text : ""))
          .filter(Boolean)
          .join("\n")
        items.push({
          type: "function_call_output",
          call_id: block.toolUseId,
          output: text,
        })
      }
    }
    return
  }

  // Collect tool_use blocks → function_call items. Text/image → message item.
  const parts: OpenAIResponsesMessageItem["content"] = []
  for (const block of msg.content) {
    switch (block.type) {
      case "text":
        parts.push({
          type: msg.role === "assistant" ? "output_text" : "input_text",
          text: block.text,
        })
        break
      case "image":
        if (block.source.kind === "url") {
          parts.push({
            type: "input_image",
            image_url: block.source.url,
            detail: block.source.detail,
          })
        } else if (block.source.kind === "base64") {
          parts.push({
            type: "input_image",
            image_url: `data:${block.source.mediaType};base64,${block.source.data}`,
            detail: block.source.detail,
          })
        } else if (block.source.kind === "file_id") {
          // OpenAI Responses accepts an uploaded image by file id.
          parts.push({
            type: "input_image",
            file_id: block.source.fileId,
            detail: block.source.detail,
          })
        }
        break
      case "file":
        parts.push(fileToInputPart(block))
        break
      case "tool_use":
        items.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input),
        })
        break
      case "tool_result": {
        const text = block.content
          .map((c) => (c.type === "text" ? c.text : ""))
          .filter(Boolean)
          .join("\n")
        items.push({
          type: "function_call_output",
          call_id: block.toolUseId,
          output: text,
        })
        break
      }
      case "audio":
      case "video":
        // The Responses API has no audio or video input part. Send a
        // placeholder, so the model knows an attachment was there.
        parts.push({
          type: msg.role === "assistant" ? "output_text" : "input_text",
          text: unsupportedAttachmentText(block, modelId).text,
        })
        break
      case "thinking":
        // Not represented as input items on Responses.
        break
    }
  }
  if (parts.length > 0) {
    items.push({
      type: "message",
      role:
        msg.role === "user"
          ? "user"
          : msg.role === "assistant"
            ? "assistant"
            : msg.role === "system"
              ? "system"
              : "developer",
      content: parts,
    })
  }
}

function toResponsesTool(tool: CanonicalToolDefinition): OpenAIResponsesTool {
  if (tool.server) {
    return mapServerTool(tool.server)
  }
  // Do the strict conversion here, with null for each optional property (see
  // strict-tools.ts). A tool that sets `strict: false` opts out, and a schema
  // that cannot be converted goes unchanged: the server then normalizes it.
  const strictParams = tool.strict === false ? undefined : toStrictParameters(tool.inputSchema)
  if (strictParams !== undefined) {
    return {
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: strictParams,
      strict: true,
    }
  }
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema as object,
    strict: tool.strict,
  }
}

function mapServerTool(id: ServerToolId): OpenAIResponsesTool {
  switch (id) {
    case "web_search":
      return { type: "web_search_preview" }
    case "code_interpreter":
      return { type: "code_interpreter", container: { type: "auto" } }
    case "file_search":
      return { type: "file_search", vector_store_ids: [] }
    case "computer_use":
      return {
        type: "computer_use_preview",
        display_width: 1024,
        display_height: 768,
        environment: "browser",
      }
    case "advisor":
      // Anthropic-only concept; coerce to a no-op (drop) by falling through.
      return { type: "web_search_preview" }
    default: {
      throw new Error(`unhandled server tool: ${String(id satisfies never)}`)
    }
  }
}

function toResponsesToolChoice(choice: ToolChoice): OpenAIResponsesRequestBody["tool_choice"] {
  switch (choice.type) {
    case "auto":
      return "auto"
    case "none":
      return "none"
    case "any":
      return "required"
    case "tool":
      return { type: "function", name: choice.name }
    default: {
      throw new Error(`unhandled tool choice: ${String(choice satisfies never)}`)
    }
  }
}

// Silence unused-import warning when sub-types are referenced via spec docs only.
void (null as unknown as CanonicalBlock | undefined)
