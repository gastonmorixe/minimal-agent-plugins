/**
 * Expand parameterized AvailableModels into host catalog rows.
 *
 * Parents keep the API name as catalog identity (`grok-4.6`). Variants become
 * extra host ids from `legacy_slug` (`cursor-grok-4.6-high`). AgentService/Run
 * encode currently sends that exploded SKU as `RequestedModel.model_id`.
 * Header vs encode history:
 * `docs/agent-run-too-many-computers-postmortem.md`.
 *
 * @module llm/providers/cursor/catalog-expand
 */

import {
  deriveCursorCapabilities,
  deriveCursorVariantCapabilities,
  isCursorEffortParamId,
  isCursorFastParamId,
  resolveCursorEffortParamId,
  resolveCursorFastParamId,
} from "./capabilities.ts"
import type { CursorCatalogEntry } from "./models.ts"
import { resolveCursorWireId } from "./models.ts"
import type {
  CursorModelVariant,
  DecodedAvailableModelsResponse,
  DecodedCursorModel,
} from "./proto/models-decode.ts"

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

/** Host registry id for a bare Cursor API slug. Always `cursor-…`. */
export function cursorHostModelId(wireId: string): string {
  const bare = wireId.replace(/^cursor-/, "")
  return bare.startsWith("cursor-") ? bare : `cursor-${bare}`
}

/** Prefer client display name, then short name, then wire id. */
export function cursorModelDisplayName(model: DecodedCursorModel): string {
  return model.clientDisplayName ?? model.inputboxShortModelName ?? model.name
}

function prettyToken(raw: string): string {
  return raw
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

/** Human label for an exploded variant: parent + effort + Fast + other knobs. */
export function formatCursorVariantDisplayName(
  parentDisplay: string,
  variant: CursorModelVariant,
): string {
  const params = variant.parameterValues ?? []
  if (params.length === 0) {
    return variant.displayNameOutsidePicker ?? variant.displayName ?? parentDisplay
  }
  const bits = [parentDisplay]
  for (const pv of params) {
    if (!pv.id || pv.value == null || pv.value === "") continue
    const id = pv.id.toLowerCase()
    const value = pv.value
    if (isCursorFastParamId(pv.id)) {
      if (value === "true") bits.push("Fast")
      continue
    }
    if (value === "false" || value === "none") continue
    if (isCursorEffortParamId(pv.id)) {
      bits.push(prettyToken(value))
      continue
    }
    bits.push(value === "true" ? prettyToken(pv.id) : `${prettyToken(id)} ${prettyToken(value)}`)
  }
  return bits.join(" ")
}

function paramTags(values: ReadonlyArray<{ id?: string; value?: string }> | undefined): string[] {
  const tags: string[] = []
  for (const pv of values ?? []) {
    if (!pv.id || pv.value == null || pv.value === "") continue
    tags.push(`param:${pv.id}=${pv.value}`)
  }
  return tags
}

function defaultNonMaxVariant(model: DecodedCursorModel): CursorModelVariant | undefined {
  const variants = model.variants ?? []
  return (
    variants.find((v) => v.isDefaultNonMaxConfig) ??
    variants.find((v) => !v.isMaxMode) ??
    variants.find((v) => v.isDefaultMaxConfig) ??
    variants[0]
  )
}

function extraDefaultParams(model: DecodedCursorModel): Array<{ id: string; value: string }> {
  const variant = defaultNonMaxVariant(model)
  const out: Array<{ id: string; value: string }> = []
  for (const pv of variant?.parameterValues ?? []) {
    if (!pv.id || pv.value == null || pv.value === "") continue
    if (isCursorEffortParamId(pv.id) || isCursorFastParamId(pv.id)) continue
    out.push({ id: pv.id, value: pv.value })
  }
  return out
}

function tagsForParent(model: DecodedCursorModel): string[] {
  const tags = new Set<string>(["cursor", "live", "parameterized"])
  if (model.supportsThinking) tags.add("thinking")
  if (model.supportsImages) tags.add("vision")
  if (model.supportsMaxMode) tags.add("supports-max-mode")
  if (model.supportsAgent) tags.add("agent")
  if (model.isLongContextOnly) tags.add("long-context")
  if (model.defaultOn) tags.add("default-on")
  const effortParamId = resolveCursorEffortParamId(model)
  if (effortParamId) tags.add(`effort-param:${effortParamId}`)
  const fastParamId = resolveCursorFastParamId(model)
  if (fastParamId) tags.add(`fast-param:${fastParamId}`)
  for (const pv of extraDefaultParams(model)) {
    tags.add(`default-param:${pv.id}=${pv.value}`)
  }
  return [...tags]
}

function tagsForVariant(
  model: DecodedCursorModel,
  variant: CursorModelVariant,
  hasParams: boolean,
  hasVariantString: boolean,
): string[] {
  const effortParamId = resolveCursorEffortParamId(model, variant)
  const fastParamId = resolveCursorFastParamId(model, variant)
  const tags = new Set<string>()
  for (const t of tagsForParent(model)) {
    if (t === "default-on" || t.startsWith("default-param:")) continue
    tags.add(t)
  }
  tags.add("variant")
  tags.add(`parent:${model.name}`)
  if (hasParams) {
    for (const t of paramTags(variant.parameterValues)) tags.add(t)
  } else if (hasVariantString) {
    tags.add("variant-string")
  } else {
    tags.add("variant-legacy-slug")
  }
  if (variant.isMaxMode) tags.add("max-mode")
  if (variant.isDefaultMaxConfig) tags.add("default-max")
  if (variant.isDefaultNonMaxConfig) tags.add("default-non-max")
  if (effortParamId) tags.add(`effort-param:${effortParamId}`)
  if (fastParamId) tags.add(`fast-param:${fastParamId}`)
  return [...tags]
}

function parameterValuesOf(variant: CursorModelVariant): Array<{ id: string; value: string }> {
  const out: Array<{ id: string; value: string }> = []
  for (const pv of variant.parameterValues ?? []) {
    if (!pv.id || pv.value == null || pv.value === "") continue
    out.push({ id: pv.id, value: pv.value })
  }
  return out
}

/** AgentService/Run model_id: legacy slug, else a non-bracketed variant string. */
function variantRunSlug(variant: CursorModelVariant | undefined): string | undefined {
  if (!variant) return undefined
  if (variant.legacySlug) return variant.legacySlug
  const variantString = variant.variantStringRepresentation
  if (variantString && !variantString.includes("[")) return variantString
  return undefined
}

/**
 * Expand rich AvailableModels into host catalog entries (parents, variants,
 * leftover aliases). Hidden models are omitted. Variant host ids prefer
 * `legacy_slug` over the bracketed variant-string representation.
 */
export function expandCursorCatalog(decoded: DecodedAvailableModelsResponse): CursorCatalogEntry[] {
  const rows: CursorCatalogEntry[] = []
  const seen = new Set<string>()

  const add = (entry: CursorCatalogEntry) => {
    if (seen.has(entry.id)) return
    seen.add(entry.id)
    rows.push(entry)
  }

  for (const model of decoded.models) {
    if (model.isHidden) continue
    if (!model.name) continue

    const parentCaps = deriveCursorCapabilities(model)
    const parentDisplay = cursorModelDisplayName(model)
    const defaultVariant = defaultNonMaxVariant(model)
    const defaultRunModelId = variantRunSlug(defaultVariant)
    add({
      id: cursorHostModelId(model.name),
      wireId: model.name,
      displayName: parentDisplay,
      capabilities: parentCaps,
      tags: tagsForParent(model),
      defaultParameterValues: extraDefaultParams(model),
      defaultRunModelId,
    })

    for (const variant of model.variants ?? []) {
      const params = parameterValuesOf(variant)
      const hasParams = params.length > 0
      const hasVariantString = Boolean(variant.variantStringRepresentation)
      const hostSlug = variantRunSlug(variant)
      if (!hostSlug) continue
      const useVariantString = !hasParams && hasVariantString
      add({
        id: cursorHostModelId(hostSlug),
        wireId: useVariantString ? variant.variantStringRepresentation! : hostSlug,
        displayName: formatCursorVariantDisplayName(parentDisplay, variant),
        capabilities: deriveCursorVariantCapabilities(model, variant),
        tags: tagsForVariant(model, variant, hasParams, hasVariantString),
        parentWireId: model.name,
        parameterValues: hasParams ? params : undefined,
        useVariantString,
        runModelId: useVariantString ? variant.variantStringRepresentation! : hostSlug,
      })
    }

    for (const alias of unique([...(model.idAliases ?? []), ...(model.legacySlugs ?? [])])) {
      if (!alias || alias === model.name) continue
      const aliasHostId = cursorHostModelId(alias)
      if (aliasHostId === cursorHostModelId(model.name)) continue
      add({
        id: aliasHostId,
        wireId: model.name,
        displayName: parentDisplay,
        capabilities: parentCaps,
        tags: [
          ...tagsForParent(model).filter((t) => t !== "default-on"),
          "alias",
          `canonical:${model.name}`,
        ],
        defaultParameterValues: extraDefaultParams(model),
      })
    }
  }

  for (const modelName of decoded.modelNames) {
    if (!modelName) continue
    const id = cursorHostModelId(modelName)
    if (seen.has(id)) continue
    add({
      id,
      wireId: resolveCursorWireId(
        modelName.startsWith("cursor-") ? modelName : `cursor-${modelName}`,
      ),
      displayName: modelName,
      capabilities: deriveCursorCapabilities({ name: modelName }),
      tags: ["cursor", "live", "legacy-name"],
    })
  }

  return rows
}
