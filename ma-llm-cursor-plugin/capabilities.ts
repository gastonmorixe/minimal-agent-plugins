import { type Capabilities, defaultCapabilities } from "./lib/capabilities.ts"
import type { CursorModelVariant, DecodedCursorModel } from "./proto/models-decode.ts"

export interface CursorCapsOptions {
  contextWindow?: number
  maxOutputTokens?: number
  thinking?: boolean
  vision?: boolean
  effortLevels?: ReadonlyArray<string>
  maxMode?: boolean
}

const DEFAULT_CONTEXT_WINDOW = 128_000
const DEFAULT_OUTPUT_TOKENS = 16_384
/** Fallback ladder when model supports thinking but catalog omits parameter defs. */
const DEFAULT_EFFORT_LEVELS = ["low", "medium", "high", "max"] as const

/**
 * Canonical effort labels we accept from Cursor parameter_definitions /
 * variant parameterValues. Order is intentional for UI defaults.
 */
const KNOWN_EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max", "standard", "grind"] as const

const EFFORT_PARAM_IDS = new Set(["effort", "thinking", "reasoning", "reasoning_effort"])

function normalizeEffortLabel(raw: string): string | undefined {
  const v = raw.trim().toLowerCase()
  if (!v) return undefined
  // Reject pure numeric CloudAgentEffortMode ordinals leaked as strings.
  if (/^\d+$/.test(v)) return undefined
  // Strip common prefixes from enum names if any leak through.
  const stripped = v
    .replace(/^cloud_agent_effort_mode_/, "")
    .replace(/^prompt_effort_level_/, "")
    .replace(/^effort_/, "")
  if (!stripped || /^\d+$/.test(stripped)) return undefined
  return stripped
}

function sortEffortLevels(levels: Iterable<string>): string[] {
  const unique = [...new Set(levels)]
  const rank = new Map<string, number>(KNOWN_EFFORT_ORDER.map((l, i) => [l, i]))
  return unique.sort((a, b) => {
    const ra = rank.get(a) ?? 100 + a.localeCompare(b)
    const rb = rank.get(b) ?? 100 + b.localeCompare(a)
    if (ra !== rb) return ra - rb
    return a.localeCompare(b)
  })
}

/**
 * Collect effort level strings from field 29 parameter_definitions and
 * field 30 variant parameterValues. Does **not** map CloudAgentEffortMode
 * ordinals (0/1/2 = unspecified/standard/grind) to the product ladder.
 */
export function extractCursorEffortLevels(model: DecodedCursorModel): string[] {
  const found = new Set<string>()

  for (const def of model.parameterDefinitions ?? []) {
    const id = (def.id ?? def.name ?? "").toLowerCase()
    const looksEffort = EFFORT_PARAM_IDS.has(id) || id.includes("effort") || id.includes("thinking")
    if (!looksEffort && (def.enumValues?.length ?? 0) === 0) continue
    // Prefer enum values when present; if id is effort-like accept them.
    if (def.enumValues?.length) {
      if (!looksEffort && !def.enumValues.some((v) => normalizeEffortLabel(v.value ?? ""))) {
        continue
      }
      for (const entry of def.enumValues) {
        const label = normalizeEffortLabel(entry.value ?? entry.displayName ?? "")
        if (label) found.add(label)
      }
    }
  }

  for (const variant of model.variants ?? []) {
    for (const pv of variant.parameterValues ?? []) {
      const pid = (pv.id ?? "").toLowerCase()
      if (!EFFORT_PARAM_IDS.has(pid) && !pid.includes("effort")) continue
      const label = normalizeEffortLabel(pv.value ?? "")
      if (label) found.add(label)
    }
  }

  return sortEffortLevels(found)
}

/**
 * Prefer non-max context for default listing; fall back to max-mode limit,
 * then package default. Live catalog often omits both — defaults still show.
 */
export function resolveCursorContextWindow(model: DecodedCursorModel): number {
  if (typeof model.contextTokenLimit === "number" && model.contextTokenLimit > 0) {
    return model.contextTokenLimit
  }
  if (
    typeof model.contextTokenLimitForMaxMode === "number" &&
    model.contextTokenLimitForMaxMode > 0
  ) {
    return model.contextTokenLimitForMaxMode
  }
  if (typeof model.autoContextMaxTokens === "number" && model.autoContextMaxTokens > 0) {
    return model.autoContextMaxTokens
  }
  return DEFAULT_CONTEXT_WINDOW
}

/** Capabilities for the `cursor-agent-run` surface. MA owns tools; Cursor supplies text/thinking. */
export function cursorCaps(options: CursorCapsOptions = {}): Capabilities {
  const thinking = options.thinking ?? false
  const effortLevels = options.effortLevels ?? (thinking ? DEFAULT_EFFORT_LEVELS : [])
  const base = defaultCapabilities()
  return {
    ...base,
    contextWindow: options.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens: options.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS,
    outputTokensShareContextWindow: true,
    thinking: {
      adaptive: thinking,
      extended: false,
      visible: thinking,
      interleaved: false,
    },
    effort: {
      levels: [...effortLevels],
      default: effortLevels.includes("medium")
        ? "medium"
        : effortLevels.includes("standard")
          ? "standard"
          : (effortLevels[0] ?? "medium"),
    },
    acceptsTemperature: false,
    acceptsTopP: false,
    acceptsTopK: false,
    acceptsSeed: false,
    acceptsStopSequences: false,
    speedFast: false,
    tools: {
      userDefined: true,
      parallel: true,
      fineGrainedStreaming: false,
      toolChoice: false,
      strictSchema: false,
    },
    midConversationSystem: true,
    structuredOutputs: false,
    assistantPrefill: false,
    modalities: {
      image: options.vision ?? false,
      audio: false,
      pdf: false,
      video: false,
    },
    serverSideHistory: false,
    serverTools: [],
  }
}

/** Map AvailableModels capability flags into minimal-agent's provider-neutral table. */
export function deriveCursorCapabilities(model: DecodedCursorModel): Capabilities {
  const fromCatalog = extractCursorEffortLevels(model)
  const thinking = Boolean(model.supportsThinking) || fromCatalog.length > 0
  const effortLevels =
    fromCatalog.length > 0 ? fromCatalog : thinking ? [...DEFAULT_EFFORT_LEVELS] : []

  return cursorCaps({
    contextWindow: resolveCursorContextWindow(model),
    thinking,
    vision: Boolean(model.supportsImages),
    effortLevels,
    maxMode: Boolean(model.supportsMaxMode),
  })
}

/**
 * Capabilities for an exploded variant row. Starts from parent model caps,
 * then narrows effort to the variant's own parameterValues when present, and
 * can flip context to max-mode limit when the variant is max-mode.
 */
export function deriveCursorVariantCapabilities(
  model: DecodedCursorModel,
  variant: CursorModelVariant,
): Capabilities {
  const parent = deriveCursorCapabilities(model)
  const variantEffort = new Set<string>()
  for (const pv of variant.parameterValues ?? []) {
    const pid = (pv.id ?? "").toLowerCase()
    if (!EFFORT_PARAM_IDS.has(pid) && !pid.includes("effort")) continue
    const label = normalizeEffortLabel(pv.value ?? "")
    if (label) variantEffort.add(label)
  }

  let contextWindow = parent.contextWindow
  if (variant.isMaxMode) {
    if (
      typeof model.contextTokenLimitForMaxMode === "number" &&
      model.contextTokenLimitForMaxMode > 0
    ) {
      contextWindow = model.contextTokenLimitForMaxMode
    }
  } else if (typeof model.contextTokenLimit === "number" && model.contextTokenLimit > 0) {
    contextWindow = model.contextTokenLimit
  }

  const effortLevels =
    variantEffort.size > 0 ? sortEffortLevels(variantEffort) : parent.effort.levels

  return cursorCaps({
    contextWindow,
    thinking: parent.thinking.visible || effortLevels.length > 0,
    vision: parent.modalities.image,
    effortLevels,
    maxMode: Boolean(variant.isMaxMode ?? model.supportsMaxMode),
  })
}

/** Alias used by adapter/model code that wants the provider's generic baseline. */
export const cursorCapabilities = cursorCaps
