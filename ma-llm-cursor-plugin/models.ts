/**
 * Cursor static model seed + ad-hoc registration.
 *
 * Offline fallback so `--list-models` / picker work before live catalog.
 *
 * **Ids must be provider-namespaced.** Grok registers
 * `grok-composer-2.5-fast` with **alias** `composer-2.5-fast`. Registering bare
 * `composer-2.5-fast` as a Cursor model id crashes host boot:
 * `alias "composer-2.5-fast" collides with an existing model id`.
 *
 * Parents also dual-register the API name (`grok-4.6`) as a Cursor-scoped id
 * so `--provider cursor --model grok-4.6` resolves. That is a second model id,
 * not a global alias (aliases still collide with Grok).
 *
 * `vendorIds.cursor` is the AgentService/Run model_id: exploded SKU for
 * variants (`cursor-grok-4.6-high`), parent API name for parents (`grok-4.6`).
 * Run encode and CLI header mismatch: see
 * `docs/agent-run-too-many-computers-postmortem.md`.
 *
 * Static seed = the authenticated parameterized AvailableModels catalog
 * (`use_model_parameters=true`). Regenerated via
 * `scripts/generate-static-catalog.ts`.
 *
 * @module llm/providers/cursor/models
 */

import { cursorCaps, isCursorEffortParamId, isCursorFastParamId } from "./capabilities.ts"
import { makeCursorEncodeSpec, registerCursorRunSku, setCursorEncodeSpec } from "./encode-spec.ts"
import type { Capabilities } from "./lib/capabilities.ts"
import type { ModelRegistrar, ProviderModelSpec } from "./lib/provider-plugin.ts"
import { makeCharRatioEstimator } from "./lib/token-estimate.ts"
import { PRICING_CURSOR_GENERIC } from "./pricing.ts"
import { CURSOR_STATIC_CATALOG } from "./static-catalog.ts"
import { CURSOR_SURFACE_AGENT_RUN } from "./wire-constants.ts"

const K = 1_000

const estimateCursorTokens = makeCharRatioEstimator(3.8)

export interface CursorCatalogEntry {
  /** Host registry id — must not collide with other providers' ids/aliases. */
  id: string
  displayName: string
  /** Bare Cursor API model slug for AgentService/Run (parent id when parameterized). */
  wireId: string
  capabilities: Capabilities
  tags: string[]
  /** Parent API name for exploded variants (`grok-4.6`). */
  parentWireId?: string
  /** Exact AgentService/Run model_id for this row when it is a variant SKU. */
  runModelId?: string
  /** Default-non-max variant SKU for parent rows. */
  defaultRunModelId?: string
  /** Baked RequestedModel.parameters for variant rows. */
  parameterValues?: ReadonlyArray<{ id: string; value: string }>
  /** Parent extras from the catalog default-non-max variant (thinking/context). */
  defaultParameterValues?: ReadonlyArray<{ id: string; value: string }>
  /** Send variant-string f8 when the row has no parameter values. */
  useVariantString?: boolean
}

/**
 * Known display-slug → AgentService/Run wire id.
 * Cursor's Auto picker id is `auto`, but Run rejects it with connect
 * `not_found`; the API model_id is `default` (AvailableModels / GetUsableModels).
 * Ad-hoc registration and offline seed must use these, not the bare slug.
 */
export const CURSOR_WIRE_ID_ALIASES: Readonly<Record<string, string>> = {
  auto: "default",
}

/**
 * Map a user/host slug to the Cursor wire model id for Run.
 *
 * Auto still maps to `default`. Grok exploded SKUs keep the `cursor-grok-…`
 * legacy slug (AgentService/Run rejects the parent `grok-4.6`). Other
 * variants strip one host `cursor-` namespace.
 */
export function resolveCursorWireId(slug: string): string {
  if (CURSOR_WIRE_ID_ALIASES[slug]) return CURSOR_WIRE_ID_ALIASES[slug]!
  const host = slug.startsWith("cursor-") ? slug : `cursor-${slug}`
  const bare = host.slice("cursor-".length)
  if (CURSOR_WIRE_ID_ALIASES[bare]) return CURSOR_WIRE_ID_ALIASES[bare]!
  const grok = inferCursorGrokPreset(host)
  if (grok?.effort) return host
  if (grok) return grok.parent
  return bare
}

/** Parse `cursor-grok-4.6-high-fast` into parent + effort + fast. */
export function inferCursorGrokPreset(hostOrWire: string):
  | {
      parent: string
      effort?: string
      fast: boolean
    }
  | undefined {
  const bare = hostOrWire.replace(/^cursor-/, "")
  const match = /^(grok-\d+\.\d+)(?:-(low|medium|high|xhigh))?(?:-(fast))?$/.exec(bare)
  if (!match) return undefined
  if (!match[1]) return undefined
  // Reject `grok-4.5-fast-medium` (legacy alias order) — catalog maps those.
  if (match[2] === undefined && match[3] === "fast") return undefined
  return {
    parent: match[1],
    effort: match[2],
    fast: match[3] === "fast",
  }
}

function tagsForStaticRow(row: (typeof CURSOR_STATIC_CATALOG)[number]): string[] {
  const tags = new Set<string>(["cursor", "live", "parameterized"])
  if (row.defaultOn) tags.add("default-on")
  if (row.supportsThinking) tags.add("thinking")
  if (row.supportsImages) tags.add("vision")
  tags.add("agent")
  tags.add("supports-max-mode")
  if (row.maxMode) tags.add("max-mode")
  if (row.parentWireId) {
    tags.add("variant")
    tags.add(`parent:${row.parentWireId}`)
  }
  if (row.useVariantString) tags.add("variant-string")
  if (row.effortParamId) tags.add(`effort-param:${row.effortParamId}`)
  if (row.fastParamId) tags.add(`fast-param:${row.fastParamId}`)
  for (const pv of row.parameterValues ?? []) {
    tags.add(`param:${pv.id}=${pv.value}`)
  }
  for (const pv of row.defaultParameterValues ?? []) {
    tags.add(`default-param:${pv.id}=${pv.value}`)
  }
  return [...tags]
}

/**
 * Static offline catalog. Generated rows carry canonical parents and exploded
 * variant host ids; `cursor-auto`/`cursor-default` are the user-facing Auto rows.
 */
const CATALOG: CursorCatalogEntry[] = CURSOR_STATIC_CATALOG.map((row) => ({
  id: row.id,
  displayName: row.displayName,
  wireId: row.wireId,
  capabilities: cursorCaps({
    contextWindow: row.contextWindow,
    maxOutputTokens: row.maxOutputTokens,
    thinking: row.supportsThinking,
    vision: row.supportsImages,
    effortLevels: row.effortLevels,
    speedFast: row.speedFast ?? false,
  }),
  tags: tagsForStaticRow(row),
  parentWireId: row.parentWireId,
  parameterValues: row.parameterValues,
  defaultParameterValues: row.defaultParameterValues,
  useVariantString: row.useVariantString,
  runModelId: row.runModelId,
  defaultRunModelId: row.defaultRunModelId,
}))

// Auto is a display alias for Cursor's canonical `default` model. Keep both
// host ids offline without adding a bare `auto` alias that can collide globally.
CATALOG.unshift({
  id: "cursor-auto",
  displayName: "Auto (Cursor)",
  wireId: "default",
  capabilities: cursorCaps({ contextWindow: 128 * K, vision: true, effortLevels: [] }),
  tags: ["cursor", "auto", "default", "agent", "supports-max-mode"],
})

/** AgentService/Run model_id for a catalog row. Variants send the exploded SKU. */
export function catalogRunModelId(
  entry: Pick<
    CursorCatalogEntry,
    "id" | "wireId" | "parentWireId" | "runModelId" | "useVariantString"
  >,
): string | undefined {
  if (entry.runModelId) return entry.runModelId
  if (entry.useVariantString) return entry.wireId
  if (!entry.parentWireId) return undefined
  const grok = inferCursorGrokPreset(entry.id)
  if (grok?.effort) return entry.id
  return entry.id.startsWith("cursor-") ? entry.id.slice("cursor-".length) : entry.id
}

function shouldDualRegisterApiId(entry: CursorCatalogEntry): boolean {
  if (entry.parentWireId) return false
  if (entry.tags.includes("alias") || entry.tags.includes("api-id")) return false
  const api = entry.wireId
  if (!api || api === entry.id) return false
  if (api === "default" || api === "auto") return false
  if (api.startsWith("cursor-")) return false
  return true
}

function indexVariantSku(entry: CursorCatalogEntry, runModelId: string): void {
  const parent = entry.parentWireId
  if (!parent || !runModelId) return
  const params = entry.parameterValues ?? []
  const effort = params.find((p) => isCursorEffortParamId(p.id))?.value
  const fastRaw = params.find((p) => isCursorFastParamId(p.id))?.value
  const fast = fastRaw === "true" ? true : fastRaw === "false" ? false : undefined
  registerCursorRunSku(parent, { effort, fast }, runModelId)
  if (entry.tags.includes("default-non-max")) {
    registerCursorRunSku(parent, {}, runModelId)
  }
}

/** Register one Cursor model into the host registry. */
export function registerCursorModelInto(models: ModelRegistrar, entry: CursorCatalogEntry): string {
  const runModelId = catalogRunModelId(entry)
  const vendorWireId = runModelId ?? entry.wireId
  const spec: ProviderModelSpec = {
    id: entry.id,
    providerId: "cursor",
    surfaceId: CURSOR_SURFACE_AGENT_RUN,
    displayName: entry.displayName,
    tags: entry.tags,
    capabilities: entry.capabilities,
    // Pricing opaque on AvailableModels — zero rates (see pricing.ts).
    pricing: PRICING_CURSOR_GENERIC,
    estimateTokens: estimateCursorTokens,
    // Never put bare wire ids in `aliases` — they collide with Grok et al.
    vendorIds: { cursor: vendorWireId, firstParty: vendorWireId },
  }
  models.register(spec)
  const effortParamId = entry.tags
    .find((t) => t.startsWith("effort-param:"))
    ?.slice("effort-param:".length)
  const fastParamId = entry.tags
    .find((t) => t.startsWith("fast-param:"))
    ?.slice("fast-param:".length)
  const encodeSpec = makeCursorEncodeSpec({
    wireId: entry.wireId,
    runModelId,
    parentApiId: entry.parentWireId,
    defaultRunModelId: entry.defaultRunModelId,
    parameterValues: entry.parameterValues,
    defaultParameterValues: entry.defaultParameterValues,
    maxMode: entry.tags.includes("max-mode"),
    useVariantString: entry.useVariantString,
    effortParamId,
    fastParamId,
    effortLevels: entry.capabilities.effort.levels,
    speedFast: entry.capabilities.speedFast,
  })
  setCursorEncodeSpec(entry.id, encodeSpec)
  if (runModelId) indexVariantSku(entry, runModelId)
  if (shouldDualRegisterApiId(entry)) {
    try {
      models.register({
        ...spec,
        id: entry.wireId,
        tags: [...entry.tags, "api-id"],
      })
      setCursorEncodeSpec(entry.wireId, encodeSpec)
    } catch {
      // Another provider already owns this string as an alias.
    }
  }
  return entry.id
}

/** Populate the host registry with the static Cursor seed. Default = Auto. */
export function registerCursorModels(models: ModelRegistrar): string[] {
  const ids = CATALOG.map((entry) => registerCursorModelInto(models, entry))
  // Prefer Auto (`cursor-auto`) when present; else first seed entry.
  const defaultId = ids.find((id) => id === "cursor-auto") ?? ids[0]
  if (defaultId) models.setDefault(defaultId)
  return ids
}

/**
 * Register a one-off Cursor slug.
 * Namespaces host id as `cursor-<slug>` when the caller passes a bare API id.
 * Wire id resolves known display aliases (e.g. `auto` → `default`).
 */
export function registerCursorAdHocModelInto(models: ModelRegistrar, modelId: string): string {
  const hostId = modelId.startsWith("cursor-") ? modelId : `cursor-${modelId}`
  const grok = inferCursorGrokPreset(hostId)
  const wireId = resolveCursorWireId(hostId)
  const hostBare = hostId.slice("cursor-".length)
  const tags = ["cursor", "ad-hoc"]
  const parameterValues: Array<{ id: string; value: string }> = []
  if (CURSOR_WIRE_ID_ALIASES[hostBare]) {
    tags.push("alias", `canonical:${wireId}`)
  }
  if (grok) {
    tags.push(`parent:${grok.parent}`, "effort-param:effort", "fast-param:fast")
    if (grok.effort) {
      tags.push("variant", `param:effort=${grok.effort}`, `param:fast=${grok.fast}`)
      parameterValues.push(
        { id: "effort", value: grok.effort },
        { id: "fast", value: String(grok.fast) },
      )
    }
  }
  return registerCursorModelInto(models, {
    id: hostId,
    wireId: grok && !grok.effort ? grok.parent : wireId,
    displayName:
      hostId === "cursor-auto" || hostId === "cursor-default"
        ? "Auto (Cursor)"
        : `${hostBare} (Cursor)`,
    capabilities: cursorCaps({
      contextWindow: 128 * K,
      thinking: hostId !== "cursor-auto" && hostId !== "cursor-default",
      effortLevels: grok?.effort ? [grok.effort] : grok ? ["low", "medium", "high", "xhigh"] : [],
      speedFast: Boolean(grok),
    }),
    tags,
    parentWireId: grok && grok.effort ? grok.parent : undefined,
    parameterValues: parameterValues.length > 0 ? parameterValues : undefined,
    runModelId: grok?.effort ? hostId : undefined,
  })
}

/** Resolve wire model id for Run requests from a host ModelEntry-like object. */
export function cursorWireModelId(model: {
  id: string
  vendorIds?: Record<string, string>
}): string {
  const fromVendor = model.vendorIds?.cursor ?? model.vendorIds?.firstParty
  if (fromVendor) {
    // vendorIds.cursor is the Run model_id (exact), except Auto display aliases.
    return CURSOR_WIRE_ID_ALIASES[fromVendor] ?? fromVendor
  }
  return resolveCursorWireId(model.id)
}
