/**
 * Title model choice (SPEC §4.3, R11). Pure: it reads only the `models:read`
 * view that it gets.
 *
 * Titles work provider by provider. The session provider must advertise a
 * title profile (`models.utilityFor(sessionProvider)`, which is the adapter
 * `recommendUtilityModel()`). No profile → no call (`no-model`). There is no
 * fallback by model tags and no fallback to the session model.
 *
 * Order:
 * 1. Override (`MINIMAL_AGENT_TITLE_MODEL` \> `plugins.title.model`), only
 *    when the provider has a profile, and only for a model of the session
 *    provider. An override of another provider stops the choice (no call),
 *    because the user asked for that model.
 * 2. The profile model.
 *
 * Each candidate must have JSON-schema output and a known input price at or
 * below `maxUsdPerMTokIn` (`$0` passes: subscription or local). An override
 * that fails goes to step 2. The effort comes from the profile, unless the
 * config sets it.
 *
 * @module lib/model-select
 */

import type { ModelRate, ModelsReadApi, ModelView, TitleEffort } from "./host-types.ts"

/** The step that gave the model. */
export type ModelStep = "override" | "profile"

/** Why a candidate was refused. */
export type CandidateReject =
  | "not-found"
  | "other-provider"
  | "no-structured-output"
  | "unknown-price"
  | "over-ceiling"

/** Why no model was chosen (diagnostics `stopReason`). */
export type NoModelReason = "no-model" | "over-ceiling" | "other-provider"

/** Input of {@link selectTitleModel}. */
export interface ModelSelectInput {
  models: ModelsReadApi | undefined
  /** The live session provider (`ctx.run.providerId`, else the provider of `ctx.agent.model`). */
  sessionProviderId: string | undefined
  /** The override id, after precedence. */
  override?: string
  /** The config effort (`plugins.title.effort`). It replaces the profile effort. */
  effort?: TitleEffort
  maxUsdPerMTokIn: number
}

/** One refused candidate (for the debug log). */
export interface RejectedCandidate {
  step: ModelStep
  modelId: string
  reason: CandidateReject
}

/** Result of {@link selectTitleModel}. */
export type ModelSelection =
  | {
      ok: true
      modelId: string
      providerId: string
      step: ModelStep
      /** The effort to send. `undefined`: no effort (the profile and the config set none). */
      effort?: TitleEffort
      rejected: RejectedCandidate[]
    }
  | { ok: false; reason: NoModelReason; rejected: RejectedCandidate[] }

/** True when `pricing.inputUSD` is a known price at or below the ceiling. */
export function priceCheck(
  pricing: ModelRate | undefined,
  ceiling: number,
): CandidateReject | null {
  const price = pricing?.inputUSD
  if (typeof price !== "number" || !Number.isFinite(price) || price < 0) return "unknown-price"
  return price <= ceiling ? null : "over-ceiling"
}

function lookup(models: ModelsReadApi, id: string, providerId: string): ModelView | undefined {
  return models.findForProvider(id, providerId) ?? models.find(id)
}

/**
 * Choose the title model. Never throws: a throwing `models` view gives
 * `no-model`.
 */
export function selectTitleModel(input: ModelSelectInput): ModelSelection {
  const rejected: RejectedCandidate[] = []
  const { models, sessionProviderId: provider } = input
  const none = (reason: NoModelReason): ModelSelection => ({ ok: false, reason, rejected })
  if (!models || !provider) return none("no-model")

  try {
    // The title profile of the session provider. No profile, no title.
    const rec = models.utilityFor?.(provider)
    if (!rec || rec.providerId !== provider) return none("no-model")
    if (rec.structured !== "json_schema") {
      rejected.push({ step: "profile", modelId: rec.modelId, reason: "no-structured-output" })
      return none("no-model")
    }
    const effort = input.effort ?? rec.effort
    const ok = (modelId: string, step: ModelStep): ModelSelection => ({
      ok: true,
      modelId,
      providerId: provider,
      step,
      ...(effort ? { effort } : {}),
      rejected,
    })

    // Step 1: override (same provider only).
    if (input.override) {
      const view = lookup(models, input.override, provider)
      if (!view) {
        rejected.push({ step: "override", modelId: input.override, reason: "not-found" })
      } else if (view.providerId !== provider) {
        rejected.push({ step: "override", modelId: view.id, reason: "other-provider" })
        return none("other-provider")
      } else {
        const why =
          view.capabilities?.structuredOutputs === true
            ? priceCheck(view.pricing, input.maxUsdPerMTokIn)
            : "no-structured-output"
        if (why === null) return ok(view.id, "override")
        rejected.push({ step: "override", modelId: view.id, reason: why })
      }
    }

    // Step 2: the profile model.
    const view = models.findForProvider(rec.modelId, provider)
    const why = priceCheck(rec.pricing ?? view?.pricing, input.maxUsdPerMTokIn)
    if (why === null) return ok(rec.modelId, "profile")
    rejected.push({ step: "profile", modelId: rec.modelId, reason: why })
  } catch {
    return none("no-model")
  }

  const priceOnly = rejected.some(
    (r) => r.reason === "over-ceiling" || r.reason === "unknown-price",
  )
  return none(priceOnly ? "over-ceiling" : "no-model")
}
