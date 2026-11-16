/**
 * Shared MODEL-gated beta-flag decisions for the Anthropic wire builders.
 *
 * Refactor Wave 2a: both transports' flag assemblers used to hand-mirror
 * these decisions ("this MUST mirror the canonical transport's test"
 * comments in each), and every new-model wire bug so far (the fable-5
 * context-1m P0, the duplicated opus-4-8 interleaved gate) came from that
 * split. This module is the single source of truth for the decisions that
 * depend on WHICH model is addressed; the per-request-kind set composition
 * stays in each builder (unified later, at the transport flip).
 *
 * Resolution order: model registry capabilities when the id is registered
 * (or aliased, incl. `[1m]` suffixes); otherwise a conservative substring
 * fallback that preserves the legacy behavior for unregistered ids.
 *
 * Lives in the PROVIDER PLUGIN: Anthropic logic belongs here, never in
 * core. The legacy `src/headers.ts` importing from this plugin is an
 * acknowledged inversion that exists only because headers.ts itself is
 * misplaced Anthropic code awaiting dissolution (Wave 4); the entire
 * legacy module migrates here, at which point the import collapses to a
 * plugin-internal one. Do NOT read this as license for core → plugin
 * imports elsewhere.
 *
 * @module llm/providers/anthropic/beta-gates
 */

import { findModel } from "./lib/registry.ts"

/**
 * Model families claude-code 2.1.325 marks `native_1m:!0` in its model catalog
 * (CC/chunk-tbvds061.mjs, `context:{window:1e6,native_1m:!0,…}`): opus-4-7,
 * opus-4-8, opus-5, opus-5-5, sonnet-5, sonnet-5-5, haiku-5-5, fable-5,
 * fable-5-1, fable-5-2, mythos-5/5-1/5-2. CC never adds `context-1m` for them
 * unless the id carries `[1m]`: `T4r(e,n)=(Ug(e)||g6o(n)?.includes(nC.header)
 * &&X0e(e))&&!r`, `Ug` = `/\[1m\]/i` (CC/chunk-e44qnbvj.mjs), and the
 * 2.1.325 MAIN capture for opus-5-5 has no context-1m
 * (research/2026-11-15-cc-2.1.325-oauth-diff/cc-wire.md §1.2).
 * Substring match, so `claude-opus-5` also covers `claude-opus-5-5`.
 * Fable is listed separately ({@link FABLE_KEEPS_1M_BETA}).
 */
const CC_NATIVE_1M_FAMILIES = [
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-5-5",
  "claude-mythos-5",
] as const

/**
 * Fable-5 / 5.1 / 5.2 are native-1M in the CC 2.1.325 catalog too, but we KEEP
 * sending `context-1m` for them. History: the June fable-5 P0
 * (minimal-agent-core 97c0191, docs-archive/2026-06-09-fable-5-hardening-
 * and-headers-decoupling.md): plain `claude-fable-5` missed this beta and
 * long sessions were expected to 400 past ~200k while compaction (sized for
 * 1M) never fired. No wire capture proves fable past 200k without the beta,
 * and sending it is what works today, so dropping it for fable waits for one
 * live >200k probe (research diff B1). Remove `claude-fable-5` from here once
 * that probe passes.
 */
const FABLE_KEEPS_1M_BETA = ["claude-fable-5"] as const

/**
 * Should requests for `modelId` carry `context-1m-2025-08-07`?
 *
 * - `[1m]` client-side suffix: always (CC `Ug(e)`).
 * - Fable family: yes when 1M-capable (the fable-5 P0 guard, see
 *   {@link FABLE_KEEPS_1M_BETA}).
 * - CC native-1M families ({@link CC_NATIVE_1M_FAMILIES}): no, the window is
 *   1M without the beta.
 * - Other registered models: when the registered context window is 1M+
 *   (beta-gated 1M: opus-4-6, sonnet-4-6, sonnet-4-5, whose CC catalog entry
 *   is `window:200000,maximum_window:1e6,supports_1m_beta:!0`).
 * - Unregistered ids: the beta-gated 1M families opus-4-6 / sonnet-4-6.
 *
 * Historical caveat (T-f51m29): pre-overage accounts 429 on sonnet long
 * context ("Extra usage is required..."); `parseModelUnavailableError`
 * catches that shape and reopens the model picker.
 */
export function wants1mContext(modelId: string | undefined): boolean {
  if (!modelId) return false
  if (/\[1m\]/i.test(modelId)) return true
  const entry = findModel(modelId)
  const id = (entry?.id ?? modelId).toLowerCase()
  const is1m = entry ? entry.capabilities.contextWindow >= 1_000_000 : undefined
  if (FABLE_KEEPS_1M_BETA.some((f) => id.includes(f))) return is1m ?? true
  if (CC_NATIVE_1M_FAMILIES.some((f) => id.includes(f))) return false
  if (is1m !== undefined) return is1m
  return id.includes("opus-4-6") || id.includes("sonnet-4-6")
}

/**
 * Should `interleaved-thinking-2025-05-14` be OMITTED for `modelId`?
 *
 * Opus 4.8 only: under this beta it emits huge parallel tool batches whose
 * mid-turn thinking hallucinates same-turn tool results and spirals
 * (wire-proven; TODOS.md T-7c3f02). The gate is id-based on purpose: the
 * pathology tracks the MODEL, and no capability field expresses it.
 * Fable-5 (the 4.8 capability twin) currently KEEPS the beta pending the
 * T-fab1e5 wire test; extend the match here (one place now) if it shares
 * the behavior. `MINIMAL_AGENT_FORCE_INTERLEAVED_THINKING=1` overrides
 * for experiments.
 */
export function omitsInterleavedThinking(modelId: string | undefined): boolean {
  if (process.env.MINIMAL_AGENT_FORCE_INTERLEAVED_THINKING === "1") return false
  return !!modelId && modelId.includes("opus-4-8")
}

/**
 * Exact-family match: `modelId` contains `family` and the next character is
 * not a digit or a `-<digit>` minor version (so `claude-opus-5` does not match
 * `claude-opus-5-5`, but `claude-opus-5-5-20261001` matches `claude-opus-5-5`).
 */
function matchesFamily(modelId: string, family: string): boolean {
  const id = modelId.toLowerCase()
  const at = id.indexOf(family)
  if (at < 0) return false
  const rest = id.slice(at + family.length)
  return !/^\d/.test(rest) && !/^-\d(?!\d{7})/.test(rest)
}

/**
 * Model families whose claude-code 2.1.325 catalog entry lists the
 * `per_turn_effort` capability (CC/chunk-tbvds061.mjs `capabilities:[…,
 * "per_turn_effort",…]`): haiku-5-5, sonnet-5-5, opus-5-5, fable-5-1,
 * fable-5-2, mythos-5-2. CC gates `per-turn-control-2026-07-01` on it:
 * `o4t(...)=OS()&&VY(..)&&yw(n,"per_turn_effort",…)===!0` (CC/chunk-e44qnbvj.mjs,
 * research/2026-11-15-cc-2.1.325-oauth-diff/betas-headers.md §2).
 */
export const CC_PER_TURN_EFFORT_MODELS = [
  "claude-haiku-5-5",
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  "claude-fable-5-1",
  "claude-fable-5-2",
  "claude-mythos-5-2",
] as const

/** Should requests for `modelId` carry `per-turn-control-2026-07-01`? */
export function wantsPerTurnControl(modelId: string | undefined): boolean {
  if (!modelId) return false
  const id = findModel(modelId)?.id ?? modelId
  return CC_PER_TURN_EFFORT_MODELS.some((f) => matchesFamily(id, f))
}

/**
 * Model families whose CC 2.1.325 catalog entry lists `mid_conv_tool_change`
 * (CC/chunk-tbvds061.mjs): haiku-5-5, sonnet-5-5, opus-4-8, opus-5, opus-5-5,
 * fable-5/5-1/5-2, mythos-5-1/5-2. CC's gate `F_e(e)` also requires
 * mid-conversation system support (`AS(e)`) and returns true for
 * `claude-mythos-5` (CC/chunk-e44qnbvj.mjs, betas-headers.md §3). So Sonnet 5,
 * Sonnet 4.6, Opus 4.6/4.7 do NOT get it even though they take role:system
 * messages.
 */
export const CC_MID_CONV_TOOL_CHANGE_MODELS = [
  "claude-haiku-5-5",
  "claude-sonnet-5-5",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-opus-5-5",
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-fable-5-2",
  "claude-mythos-5",
  "claude-mythos-5-1",
  "claude-mythos-5-2",
] as const

/**
 * Should requests for `modelId` carry `mid-conversation-tool-changes-2026-07-01`?
 * Callers also require `capabilities.midConversationSystem` (the clear-at gate).
 */
export function wantsMidConversationToolChanges(modelId: string | undefined): boolean {
  if (!modelId) return false
  const id = findModel(modelId)?.id ?? modelId
  return CC_MID_CONV_TOOL_CHANGE_MODELS.some((f) => matchesFamily(id, f))
}
