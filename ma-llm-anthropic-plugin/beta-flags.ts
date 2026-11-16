/**
 * Anthropic beta-flag taxonomy + assembler.
 *
 * Source of truth: claude-code 2.1.325 capture
 * (research/2026-11-15-cc-2.1.325-oauth-diff/cc-wire.md) and the
 * `M(<short>, <header>)` declarations in CC/chunk-29cd2nzs.mjs. Each declared
 * header becomes one {@link AnthropicBetaFlag} entry. The assembler picks a subset per request based on capabilities
 * and request shape.
 *
 * The legacy `src/headers.ts` exposes a subset of these as the
 * `BetaFlagId` enum; the canonical adapter migrates to the typed
 * `AnthropicBetaFlag` table so new flags are one append.
 *
 * @module llm/providers/anthropic/beta-flags
 */

import type { AnthropicRequestKind } from "@minimal-agent/core/plugin-api/llm/anthropic-request"
import type { CanonicalRequest } from "@minimal-agent/core/plugin-api/llm/canonical-request"

import { omitsInterleavedThinking, wants1mContext } from "./beta-gates.ts"
import type { ModelEntry } from "./lib/host-types.ts"

/**
 * Every known beta header value. Declaration order IS wire order (the
 * assembler emits flags in this order): it matches the claude-code 2.1.325
 * capture (research/2026-11-15-cc-2.1.325-oauth-diff/cc-wire.md §1.2, MAIN
 * and QUOTA/TITLE sets). Ids come from `M("<name>","<header>")` declarations
 * in CC/chunk-29cd2nzs.mjs (2.1.325). Declaring an id emits nothing; only the
 * gates in {@link buildBetaFlags} put a flag on the wire.
 */
export const ANTHROPIC_BETA_FLAGS = {
  CLAUDE_CODE: "claude-code-20250219",
  OAUTH: "oauth-2025-04-20",
  INTERLEAVED_THINKING: "interleaved-thinking-2025-05-14",
  REDACT_THINKING: "redact-thinking-2026-02-12",
  // CC HQs order: right after interleaved (CC/chunk-29cd2nzs.mjs); never seen on the 2.1.325 wire.
  CONTEXT_1M: "context-1m-2025-08-07",
  CONTEXT_MANAGEMENT: "context-management-2025-06-27",
  PROMPT_CACHING_SCOPE: "prompt-caching-scope-2026-01-05",
  // y3=M("per_message_effort",…) in 2.1.325. Declared only (diff B3).
  PER_TURN_CONTROL: "per-turn-control-2026-07-01",
  // nE=M("mid_conv_tool_change",…) in 2.1.325. Declared only (diff B3).
  MID_CONVERSATION_TOOL_CHANGES: "mid-conversation-tool-changes-2026-07-01",
  // gH=M("ccr_tool_provenance",…) in 2.1.325. Declared only (diff B3).
  TOOL_PROVENANCE: "tool-provenance-2026-10-26",
  THINKING_TOKEN_COUNT: "thinking-token-count-2026-05-13",
  ADVANCED_TOOL_USE: "advanced-tool-use-2025-11-20",
  // _9=M("mid_conversation_system_clear_at",…) in 2.1.325. Declared only (diff B2).
  MID_CONVERSATION_SYSTEM_CLEAR_AT: "mid-conversation-system-clear-at-2026-08-21",
  // Retired upstream: PS=Wc("mid_conversation_system") has a null header in
  // 2.1.325. Still sent by us pending diff B2; same slot as its successor.
  MID_CONVERSATION_SYSTEM: "mid-conversation-system-2026-04-07",
  EFFORT: "effort-2025-11-24",
  STRUCTURED_OUTPUTS: "structured-outputs-2025-12-15",
  // w3=M("thinking_binding_controls",…) in 2.1.325. Declared only (diff B4).
  THINKING_BINDING_CONTROLS: "thinking-binding-controls-2026-08-01",
  // HTe=M("thinking_display_updates",…) in 2.1.325. Declared only (diff B5).
  THINKING_DISPLAY_UPDATES: "thinking-display-updates-2026-08-18",
  EXTENDED_CACHE_TTL: "extended-cache-ttl-2025-04-11",
  CACHE_DIAGNOSIS: "cache-diagnosis-2026-04-07",
  // Position on the CC wire unverified (not observed in 2.1.325 captures):
  TASK_BUDGETS: "task-budgets-2026-03-13",
  FAST_MODE: "fast-mode-2026-02-01",
  WEB_SEARCH: "web-search-2025-03-05",
  TOOL_SEARCH_TOOL: "tool-search-tool-2025-10-19",
  AFK_MODE: "afk-mode-2026-01-31",
  ADVISOR_TOOL: "advisor-tool-2026-03-01",
  CONTEXT_HINT: "context-hint-2026-04-09",
  MCP_SERVERS: "mcp-servers-2025-12-04",
  FILES_API: "files-api-2025-04-14",
  ENVIRONMENTS: "environments-2025-11-01",
  CCR_BYOC: "ccr-byoc-2025-07-29",
} as const

export type AnthropicBetaFlag = (typeof ANTHROPIC_BETA_FLAGS)[keyof typeof ANTHROPIC_BETA_FLAGS]

/**
 * Anthropic request kinds — drives which flags get included before
 * model + capability gating.
 *
 * - `"quota"`: minimal probe (haiku, max_tokens=1, no system).
 * - `"title"`: structured-output title gen on haiku.
 * - `"subtask"`: a tightly-scoped single-tool conversation (one tool,
 *   simple system, no 1h cache). Drops `advanced-tool-use` and
 *   `extended-cache-ttl`.
 * - `"conversation"`: full agentic loop with 1h cache + multi-tool.
 */
// `classifyRequest` + `AnthropicRequestKind` moved to the leaf anthropic-request
// wire contract (they are pure canonical-read, shared by any Anthropic-compatible
// gateway). Re-exported here so this plugin's other importers (headers,
// quota-probe, index, tests) keep the same import path. The registry-coupled
// `buildBetaFlags` below stays local.
export {
  type AnthropicRequestKind,
  classifyRequest,
} from "@minimal-agent/core/plugin-api/llm/anthropic-request"

function hasAny1hTtl(req: CanonicalRequest): boolean {
  const checkBlocks = (blocks?: { cache?: { ttl?: string } }[]) =>
    !!blocks?.some((b) => b.cache?.ttl === "1h")
  if (checkBlocks(req.system as { cache?: { ttl?: string } }[] | undefined)) return true
  for (const msg of req.messages) {
    if (msg.cache?.ttl === "1h") return true
    if (Array.isArray(msg.content) && checkBlocks(msg.content as { cache?: { ttl?: string } }[])) {
      return true
    }
  }
  return false
}

/**
 * CC's first-party N7n gate for thinking-token-count (CC/chunk-e44qnbvj.mjs:
 * `if(r==="claude-haiku-4-5"||r.includes("claude-3-"))return!1;return!0`).
 */
function omitsThinkingTokenCount(modelId: string): boolean {
  return modelId.startsWith("claude-haiku-4-5") || modelId.includes("claude-3-")
}

/**
 * CC's model-age list `NC` (CC/chunk-e44qnbvj.mjs, 2.1.325), oldest first.
 * Used by `MCt(e,n)`: true when `e` is claude-3-* or sits before `n` in NC.
 */
const CC_MODEL_AGE_ORDER = [
  "claude-opus-4-0",
  "claude-sonnet-4-0",
  "claude-opus-4-1",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "claude-opus-4-5",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
] as const

/** Canonical NC entry for `modelId` (CC `lt(e)` approximation), or undefined. */
function ccCanonicalModel(modelId: string): string | undefined {
  const id = modelId.toLowerCase()
  // Dated 4.0 ids (claude-opus-4-20250514 / claude-sonnet-4-20250514) → *-4-0.
  const dated40 = /claude-(opus|sonnet)-4-\d{8}/.exec(id)
  if (dated40) return `claude-${dated40[1]}-4-0`
  return CC_MODEL_AGE_ORDER.find(
    (m) => id.includes(m) && !/\d/.test(id.charAt(id.indexOf(m) + m.length)),
  )
}

/**
 * CC's off-first-party age gate `ZYs(e)=!MCt(lt(e),"claude-opus-4-7")`
 * (CC/chunk-e44qnbvj.mjs). True when `modelId` is older than opus-4-7.
 * Ids not in NC (opus-5-x, fable-5, …) are not "older" (indexOf === -1).
 */
function isOlderThanOpus47(modelId: string): boolean {
  if (modelId.includes("claude-3-")) return true
  const canon = ccCanonicalModel(modelId)
  if (!canon) return false
  return (
    CC_MODEL_AGE_ORDER.indexOf(canon as (typeof CC_MODEL_AGE_ORDER)[number]) <
    CC_MODEL_AGE_ORDER.indexOf("claude-opus-4-7")
  )
}

/**
 * Build the `anthropic-beta` header value as an ordered list of flag
 * values. Order matches the claude-code 2.1.325 capture
 * (research/2026-11-15-cc-2.1.325-oauth-diff).
 *
 * `auth.kind === "oauth"` is required for first-party betas.
 *
 * Caller-supplied overrides (`req.vendor?.anthropic?.betaOverrides`)
 * apply LAST so an opt-out can drop a default flag.
 */
export function buildBetaFlags(opts: {
  kind: AnthropicRequestKind
  req: CanonicalRequest
  model: ModelEntry
  authKind: "oauth" | "api-key" | "custom"
}): AnthropicBetaFlag[] {
  const { kind, req, model, authKind } = opts
  const flags = new Set<AnthropicBetaFlag>()

  const isOAuth = authKind === "oauth"
  if (isOAuth) flags.add(ANTHROPIC_BETA_FLAGS.OAUTH)
  // Interleaved thinking: omitted only for the tool-batch-spiral models
  // (opus-4-8, T-7c3f02). Decision shared with the legacy builder via
  // src/llm/anthropic-beta-gates.ts so the transports cannot drift.
  if (!omitsInterleavedThinking(model.id)) {
    flags.add(ANTHROPIC_BETA_FLAGS.INTERLEAVED_THINKING)
  }
  // redact-thinking: PROBE kinds only (quota/title). Conversations (and
  // subtasks) deliberately omit it so thinking streams stay visible in the
  // TUI — a product feature, not an accident. Decision B3 option (a) from
  // the Wave-3 flip package (docs/changes/2026-06-09-…-decoupling.md),
  // executed in the B-0 flip: the canonical builder aligned to the legacy
  // builder, collapsing the cross-transport divergence into an agreement
  // (pinned in ./beta-flags.characterization.test.ts).
  if (kind === "quota" || kind === "title") {
    flags.add(ANTHROPIC_BETA_FLAGS.REDACT_THINKING)
  }
  flags.add(ANTHROPIC_BETA_FLAGS.CONTEXT_MANAGEMENT)
  if (isOAuth) flags.add(ANTHROPIC_BETA_FLAGS.PROMPT_CACHING_SCOPE)

  switch (kind) {
    case "quota":
      break
    case "title":
      flags.add(ANTHROPIC_BETA_FLAGS.STRUCTURED_OUTPUTS)
      break
    case "subtask":
    case "conversation":
      flags.add(ANTHROPIC_BETA_FLAGS.CLAUDE_CODE)
      // 1M context: shared gate (src/llm/anthropic-beta-gates.ts). The
      // request's id carries any [1m] opt-in; the registered model's
      // capabilities decide the native case. Same predicate as the legacy
      // builder, pinned by the cross-transport agreement walk.
      if (wants1mContext(req.modelId) || wants1mContext(model.id)) {
        flags.add(ANTHROPIC_BETA_FLAGS.CONTEXT_1M)
      }
      // thinking-token-count: CC 2.1.325 pushes zW when
      // `U1t(Nt)&&wn.thinking.supported` (CC/chunk-wqb2b4v0.mjs), with
      // `U1t(e)=!v3()&&N7n(e)&&(nye()||ZYs(e))`. nye() is true for the
      // firstParty provider (CC/chunk-29cd2nzs.mjs), so the model-age gate
      // ZYs(e)=!MCt(lt(e),"claude-opus-4-7") only applies on bedrock/vertex.
      // On first party the model gate is N7n (CC/chunk-e44qnbvj.mjs): false
      // only for claude-haiku-4-5 and claude-3-*. So opus-4-6/sonnet-4-6 DO
      // get it from CC on the api.anthropic.com wire. If the server still
      // rejects it ("invalid beta flag"), the adapter drops it and retries
      // (CC's x0o heal). Server reports usage.output_tokens_details.thinking_tokens.
      // Opt-out: MINIMAL_AGENT_NO_THINKING_TOKEN_COUNT=1.
      // authKind "custom" (third-party base URL) is not first party, so nye()
      // is false there and ZYs applies: skip models older than opus-4-7.
      if (
        (model.capabilities.thinking.adaptive || model.capabilities.thinking.extended) &&
        !omitsThinkingTokenCount(model.id) &&
        !(authKind === "custom" && isOlderThanOpus47(model.id)) &&
        process.env.MINIMAL_AGENT_NO_THINKING_TOKEN_COUNT !== "1"
      ) {
        flags.add(ANTHROPIC_BETA_FLAGS.THINKING_TOKEN_COUNT)
      }
      if (model.capabilities.midConversationSystem) {
        flags.add(ANTHROPIC_BETA_FLAGS.MID_CONVERSATION_SYSTEM)
      }
      if (req.effort && model.capabilities.effort.levels.length > 0) {
        flags.add(ANTHROPIC_BETA_FLAGS.EFFORT)
      }
      if (kind === "conversation") {
        if (model.capabilities.tools.parallel || model.capabilities.tools.fineGrainedStreaming) {
          flags.add(ANTHROPIC_BETA_FLAGS.ADVANCED_TOOL_USE)
        }
        if (hasAny1hTtl(req)) {
          flags.add(ANTHROPIC_BETA_FLAGS.EXTENDED_CACHE_TTL)
        }
      }
      if (req.vendor?.anthropic?.taskBudget) {
        flags.add(ANTHROPIC_BETA_FLAGS.TASK_BUDGETS)
      }
      if (req.speed === "fast" && model.capabilities.speedFast) {
        flags.add(ANTHROPIC_BETA_FLAGS.FAST_MODE)
      }
      if (req.vendor?.anthropic?.cacheDiagnostics) {
        flags.add(ANTHROPIC_BETA_FLAGS.CACHE_DIAGNOSIS)
      }
      break
  }

  // Caller overrides (additions first, then removals).
  const overrides = req.vendor?.anthropic?.betaOverrides
  if (overrides?.add) for (const flag of overrides.add) flags.add(flag as AnthropicBetaFlag)
  if (overrides?.remove)
    for (const flag of overrides.remove) flags.delete(flag as AnthropicBetaFlag)

  // Preserve declaration order so snapshots are stable.
  const ordered: AnthropicBetaFlag[] = []
  for (const value of Object.values(ANTHROPIC_BETA_FLAGS)) {
    if (flags.has(value)) ordered.push(value)
  }
  return ordered
}
