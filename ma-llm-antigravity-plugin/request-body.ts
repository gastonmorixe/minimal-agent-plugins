/**
 * Canonical request to Cloud Code Assist `streamGenerateContent` envelope.
 *
 * The wire shape is the one `agy` v1.5.17 sends (see
 * `research/2026-11-25-antigravity-plugin/notes/wire.md` 4.2), with three
 * details settled by live probes on 2026-11-25
 * (`research/2026-11-25-antigravity-plugin/logs/probe-tool-loop2-20261125.log`):
 *
 * 1. `thoughtSignature` is a SIBLING key of `functionCall` in the same part.
 *    Put inside `functionCall` the backend answers 400.
 * 2. A Gemini family tool call MUST echo its signature, or the backend answers
 *    400 "Function call is missing a thought_signature in functionCall parts".
 *    Claude and GPT-OSS never send one.
 * 3. A `functionResponse` in a content with `role:"user"` is 200 on Gemini,
 *    Claude and GPT-OSS, so the canonical `tool` message maps to `user`.
 *
 * @module llm/providers/antigravity/request-body
 */

import type {
  CanonicalBlock,
  CanonicalMessage,
} from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import type { CanonicalRequest } from "@minimal-agent/core/plugin-api/llm/canonical-request"
import type { Capabilities } from "@minimal-agent/core/plugin-api/llm/capabilities"
import { hoistToolResultMedia } from "@minimal-agent/core/plugin-api/llm/tool-result-media"

import type { ModelView } from "./lib/host-types.ts"
import { sanitizeGeminiSchema } from "./schema-sanitize.ts"
import { ANTIGRAVITY_REQUEST_USER_AGENT, REQUEST_TYPE_AGENT } from "./wire-constants.ts"

/** Model families of the backend, which differ in thinking and signature rules. */
export type AntigravityFamily = "gemini" | "claude" | "gpt-oss"

/** Locator fields and signature map the adapter owns, not the request. */
export interface AntigravityBodyInput {
  /** `cloudaicompanionProject` from `loadCodeAssist`. */
  project: string
  /** Model id on the wire, for example `gemini-4-neon-high`. */
  modelId: string
  /** `agent/<conv>/<ms>/<exec>/<step>` trace id. */
  requestId: string
  /** Numeric session id, when the host has one. */
  sessionId?: string
  /**
   * `thoughtSignature` per tool call id. A Gemini function call part must
   * carry the signature it got, and core strips older thinking blocks, so the
   * adapter keeps this map outside the history.
   */
  signatures?: ReadonlyMap<string, string>
}

/** Generation settings of a built body, for adapter logging and receipts. */
export interface AntigravityGeneration {
  maxOutputTokens?: number
  thinkingLevel?: string
  thinkingBudget?: number
}

/** Result of {@link buildAntigravityBody}. */
export interface AntigravityBuiltBody {
  /** The `streamGenerateContent` request body. */
  body: unknown
  /** The generation settings the builder chose. */
  generation: AntigravityGeneration
}

/** One part of the Gemini `contents[]` shape. */
export interface GeminiRequestPart {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  functionCall?: { id?: string; name: string; args: unknown }
  functionResponse?: { id?: string; name: string; response: { output: string } }
  inlineData?: { mimeType: string; data: string }
  fileData?: { mimeType: string; fileUri: string }
}

/** One content entry of the Gemini `contents[]` shape. */
export interface GeminiRequestContent {
  role: "user" | "model"
  parts: GeminiRequestPart[]
}

/** Thinking suffix levels the Gemini and Claude families accept, low to high. */
const THINKING_LEVELS: ReadonlyArray<string> = ["minimal", "low", "medium", "high", "xhigh"]

/** Token budget the GPT-OSS family gets when the user asks for no budget. */
const GPT_OSS_DEFAULT_BUDGET = 8192

/**
 * Which family a model id belongs to.
 *
 * The id prefix is the only stable signal: the catalog has no family field
 * that survives a live model refresh.
 */
export function antigravityFamily(modelId: string): AntigravityFamily {
  if (/gpt-oss/i.test(modelId)) return "gpt-oss"
  if (/^claude/i.test(modelId)) return "claude"
  return "gemini"
}

/** Flatten the text of a block list, for a system prompt or a tool result. */
function textOf(blocks: ReadonlyArray<CanonicalBlock>): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === "text") parts.push(block.text)
  }
  return parts.join("\n\n")
}

/** Best-effort MIME type of a media source. */
function mediaMimeType(source: { kind: string; mediaType?: string; format?: string }): string {
  if ("mediaType" in source && source.mediaType) return source.mediaType
  if ("format" in source && source.format) return `audio/${source.format}`
  return "application/octet-stream"
}

/** Map of a media block to an inline or hosted part, when possible. */
function mediaPart(block: CanonicalBlock): GeminiRequestPart | null {
  if (
    block.type !== "image" &&
    block.type !== "audio" &&
    block.type !== "file" &&
    block.type !== "video"
  ) {
    return null
  }
  const source = block.source
  if (source.kind === "base64") {
    return { inlineData: { mimeType: mediaMimeType(source), data: source.data } }
  }
  if (source.kind === "url") {
    return { fileData: { mimeType: mediaMimeType(source), fileUri: source.url } }
  }
  return null
}

/** `vendorIds` key of a family row (see `models.ts` `EFFORT_BASE_VENDOR_KEY`). */
const EFFORT_BASE_KEY = "effortBase"

/** The (wire model id, thinking suffix) pair of one request. */
export interface AntigravityWireTarget {
  /** Top-level `model` of the body, for example `gemini-4-neon-high`. */
  model: string
  /** Lower-case thinking suffix, or undefined for no `thinkingLevel`. */
  level?: string
}

/** Thinking suffix of an id, in lower case, when it is a known level. */
function suffixLevel(id: string): string | undefined {
  return THINKING_LEVELS.find((level) => id.endsWith(`-${level}`))
}

/** Level of an extended thinking budget, the coarse map of the old adapter. */
function budgetLevel(budget: number): string {
  if (budget <= 1024) return "low"
  if (budget <= 8192) return "medium"
  return "high"
}

/**
 * Resolve the wire pair of one request, the same pair agy sends.
 *
 * A family row (`gemini-4-neon`, `vendorIds.effortBase` set) sends
 * `model: "<base>-<effort>"` and `thinkingLevel: "<EFFORT>"`, and never a pair
 * with two different levels. The effort is, in this order:
 *
 * 1. the explicit `req.effort`, when the family lists it;
 * 2. the suffix of the requested id, when the session names an old suffixed
 *    id (`gemini-4-neon-high`) that is now an alias of the family;
 * 3. the level of an extended thinking budget, when the family lists it;
 * 4. the family default (`capabilities.effort.default`), never the core
 *    "medium".
 *
 * A single row (no family) sends its own id. A suffixed id
 * (`gpt-oss-120b-medium`, `gemini-4-hydrogen-tiered-high`) always sends its
 * suffix. An id with no suffix sends the explicit effort when the row lists
 * it, else the budget level, else no level. `thinking: off` sends no level.
 *
 * @param req - Canonical request. `modelId` is the id the session names.
 * @param model - Registered model view (the family row for an alias).
 * @param fallbackId - Wire id of a single row (`vendorIds.model` or the id).
 */
export function resolveAntigravityWireTarget(
  req: CanonicalRequest,
  model: ModelView,
  fallbackId: string = model.vendorIds?.model ?? model.id,
): AntigravityWireTarget {
  const levels = model.capabilities.effort.levels
  const thinkingOff = req.thinking?.mode === "off"
  const explicit = req.effort?.toLowerCase()
  const base = model.vendorIds?.[EFFORT_BASE_KEY]
  if (base) {
    const listed = (level: string | undefined): level is string =>
      level !== undefined && levels.includes(level)
    const fromAlias = req.modelId.startsWith(`${base}-`) ? suffixLevel(req.modelId) : undefined
    const fromBudget =
      req.thinking?.mode === "extended" ? budgetLevel(req.thinking.budgetTokens) : undefined
    const effort =
      [explicit, fromAlias, fromBudget].find(listed) ??
      (listed(model.capabilities.effort.default) ? model.capabilities.effort.default : levels[0])
    if (!effort) return { model: fallbackId }
    return { model: `${base}-${effort}`, ...(thinkingOff ? {} : { level: effort }) }
  }
  if (thinkingOff) return { model: fallbackId }
  // A suffixed id has one level: its suffix. No other level goes with it.
  const own = suffixLevel(fallbackId)
  if (own) return { model: fallbackId, level: own }
  if (explicit && levels.includes(explicit) && THINKING_LEVELS.includes(explicit)) {
    return { model: fallbackId, level: explicit }
  }
  if (req.thinking?.mode === "extended" && levels.length > 0) {
    return { model: fallbackId, level: budgetLevel(req.thinking.budgetTokens) }
  }
  return { model: fallbackId }
}

/**
 * Build `generationConfig` and record the settings used.
 *
 * `maxOutputTokens` is the smaller of the request value and the model limit.
 * The thinking shape is per family: a number budget for GPT-OSS, a level
 * string for everyone else.
 *
 * A `json_schema` output format on a model with `structuredOutputs` sends
 * `responseMimeType: "application/json"` and `responseJsonSchema`, the two
 * fields gemini-cli sends on this `v1internal` API
 * (https://github.com/google-gemini/gemini-cli,
 * `packages/core/src/code_assist/converter.ts` `toVertexGenerationConfig`).
 * The schema goes as standard lower-case JSON Schema, not through the
 * upper-case tool schema path. The JSON mime type makes the reply raw JSON
 * text, which core parses with `JSON.parse`.
 */
export function buildGenerationConfig(
  req: CanonicalRequest,
  model: ModelView,
  target: AntigravityWireTarget = resolveAntigravityWireTarget(req, model),
): { config: Record<string, unknown>; generation: AntigravityGeneration } {
  const caps: Capabilities = model.capabilities
  const limit = caps.maxOutputTokens
  const maxOutputTokens = Math.min(req.generation?.maxOutputTokens ?? limit, limit)
  const generation: AntigravityGeneration = { maxOutputTokens }
  const config: Record<string, unknown> = { maxOutputTokens }

  const thinkingAllowed = caps.thinking.visible && req.thinking?.mode !== "off"
  if (thinkingAllowed) {
    if (antigravityFamily(model.id) === "gpt-oss") {
      const budget =
        req.thinking?.mode === "extended" ? req.thinking.budgetTokens : GPT_OSS_DEFAULT_BUDGET
      generation.thinkingBudget = budget
      config.thinkingConfig = { includeThoughts: true, thinkingBudget: budget }
    } else {
      if (target.level) generation.thinkingLevel = target.level.toUpperCase()
      const thinkingConfig: Record<string, unknown> = { includeThoughts: true }
      if (generation.thinkingLevel) thinkingConfig.thinkingLevel = generation.thinkingLevel
      config.thinkingConfig = thinkingConfig
    }
  }

  const gen = req.generation
  if (gen?.temperature !== undefined && caps.acceptsTemperature) {
    config.temperature = gen.temperature
  }
  if (gen?.topP !== undefined && caps.acceptsTopP) config.topP = gen.topP
  if (gen?.topK !== undefined && caps.acceptsTopK) config.topK = gen.topK
  if (gen?.stop && gen.stop.length > 0 && caps.acceptsStopSequences) config.stopSequences = gen.stop
  if (req.outputFormat?.type === "json_schema" && caps.structuredOutputs) {
    config.responseMimeType = "application/json"
    config.responseJsonSchema = req.outputFormat.schema
  }
  return { config, generation }
}

/** Build the assistant content: text, thinking, tool calls and signatures. */
function assistantContent(
  message: CanonicalMessage,
  family: AntigravityFamily,
  signatures: ReadonlyMap<string, string>,
): GeminiRequestContent {
  const parts: GeminiRequestPart[] = []
  let pendingSignature: string | undefined

  for (const block of message.content) {
    if (block.type === "text") {
      if (block.text.length === 0) continue
      parts.push({ text: block.text })
      continue
    }
    if (block.type === "thinking") {
      if (block.signature) pendingSignature = block.signature
      if (block.text.length > 0) parts.push({ text: block.text, thought: true })
      continue
    }
    if (block.type === "redacted_thinking") {
      pendingSignature = pendingSignature ?? block.data
      continue
    }
    if (block.type === "tool_use") {
      const part: GeminiRequestPart = {
        functionCall: { id: block.id, name: block.name, args: block.input ?? {} },
      }
      // The signature is a sibling of the call, never a child.
      const signature = signatures.get(block.id) ?? pendingSignature
      if (signature) {
        part.thoughtSignature = signature
        pendingSignature = undefined
      }
      parts.push(part)
      continue
    }
    const media = mediaPart(block)
    if (media) parts.push(media)
  }

  // A stray signature closes on an empty text part, which the backend accepts.
  if (pendingSignature && family !== "gemini") {
    parts.push({ text: "", thoughtSignature: pendingSignature })
  }
  return { role: "model", parts }
}

/** The text and media parts of a message, in order. An empty text adds no part. */
function textAndMediaParts(message: CanonicalMessage): GeminiRequestPart[] {
  const parts: GeminiRequestPart[] = []
  for (const block of message.content) {
    if (block.type === "text") {
      if (block.text.length > 0) parts.push({ text: block.text })
      continue
    }
    const media = mediaPart(block)
    if (media) parts.push(media)
  }
  return parts
}

/** Build one `user` content from the text and media blocks of a message. */
function userContent(message: CanonicalMessage): GeminiRequestContent {
  const parts = textAndMediaParts(message)
  if (parts.length === 0) parts.push({ text: "" })
  return { role: "user", parts }
}

/** Build the `response.output` text of one tool result block. */
function toolResponseOutput(block: Extract<CanonicalBlock, { type: "tool_result" }>): string {
  const text = textOf(block.content)
  if (text.length > 0) return text
  return block.isError ? "error" : "ok"
}

/**
 * Split a request into the system prompt and the remaining messages.
 *
 * A top-level `system` array wins. A `system` message inside the conversation
 * becomes a user part that starts with `[system] `, because the backend has no
 * mid-conversation system role.
 */
function splitSystem(req: CanonicalRequest): {
  systemText: string
  messages: CanonicalMessage[]
} {
  const top = req.system ? textOf(req.system) : ""
  const messages: CanonicalMessage[] = []
  const middle: string[] = []
  for (const message of req.messages) {
    if (message.role === "system") {
      middle.push(textOf(message.content))
      continue
    }
    messages.push(message)
  }
  const merged = [top, ...middle].filter((s) => s.length > 0).join("\n\n")
  return { systemText: merged, messages }
}

/** Build the `functionDeclarations` list with sanitized schemas. */
function buildToolDeclarations(req: CanonicalRequest): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const tool of req.tools ?? []) {
    if (tool.server) continue
    out.push({
      name: tool.name,
      description: tool.description,
      parameters: sanitizeGeminiSchema(tool.inputSchema),
    })
  }
  return out
}

/** Map the canonical tool choice to `toolConfig.functionCallingConfig`. */
function buildToolConfig(req: CanonicalRequest): Record<string, unknown> | undefined {
  const choice = req.toolChoice
  if (!choice || choice.type === "auto") return undefined
  if (choice.type === "none") return { functionCallingConfig: { mode: "NONE" } }
  if (choice.type === "any") return { functionCallingConfig: { mode: "ANY" } }
  return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [choice.name] } }
}

/** Sentinel the backend accepts for a call whose signature was lost. */
export const THOUGHT_SIGNATURE_SENTINEL = "skip_thought_signature_validator"

/**
 * Put the sentinel on the first call of every unsigned Gemini step of the
 * current turn, when the history ends at a tool result.
 *
 * The rule (https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures):
 * the current turn starts after the newest user content that has standard
 * content and no `functionResponse`. The first `functionCall` part of EACH
 * model step after it must carry a signature, or the backend answers 400.
 *
 * The adapter keeps signatures in memory only. After a restart or resume in
 * the middle of a turn, every earlier step has none. Signing only the last
 * step then answered 400 at the first earlier step (session 51282a5c,
 * 2026-11-27, "position 58").
 *
 * Live probe in `research/2026-11-25-antigravity-plugin/logs/`, file
 * `probe-signature-ends-20261125.log`: a wrong base64 value answers 400
 * "Corrupted thought signature", so the sentinel is the only safe filler. A
 * history that has a separate user text content after the result starts a new
 * turn and needs nothing. A content with tool parts and text does not start a
 * turn, because it has a `functionResponse`.
 */
function repairUnsignedTail(contents: GeminiRequestContent[], family: AntigravityFamily): void {
  if (family !== "gemini") return
  const tail = contents[contents.length - 1]
  if (!tail || tail.role !== "user") return
  const isToolResultTail = tail.parts.some((p) => p.functionResponse !== undefined)
  if (!isToolResultTail) return
  for (let i = currentTurnStart(contents); i < contents.length; i++) {
    const content = contents[i]
    if (content.role !== "model") continue
    const first = content.parts.find((part) => part.functionCall !== undefined)
    if (first && !first.thoughtSignature) first.thoughtSignature = THOUGHT_SIGNATURE_SENTINEL
  }
}

/**
 * Index of the first content of the current Gemini turn: the one after the
 * newest user content that has no `functionResponse`. 0 when there is none.
 */
function currentTurnStart(contents: GeminiRequestContent[]): number {
  for (let i = contents.length - 1; i >= 0; i--) {
    const content = contents[i]
    if (content.role !== "user") continue
    if (content.parts.some((part) => part.functionResponse !== undefined)) continue
    return i + 1
  }
  return 0
}
/**
 * Build the `functionResponse` parts of a message, whatever its role is.
 *
 * A canonical tool result is a `tool_result` block, and the host puts it in a
 * `role:"user"` message. This returns only the tool parts. The caller adds the
 * text and media of the same message after them.
 */
function toolResponseParts(
  message: CanonicalMessage,
  toolNames: Map<string, string>,
): GeminiRequestPart[] {
  const parts: GeminiRequestPart[] = []
  for (const block of message.content) {
    if (block.type !== "tool_result") continue
    parts.push({
      functionResponse: {
        id: block.toolUseId,
        name: toolNames.get(block.toolUseId) ?? "tool",
        response: { output: toolResponseOutput(block) },
      },
    })
  }
  return parts
}

/**
 * Build the full `streamGenerateContent` body and its generation settings.
 *
 * @param req - Canonical request from the host.
 * @param model - Registered model view, for limits and thinking support.
 * @param input - Locator fields and the signature map the adapter owns.
 * @returns The wire body plus the generation settings used. A Gemini step of
 *   the current turn with no known signature gets the sentinel (see
 *   `repairUnsignedTail`).
 */
export function buildAntigravityBody(
  req: CanonicalRequest,
  model: ModelView,
  input: AntigravityBodyInput,
): AntigravityBuiltBody {
  const { systemText, messages } = splitSystem(req)
  const family = antigravityFamily(input.modelId)
  const signatures = input.signatures ?? new Map<string, string>()
  const toolNames = new Map<string, string>()

  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_use") toolNames.set(block.id, block.name)
    }
  }

  const contents: GeminiRequestContent[] = []
  // `response.output` takes only text. Move tool result media to the text and
  // media parts that follow the functionResponse parts of the same content.
  for (const message of hoistToolResultMedia(messages)) {
    if (message.role === "assistant") {
      const content = assistantContent(message, family, signatures)
      if (content.parts.length > 0) contents.push(content)
      continue
    }
    // Dispatch on BLOCK type, not message role: the canonical shape puts a
    // `tool_result` block in a message with role "user"
    // (plugin-api/src/llm/canonical-messages.ts:216-225). A role check drops
    // the tool output and the model then sees an empty user turn.
    const toolParts = toolResponseParts(message, toolNames)
    if (toolParts.length > 0) {
      // Keep the text and media of the same message after the tool parts.
      // Core puts the text that the host queues during a tool round (a
      // sub-agent digest, a mode or save attachment) in this message. When
      // it was dropped, a lead waited for a worker that was done (session
      // 51282a5c, 2026-11-27).
      contents.push({ role: "user", parts: [...toolParts, ...textAndMediaParts(message)] })
      continue
    }
    contents.push(userContent(message))
  }

  repairUnsignedTail(contents, family)
  // A family row names its base id; the wire id is `<base>-<effort>`.
  const target = resolveAntigravityWireTarget(req, model, input.modelId)
  const { config, generation } = buildGenerationConfig(req, model, target)

  const request: Record<string, unknown> = { contents, generationConfig: config }
  if (systemText.length > 0) {
    request.systemInstruction = { role: "user", parts: [{ text: systemText }] }
  }
  if (input.sessionId) request.sessionId = input.sessionId

  const declarations = buildToolDeclarations(req)
  if (declarations.length > 0) request.tools = [{ functionDeclarations: declarations }]
  const toolConfig = buildToolConfig(req)
  if (toolConfig) request.toolConfig = toolConfig

  const body = {
    project: input.project,
    model: target.model,
    userAgent: ANTIGRAVITY_REQUEST_USER_AGENT,
    requestType: REQUEST_TYPE_AGENT,
    requestId: input.requestId,
    request,
  }
  return { body, generation }
}
