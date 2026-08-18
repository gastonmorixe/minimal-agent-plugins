import { type Capabilities, defaultCapabilities } from "./lib/capabilities.ts"
import type { CursorModelVariant, DecodedCursorModel } from "./proto/models-decode.ts"

export interface CursorCapsOptions {
  contextWindow?: number
  maxOutputTokens?: number
  thinking?: boolean
  vision?: boolean
  effortLevels?: ReadonlyArray<string>
  maxMode?: boolean
  speedFast?: boolean
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

/**
 * Parameter definition / parameterValue ids that carry the product effort ladder.
 * Christina review: do **not** treat arbitrary field-29 enums as effort
 * (false levels). Only effort/reasoning families.
 */
const EFFORT_PARAM_IDS = new Set(["effort", "reasoning", "reasoning_effort", "reasoningeffort"])

/** True when a parameter id is Cursor's fast/speed boolean. */
export function isCursorFastParamId(id: string | undefined): boolean {
  if (!id) return false
  const n = id.trim().toLowerCase()
  return n === "fast" || n === "fast_mode" || n === "fastmode"
}

/** True when a parameter id is an effort/reasoning knob (exact or known alias). */
export function isCursorEffortParamId(id: string | undefined): boolean {
  if (!id) return false
  const n = id.trim().toLowerCase()
  if (!n) return false
  if (EFFORT_PARAM_IDS.has(n)) return true
  // Allow `foo_effort` / `effort_bar` but not bare `thinking` (thinking is a
  // separate capability flag; its enum values are not always effort levels).
  if (n === "thinking" || n === "think") return false
  return n.endsWith("_effort") || n.startsWith("effort_") || n.includes("reasoning_effort")
}

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
  // Only keep known ladder labels + a few Cursor cloud labels — reject
  // random enum strings from non-effort parameters that slipped through.
  const known = new Set<string>(KNOWN_EFFORT_ORDER)
  if (known.has(stripped)) return stripped
  // Allow simple effort-like tokens (e.g. "extra_high") without open-ended junk.
  if (
    /^[a-z][a-z0-9_]{0,31}$/.test(stripped) &&
    (stripped.includes("high") ||
      stripped.includes("low") ||
      stripped.includes("med") ||
      stripped.includes("max") ||
      stripped.includes("grind") ||
      stripped.includes("standard"))
  ) {
    return stripped
  }
  return undefined
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
    // Strict: only effort/reasoning parameter ids — not arbitrary field-29 enums.
    if (!isCursorEffortParamId(def.id) && !isCursorEffortParamId(def.name)) continue
    for (const entry of def.enumValues ?? []) {
      const label = normalizeEffortLabel(entry.value ?? entry.displayName ?? "")
      if (label) found.add(label)
    }
  }

  for (const variant of model.variants ?? []) {
    for (const pv of variant.parameterValues ?? []) {
      if (!isCursorEffortParamId(pv.id)) continue
      const label = normalizeEffortLabel(pv.value ?? "")
      if (label) found.add(label)
    }
  }

  return sortEffortLevels(found)
}

/**
 * Preferential order when multiple effort-like parameter ids appear.
 * Lower index = preferred for RequestedModel.parameters wire id.
 */
const EFFORT_PARAM_ID_PREFERENCE = [
  "effort",
  "reasoning_effort",
  "reasoningeffort",
  "reasoning",
] as const

/**
 * Resolve the wire parameter **id** to send in RequestedModel.parameters
 * (do not hardcode `"effort"` — catalog may use reasoning_effort etc.).
 *
 * Preference: field 29 definition id/name → first matching variant
 * parameterValue id → undefined (caller falls back to host effort only).
 *
 * Exported so registration can tag `effort-param:<id>` for Jack's encode.
 */
export function resolveCursorEffortParamId(
  model: DecodedCursorModel,
  variant?: CursorModelVariant,
): string | undefined {
  const candidates: string[] = []

  for (const def of model.parameterDefinitions ?? []) {
    for (const raw of [def.id, def.name]) {
      if (!raw || !isCursorEffortParamId(raw)) continue
      candidates.push(raw.trim())
    }
  }

  if (variant) {
    for (const pv of variant.parameterValues ?? []) {
      if (!pv.id || !isCursorEffortParamId(pv.id)) continue
      candidates.push(pv.id.trim())
    }
  } else {
    for (const v of model.variants ?? []) {
      for (const pv of v.parameterValues ?? []) {
        if (!pv.id || !isCursorEffortParamId(pv.id)) continue
        candidates.push(pv.id.trim())
      }
    }
  }

  if (candidates.length === 0) return undefined

  const rank = (id: string): number => {
    const n = id.toLowerCase()
    const i = EFFORT_PARAM_ID_PREFERENCE.indexOf(n as (typeof EFFORT_PARAM_ID_PREFERENCE)[number])
    return i === -1 ? 100 : i
  }

  return [...candidates].sort((a, b) => {
    const d = rank(a) - rank(b)
    if (d !== 0) return d
    return a.localeCompare(b)
  })[0]
}

/**
 * Read `effort-param:<id>` from registered model tags (Jack encode path).
 * Returns undefined when the catalog never advertised an effort parameter id.
 */
export function effortParamIdFromTags(tags: ReadonlyArray<string> | undefined): string | undefined {
  return taggedId(tags, "effort-param:")
}

/** Read `fast-param:<id>` from registered model tags. */
export function fastParamIdFromTags(tags: ReadonlyArray<string> | undefined): string | undefined {
  return taggedId(tags, "fast-param:")
}

function taggedId(tags: ReadonlyArray<string> | undefined, prefix: string): string | undefined {
  if (!tags) return undefined
  for (const tag of tags) {
    if (tag.startsWith(prefix) && tag.length > prefix.length) {
      return tag.slice(prefix.length)
    }
  }
  return undefined
}

/** True when the catalog advertises a fast/speed boolean parameter. */
export function resolveCursorFastParamId(
  model: DecodedCursorModel,
  variant?: CursorModelVariant,
): string | undefined {
  for (const def of model.parameterDefinitions ?? []) {
    if (isCursorFastParamId(def.id) || isCursorFastParamId(def.name)) {
      return (def.id ?? def.name)?.trim()
    }
  }
  const values = variant
    ? (variant.parameterValues ?? [])
    : (model.variants ?? []).flatMap((v) => v.parameterValues ?? [])
  for (const pv of values) {
    if (isCursorFastParamId(pv.id)) return pv.id?.trim()
  }
  return undefined
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

/** Capabilities for the `cursor-agent-run` surface. MA tools via MCP (`mcp_tools`). */
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
    speedFast: options.speedFast ?? false,
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

/**
 * Map AvailableModels capability flags into minimal-agent's provider-neutral table.
 *
 * **Closed effort semantics (Christina):** only advertise effort.levels when the
 * catalog resolves an effort/reasoning parameter id (`resolveCursorEffortParamId`).
 * A bare `supportsThinking` without field-29/variant param ids still sets
 * thinking=true but **levels=[]** so the host cannot select a knob Jack cannot
 * encode (no inventing `effort` wire id). Live probe 2026-07-30: most agent
 * models advertise thinking with no field-29 effort param — levels stay [].
 * Static seed via {@link cursorCaps} matches (effortLevels: []).
 */
export function deriveCursorCapabilities(model: DecodedCursorModel): Capabilities {
  const fromCatalog = extractCursorEffortLevels(model)
  const effortParamId = resolveCursorEffortParamId(model)
  const thinking = Boolean(model.supportsThinking) || fromCatalog.length > 0
  // No fallback ladder without a resolved param id — selectable but unsendable is worse.
  const effortLevels = effortParamId && fromCatalog.length > 0 ? fromCatalog : []

  return cursorCaps({
    contextWindow: resolveCursorContextWindow(model),
    thinking,
    vision: Boolean(model.supportsImages),
    effortLevels,
    maxMode: Boolean(model.supportsMaxMode),
    speedFast: Boolean(resolveCursorFastParamId(model)),
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
    if (!isCursorEffortParamId(pv.id)) continue
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

  const effortParamId = resolveCursorEffortParamId(model, variant)
  // Same closed rule as parent: levels only when we can name the wire param id.
  const effortLevels =
    effortParamId && variantEffort.size > 0
      ? sortEffortLevels(variantEffort)
      : effortParamId
        ? parent.effort.levels
        : []

  return cursorCaps({
    contextWindow,
    thinking: parent.thinking.visible || effortLevels.length > 0 || Boolean(model.supportsThinking),
    vision: parent.modalities.image,
    effortLevels,
    maxMode: Boolean(variant.isMaxMode ?? model.supportsMaxMode),
    speedFast: Boolean(resolveCursorFastParamId(model, variant) ?? parent.speedFast),
  })
}

/** Alias used by adapter/model code that wants the provider's generic baseline. */
export const cursorCapabilities = cursorCaps
