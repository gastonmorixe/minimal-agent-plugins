/**
 * OpenAI / Codex Responses compaction endpoint.
 *
 * Codex (and Azure Responses) expose a unary history compressor:
 *
 *   POST /v1/responses/compact
 *   POST chatgpt.com/backend-api/codex/responses/compact
 *
 * Body is a Responses-shaped payload (`model`, `instructions`, `input`,
 * `tools`, ...). Response is `{ output: ResponseItem[] }`, often an opaque
 * encrypted compaction item the next `/responses` turn must re-send.
 *
 * @module llm/providers/openai/responses/compact
 */

import type { ProviderAuth, RunContext } from "@minimal-agent/core/plugin-api/llm/provider-auth"
import type { NetworkClient } from "@minimal-agent/core/plugin-api/net/types"
import type { SidebandApi } from "@minimal-agent/core/plugin-api/types/sideband"

import type { CanonicalRequest } from "../lib/canonical-request.ts"
import type { ModelEntry } from "../lib/host-types.ts"
import {
  CHATGPT_CODEX_RESPONSES_COMPACT_PATH,
  RESPONSES_COMPACT_PATH,
  RESPONSES_COMPACT_URL,
} from "../wire-constants.ts"

import {
  buildOpenAIResponsesBody,
  type OpenAIResponsesInputItem,
  type OpenAIResponsesRequestBody,
} from "./request-body.ts"

/** Wire body for POST /responses/compact (subset of Responses request). */
export interface OpenAIResponsesCompactBody {
  model: string
  instructions?: string
  input: string | OpenAIResponsesInputItem[]
  tools?: OpenAIResponsesRequestBody["tools"]
  parallel_tool_calls?: boolean
  reasoning?: OpenAIResponsesRequestBody["reasoning"]
  service_tier?: OpenAIResponsesRequestBody["service_tier"]
}

/** One item returned by the compact endpoint (opaque + known shapes). */
export type OpenAICompactOutputItem =
  | OpenAIResponsesInputItem
  | {
      type: "compaction" | "compaction_summary" | "context_compaction"
      id?: string | null
      encrypted_content?: string
      [key: string]: unknown
    }
  | {
      type: "message"
      role?: string
      content?: unknown
      [key: string]: unknown
    }
  | Record<string, unknown>

export interface OpenAICompactResponse {
  output: OpenAICompactOutputItem[]
}

/**
 * Build the compact request body from a canonical request.
 * Reuses the Responses body builder, then drops stream/store/max_output
 * fields the compact endpoint does not want.
 */
export function buildOpenAIResponsesCompactBody(
  req: CanonicalRequest,
  model: ModelEntry,
): OpenAIResponsesCompactBody {
  const full = buildOpenAIResponsesBody(req, model)
  const body: OpenAIResponsesCompactBody = {
    model: full.model,
    input: full.input,
  }
  if (full.instructions) body.instructions = full.instructions
  if (full.tools) body.tools = full.tools
  if (full.parallel_tool_calls !== undefined) body.parallel_tool_calls = full.parallel_tool_calls
  if (full.reasoning) body.reasoning = full.reasoning
  if (full.service_tier) body.service_tier = full.service_tier
  return body
}

/** Resolve the compact URL for API-key vs ChatGPT-Codex OAuth. */
export function openAICompactUrl(auth: ProviderAuth): string {
  if (auth.kind === "oauth" && auth.baseUrl) {
    return `${auth.baseUrl.replace(/\/+$/, "")}${CHATGPT_CODEX_RESPONSES_COMPACT_PATH}`
  }
  return RESPONSES_COMPACT_URL
}

/**
 * Call the remote compact endpoint and return parsed `output` items.
 * Throws on non-2xx or malformed JSON.
 */
export async function callOpenAIResponsesCompact(opts: {
  req: CanonicalRequest
  model: ModelEntry
  ctx: RunContext
  headers: Record<string, string>
  networkClient: NetworkClient
}): Promise<OpenAICompactOutputItem[]> {
  const { req, model, ctx, headers, networkClient } = opts
  const auth = ctx.auth
  const body = buildOpenAIResponsesCompactBody(req, model)
  if (auth.kind === "oauth") {
    // Compact is unary; OAuth/Codex still expects no store chain.
    // max_output_tokens is not part of the compact body builder.
  }
  const url = openAICompactUrl(auth)
  ctx.debug?.header(`POST ${url}`)
  ctx.debug?.kv("model", body.model)
  ctx.debug?.kv("surface", "responses-compact")
  ctx.debug?.headers(headers)
  ctx.debug?.body(body)

  const response = await networkClient.request({
    label: "openai.responses.compact",
    method: "POST",
    url,
    headers,
    body: JSON.stringify(body),
    signal: req.signal,
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`OpenAI Responses Compact API ${response.status}: ${text}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`OpenAI Responses Compact API: invalid JSON body`)
  }
  const output = (parsed as OpenAICompactResponse | null)?.output
  if (!Array.isArray(output)) {
    throw new Error(`OpenAI Responses Compact API: missing output array`)
  }
  return output as OpenAICompactOutputItem[]
}

/**
 * The checkpoint prose after the tag (the old bytes). It was a part of the
 * old tag template; now the tag comes from the sideband API.
 */
export const REMOTE_CHECKPOINT_PROSE = "[context compacted by provider]"
/** The checkpoint prose when the endpoint keeps no item. */
export const REMOTE_EMPTY_CHECKPOINT_PROSE = "[context compacted by provider: no retained items]"

/** The sideband kind of the checkpoint tag (declared by ma-turn-recovery-plugin). */
const COMPACTION_KIND = "compaction"

/**
 * The checkpoint text: the `compaction` tag line that `sb` renders, then
 * `prose`. Same rule as the core checkpoint: with no codec, or with no
 * `compaction` kind (its plugin is off), the tag is `""` and the text is the
 * prose alone. The kind has no body, so no text is lost.
 */
function checkpointText(
  sb: SidebandApi | undefined,
  attrs: { kind: "remote" | "remote-empty"; enc?: string },
  prose: string,
): string {
  const tag =
    sb?.ready === true && sb.kindInfo(COMPACTION_KIND) !== undefined
      ? sb.render(COMPACTION_KIND, { attrs })
      : ""
  return tag === "" ? prose : `${tag}\n${prose}`
}

/**
 * Fold compact endpoint output into plain user/assistant text messages
 * the rest of minimal-agent can store without a new ContentBlock type.
 *
 * - encrypted compaction items → one system-visible checkpoint string
 * - message items with text → role-preserving text messages
 * - everything else dropped (tools, triggers, developer wrappers)
 *
 * @param output - The compact endpoint output items.
 * @param sb - The session sideband API (`RunContext.sideband`). It renders
 *   the checkpoint tag. Absent: the checkpoint is the prose alone.
 */
export function compactOutputToMessages(
  output: OpenAICompactOutputItem[],
  sb: SidebandApi | undefined,
): Array<{ role: "user" | "assistant" | "system"; content: string }> {
  const out: Array<{ role: "user" | "assistant" | "system"; content: string }> = []
  for (const item of output) {
    if (!item || typeof item !== "object") continue
    const type = typeof item.type === "string" ? item.type : ""
    if (type === "compaction" || type === "compaction_summary" || type === "context_compaction") {
      const enc =
        typeof (item as { encrypted_content?: unknown }).encrypted_content === "string"
          ? (item as { encrypted_content: string }).encrypted_content
          : ""
      // Keep encrypted blob so a future encoder can rehydrate wire items.
      // Also give the model a readable checkpoint line.
      const marker = checkpointText(
        sb,
        enc ? { kind: "remote", enc: encodeURIComponent(enc) } : { kind: "remote" },
        REMOTE_CHECKPOINT_PROSE,
      )
      out.push({ role: "user", content: marker })
      continue
    }
    if (type === "message") {
      const roleRaw =
        typeof (item as { role?: unknown }).role === "string"
          ? (item as { role: string }).role
          : "user"
      const role: "user" | "assistant" | "system" =
        roleRaw === "assistant" || roleRaw === "system" ? roleRaw : "user"
      if (roleRaw === "developer") continue
      const text = extractMessageText((item as { content?: unknown }).content)
      if (text.trim().length === 0) continue
      out.push({ role, content: text })
      continue
    }
    // Drop function_call / outputs / compaction_trigger / other.
  }
  if (out.length === 0) {
    out.push({
      role: "user",
      content: checkpointText(sb, { kind: "remote-empty" }, REMOTE_EMPTY_CHECKPOINT_PROSE),
    })
  }
  return out
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const part of content) {
    if (!part || typeof part !== "object") continue
    const p = part as { type?: string; text?: string }
    if (
      (p.type === "input_text" || p.type === "output_text" || p.type === "text") &&
      typeof p.text === "string"
    ) {
      parts.push(p.text)
    }
  }
  return parts.join("\n")
}

// Keep path constants import-reachable for tests without exporting thrice.
void RESPONSES_COMPACT_PATH
