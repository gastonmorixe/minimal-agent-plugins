// source: ma-llm-openai-plugin/responses/request-body.ts (vendored for OpenCode Go Responses surface; keep in sync)
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

import type { CanonicalRequest } from "../lib/canonical-request.ts"
import type { ModelEntry } from "../lib/host-types.ts"

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
    effort?: "none" | "low" | "medium" | "high" | "xhigh" | "max"
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
  service_tier?: "auto" | "default" | "flex" | "scale" | "priority"
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

/**
 * Service tiers OpenAI's Responses API accepts. The neutral
 * `req.serviceTier` (opaque string) is validated against this set in the
 * plugin; an unrecognized value is dropped (not sent), so a value meant for
 * a different provider can't 400 here. See OpenAI priority/flex-processing
 * docs. `scale` is the enterprise Scale-tier value, kept for completeness.
 */
export const OPENAI_SERVICE_TIERS = new Set(["auto", "default", "flex", "scale", "priority"])

/** `text.format` on the Responses API (`ResponseFormatTextConfig`). */
export type OpenAIResponsesTextFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; name: string; schema: object; strict?: boolean }

/** Fallback schema name when the request has none or it sanitizes to empty. */
export const DEFAULT_SCHEMA_NAME = "output"

/**
 * Schema name rule (OpenAI): only [a-zA-Z0-9_-], max 64 chars. Other chars
 * become "_". Empty result falls back to {@link DEFAULT_SCHEMA_NAME}.
 */
export function sanitizeSchemaName(name: string | undefined): string {
  const clean = (name ?? "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)
  return clean.length > 0 ? clean : DEFAULT_SCHEMA_NAME
}

/**
 * Strict gate (SPEC-ONESHOT D-4): send `strict: true` only when the request
 * asks for it AND the model capability `structuredOutputs` is true.
 */
export function wantsStrictSchema(
  fmt: { strict?: boolean },
  model: Pick<ModelEntry, "capabilities">,
): boolean {
  return fmt.strict === true && model.capabilities.structuredOutputs === true
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
  const tier = vendor?.serviceTier ?? req.serviceTier
  if (tier !== undefined && OPENAI_SERVICE_TIERS.has(tier)) {
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
  "application/json": "json",
  "application/xml": "xml",
}

/** The `filename` to send: the source name, else `document.<ext>`. */
function inputFileName(filename: string | undefined, mediaType: string | undefined): string {
  if (filename) return filename
  const mime = mediaType?.split(";")[0]?.trim().toLowerCase() ?? ""
  return `document.${FILE_EXTENSION_BY_MIME[mime] ?? "bin"}`
}

type ResponsesContentPart = OpenAIResponsesMessageItem["content"][number]

/**
 * A file block as a Responses `input_file` part: `file_id` as is, base64 as a
 * data URL in `file_data` (with a `filename`), a url in `file_url`.
 */
function fileToInputPart(block: FileBlock): ResponsesContentPart {
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

/** The text part that replaces an attachment this encoder cannot send. */
function placeholderPart(
  block: Parameters<typeof unsupportedAttachmentText>[0],
  role: CanonicalMessage["role"],
  modelId: string,
): ResponsesContentPart {
  return {
    type: role === "assistant" ? "output_text" : "input_text",
    text: unsupportedAttachmentText(block, modelId).text,
  }
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
        // No audio or video input part on this surface: send a placeholder,
        // so the model knows an attachment was there.
        parts.push(placeholderPart(block, msg.role, modelId))
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
