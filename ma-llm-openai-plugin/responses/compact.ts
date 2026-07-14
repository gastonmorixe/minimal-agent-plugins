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

import type { CanonicalRequest } from "../lib/canonical-request.ts"
import type { ModelEntry } from "../lib/host-types.ts"
import type { NetworkClient } from "../lib/net-types.ts"
import type { ProviderAuth, RunContext } from "../lib/provider-auth.ts"
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
 * Portable marker prefix used when folding opaque compact items into
 * agent Message history as text. The next Responses encode path may
 * later rehydrate known markers; until then the model still sees a
 * clear checkpoint string.
 */
export const COMPACTION_MARKER_PREFIX = "<ma::context::compaction "

/**
 * Fold compact endpoint output into plain user/assistant text messages
 * the rest of minimal-agent can store without a new ContentBlock type.
 *
 * - encrypted compaction items → one system-visible checkpoint string
 * - message items with text → role-preserving text messages
 * - everything else dropped (tools, triggers, developer wrappers)
 */
export function compactOutputToMessages(
  output: OpenAICompactOutputItem[],
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
      const marker = enc
        ? `${COMPACTION_MARKER_PREFIX}kind="remote" enc="${encodeURIComponent(enc)}" />\n[context compacted by provider]`
        : `${COMPACTION_MARKER_PREFIX}kind="remote" />\n[context compacted by provider]`
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
      content: `${COMPACTION_MARKER_PREFIX}kind="remote-empty" />\n[context compacted by provider; no retained items]`,
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
