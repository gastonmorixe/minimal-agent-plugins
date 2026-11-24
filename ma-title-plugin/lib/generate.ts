/**
 * The one path that makes an AI title: model choice, the side request and
 * the check of the result. The `prompt.submitted` handler and the
 * `SessionTitle` tool both use it.
 *
 * @module lib/generate
 */

import systemPromptText from "../prompts/system.md" with { type: "text" }

import {
  readTitleEnv,
  resolveModelOverride,
  resolveTitleLanguage,
  type TitleConfig,
} from "./config.ts"
import type {
  LlmSideRequest,
  LlmSideResult,
  ModelsReadApi,
  RunModeFact,
  TitleSideband,
} from "./host-types.ts"
import { type ModelSelection, selectTitleModel } from "./model-select.ts"
import { type TitleValidation, validateTitleResult } from "./sanitize.ts"

/**
 * UI refresh event. The plugin emits it after `setTitle` wrote a title. A
 * live-area slot that names it in `refreshOn` runs at once, so the new title
 * shows without a wait for the next timer tick. The intercom footer slot
 * (`ma-intercom-plugin`, slot `intercom_beat`) does this.
 *
 * The name is a contract with the `refreshOn` list of that manifest. A test
 * in `tests/` checks that the two stay equal.
 */
export const TITLE_SAVED_EVENT = "title.saved"

/**
 * Payload of {@link TITLE_SAVED_EVENT}. It is a hint, not the source of
 * truth: core can change the text again when it writes the sidecar line. A
 * subscriber that paints the title reads it with `sessions.title(sid)`. This
 * also shows the title of a resumed session, for which no event comes.
 */
export interface TitleSavedEvent {
  sid: string
  title: string
  /** `ai` for an automatic title, `user` for a title that the tool locked. */
  source: "ai" | "user"
}

/**
 * Max output tokens of the title call (SPEC §5.7 item 7). 80 title characters
 * in CJK text plus the JSON wrapper can be more than 128 tokens. The API bills
 * the real output, not the cap.
 */
export const TITLE_MAX_TOKENS = 256

/**
 * The system prompt (SPEC §5.3), inlined by a text import. It holds all the
 * rules. The user message is the `<session>` block and one language line
 * (`buildTitleInput`), the same layout as Claude Code.
 */
export const SYSTEM_PROMPT = systemPromptText.trim()

/**
 * The output schema (SPEC §5.2). A constant: the provider caches the grammar.
 * The `description` is the STE form of the SPEC text, because the STE gate
 * does not accept the SPEC words (T2 deviation 2).
 */
export const TITLE_SCHEMA: Record<string, unknown> = Object.freeze({
  type: "object",
  properties: {
    title: { type: "string", description: "A title of 2 to 6 words" },
  },
  required: ["title"],
  additionalProperties: false,
})

/** Input of {@link chooseTitleModel}. */
export interface ModelChoiceInput {
  models: ModelsReadApi | undefined
  run: RunModeFact | undefined
  /** The model of the session (`ctx.agent.model`). */
  agentModel: string | undefined
  config: TitleConfig
  env: NodeJS.ProcessEnv
}

/** Result of {@link chooseTitleModel}. */
export interface ModelChoice {
  choice: ModelSelection
  /** The live session provider, when the plugin found one. */
  sessionProviderId: string | undefined
}

/**
 * Choose the title model (SPEC §4.3): the provider title profile only. The
 * live provider is the run fact, else the provider of the session model.
 */
export function chooseTitleModel(input: ModelChoiceInput): ModelChoice {
  const { models, agentModel, config } = input
  let sessionProviderId = input.run?.providerId
  if (!sessionProviderId && agentModel && models) {
    try {
      sessionProviderId = models.find(agentModel)?.providerId
    } catch {
      sessionProviderId = undefined
    }
  }
  const choice = selectTitleModel({
    models,
    sessionProviderId,
    override: resolveModelOverride(config, readTitleEnv(input.env)),
    ...(config.effort ? { effort: config.effort } : {}),
    maxUsdPerMTokIn: config.maxUsdPerMTokIn,
  })
  return { choice, sessionProviderId }
}

/** The title language after precedence (env, then config). */
export function titleLanguage(config: TitleConfig, env: NodeJS.ProcessEnv): string | undefined {
  return resolveTitleLanguage(config, readTitleEnv(env))
}

/** Make the side request of one title call. */
export function buildTitleRequest(
  choice: Extract<ModelSelection, { ok: true }>,
  userText: string,
  config: TitleConfig,
  abortSignal: AbortSignal,
): LlmSideRequest {
  return {
    purpose: "title",
    model: choice.modelId,
    system: SYSTEM_PROMPT,
    userText,
    maxTokens: TITLE_MAX_TOKENS,
    timeoutMs: config.timeoutMs,
    thinking: "off",
    ...(choice.effort ? { effort: choice.effort } : {}),
    outputSchema: { name: "session_title", schema: TITLE_SCHEMA, strict: true },
    abortSignal,
    maxUsdPerMTokIn: config.maxUsdPerMTokIn,
  }
}

/** Parse the result JSON. Use the text when the host gave no `json`. */
export function resultJson(res: LlmSideResult): unknown {
  if (res.json !== undefined) return res.json
  try {
    return JSON.parse(res.text)
  } catch {
    return undefined
  }
}

/** Check the result of one title call (SPEC §5.5). Never throws. */
export function checkTitleResult(res: LlmSideResult, sb: TitleSideband): TitleValidation {
  return validateTitleResult({ stopReason: res.stopReason, json: resultJson(res) }, sb)
}
