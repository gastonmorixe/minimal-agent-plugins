/**
 * Model catalog of the Antigravity provider.
 *
 * The backend lists one id per thinking level (`gemini-4-neon-low` ..
 * `gemini-4-neon-xhigh`), and `groupedModels` joins them into one family with
 * its `supportedThinkingLevels`. agy shows one row per family and sends the
 * pair (`model: "<base>-<level>"`, `thinkingLevel: "<LEVEL>"`)
 * (`research/2026-11-25-antigravity-plugin/notes/effort-model-map.md` A.4).
 *
 * This catalog does the same:
 *
 * 1. A family is ONE row with the base id (`gemini-4-neon`). Its effort levels
 *    are the family levels, and its default effort is the suffix of
 *    `defaultAgentModelId` when that id is in the family, else `medium`.
 * 2. The old suffixed ids are aliases of the family row, so a saved session
 *    that names `gemini-4-neon-high` still resolves.
 * 3. An id with no family is a single row: a fixed effort when the id has a
 *    level suffix (`gpt-oss-120b-medium`), else no effort picker.
 *
 * Two sources, one builder: `ANTIGRAVITY_MODELS` comes from the static
 * snapshot of 2026-11-25, and `antigravitySpecsFromCatalog` builds the same
 * rows from a live `fetchAvailableModels` response, so a family that appears
 * after this release still works.
 *
 * @module llm/providers/antigravity/models
 */

import type { Capabilities } from "@minimal-agent/core/plugin-api/llm/capabilities"

import { estimatorForModelId } from "../ma-token-estimate-kit/src/index.ts"

import {
  CAPS_CLAUDE_VERTEX,
  CAPS_GEMINI_3_FLASH,
  CAPS_GEMINI_4,
  CAPS_GEMINI_4_SMALL_OUT,
  CAPS_GEMINI_FLASH_LITE,
  CAPS_GPT_OSS,
  CAPS_IMAGE_GEN,
  withEffort,
} from "./capabilities.ts"
import type { ModelRegistrar, ProviderModelSpec } from "./lib/provider-plugin.ts"
import { PRICING_ANTIGRAVITY_PLAN } from "./pricing.ts"

/** Provider id of every model in this plugin. */
export const ANTIGRAVITY_PROVIDER_ID = "antigravity"

/** Wire surface id: the Cloud Code Assist envelope, provider defined. */
export const ANTIGRAVITY_SURFACE_ID = "custom"

/** Backend default agent model of the snapshot (`defaultAgentModelId`). */
const SNAPSHOT_DEFAULT_AGENT_MODEL = "gemini-4-neon-high"

/** Model a no-model session boots with: the family of the account default. */
export const ANTIGRAVITY_DEFAULT_MODEL = "gemini-4-neon"

/**
 * `vendorIds` key that marks a family row. Its value is the base id, and the
 * request builder sends `<base>-<effort>` on the wire.
 */
export const EFFORT_BASE_VENDOR_KEY = "effortBase"

/** Effort used when the account default is not in a family. */
const FALLBACK_FAMILY_EFFORT = "medium"

/** One row of the static snapshot (one backend id). */
export interface CatalogSnapshotRow {
  id: string
  name: string
  max: number
  out: number
  prov: string
  img: boolean
}

/** One `models[id]` row of `fetchAvailableModels`. */
export interface CatalogModelRow {
  displayName?: string
  maxTokens?: number
  maxOutputTokens?: number
  modelProvider?: string
  supportsImages?: boolean
  supportsThinking?: boolean
  thinkingLevel?: number
  supportedMimeTypes?: Record<string, boolean>
  recommended?: boolean
  vertexModelId?: string
}

/** One `groupedModels[base]` entry of `fetchAvailableModels`. */
export interface CatalogGroupRow {
  displayName?: string
  supportedThinkingLevels?: Array<{ thinkingSuffix?: string; thinkingDisplayName?: string }>
}

/** The slice of a `fetchAvailableModels` response that the catalog reads. */
export interface CatalogResponse {
  models?: Record<string, CatalogModelRow>
  groupedModels?: Record<string, CatalogGroupRow>
  defaultAgentModelId?: string
}

/** One model family: a base id, its effort levels and its default effort. */
export interface AntigravityModelGroup {
  base: string
  name: string
  /** Lower-case thinking suffixes, in catalog order. */
  levels: string[]
  defaultEffort: string
}

// Snapshot of 2026-11-25 (evidence/fetchAvailableModels.json, flows[0]).
// tab_* rows are omitted: they speak an XML tool dialect that this adapter
// does not encode.
const SNAPSHOT: CatalogSnapshotRow[] = [
  row("claude-opus-5-5-high", "Claude Opus 5.5 (High)", 1000000, 128000, "ANTHROPIC"),
  row("claude-opus-5-5-low", "Claude Opus 5.5 (Low)", 1000000, 128000, "ANTHROPIC"),
  row("claude-opus-5-5-medium", "Claude Opus 5.5 (Medium)", 1000000, 128000, "ANTHROPIC"),
  row("claude-sonnet-5-5-high", "Claude Sonnet 5.5 (High)", 1000000, 128000, "ANTHROPIC"),
  row("claude-sonnet-5-5-low", "Claude Sonnet 5.5 (Low)", 1000000, 128000, "ANTHROPIC"),
  row("claude-sonnet-5-5-medium", "Claude Sonnet 5.5 (Medium)", 1000000, 128000, "ANTHROPIC"),
  row("gemini-2.5-flash", "Gemini 3.5 Flash Lite", 1048576, 65535),
  row("gemini-2.5-flash-lite", "Gemini 3.5 Flash Lite", 1048576, 65535),
  row("gemini-2.5-flash-thinking", "Gemini 3.5 Flash Lite", 1048576, 65535),
  row("gemini-3-flash", "Gemini 3 Flash", 1048576, 65536),
  row("gemini-3.1-flash-image", "Gemini 3.1 Flash Image", 65536, 65536),
  row("gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite", 1048576, 65535),
  row("gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite", 1048576, 65535),
  row("gemini-3.8-flash-high", "Gemini 3.8 Flash (High)", 1048576, 65536),
  row("gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)", 1048576, 65536),
  row("gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)", 1048576, 65536),
  row("gemini-3.8-flash-tiered", "Gemini 3.8 Flash (Tiered)", 1048576, 65536),
  row("gemini-4-argon-high", "Gemini 4 Argon (High)", 1048576, 65536),
  row("gemini-4-argon-low", "Gemini 4 Argon (Low)", 1048576, 65536),
  row("gemini-4-argon-medium", "Gemini 4 Argon (Medium)", 1048576, 65536),
  row("gemini-4-carbon-high", "Gemini 4 Carbon (High)", 1048576, 262144),
  row("gemini-4-carbon-low", "Gemini 4 Carbon (Low)", 1048576, 262144),
  row("gemini-4-carbon-medium", "Gemini 4 Carbon (Medium)", 1048576, 262144),
  row("gemini-4-hydrogen-high", "Gemini 4 Hydrogen (High)", 1048576, 262144),
  row("gemini-4-hydrogen-low", "Gemini 4 Hydrogen (Low)", 1048576, 262144),
  row("gemini-4-hydrogen-medium", "Gemini 4 Hydrogen (Medium)", 1048576, 262144),
  row("gemini-4-hydrogen-sonar", "Gemini 4 Hydrogen (Sonar)", 1048576, 65536),
  row("gemini-4-hydrogen-tiered-high", "Gemini 4 Hydrogen (High, Tiered)", 1048576, 262144),
  row("gemini-4-hydrogen-tiered-xhigh", "Gemini 4 Hydrogen (XHigh, Tiered)", 1048576, 262144),
  row("gemini-4-hydrogen-xhigh", "Gemini 4 Hydrogen (XHigh)", 1048576, 262144),
  row("gemini-4-neon-high", "Gemini 4 Neon (High)", 1048576, 262144),
  row("gemini-4-neon-low", "Gemini 4 Neon (Low)", 1048576, 262144),
  row("gemini-4-neon-medium", "Gemini 4 Neon (Medium)", 1048576, 262144),
  row("gemini-4-neon-xhigh", "Gemini 4 Neon (XHigh)", 1048576, 262144),
  row("gemini-flash-worker-agy", "Gemini 4 Hydrogen (Orchestrator)", 1048576, 262144),
  row("gemini-pro-orchestrator", "Orchestrator (Carbon)", 1048576, 262144),
  row("gemini-pro-orchestrator-argon", "Orchestrator (Argon)", 1048576, 65536),
  row("gemini-pro-orchestrator-neon", "Orchestrator (Neon)", 1048576, 262144),
  {
    id: "gpt-oss-120b-medium",
    name: "GPT-OSS 120B (Medium)",
    max: 131072,
    out: 32768,
    prov: "MODEL_PROVIDER_OPENAI",
    img: false,
  },
]

const LMH = ["low", "medium", "high"]
const LMHX = ["low", "medium", "high", "xhigh"]

// `groupedModels` of the same snapshot, in catalog order. Only neon and
// hydrogen list xhigh. `gemini-3.8-flash` is placed last: agy 1.5.18 marks it
// "Leaving Soon" (2026-11-30) in favor of Hydrogen.
const SNAPSHOT_GROUPS: ReadonlyArray<{ base: string; name: string; levels: string[] }> = [
  { base: "gemini-4-neon", name: "Gemini 4 Neon", levels: LMHX },
  { base: "claude-opus-5-5", name: "Claude Opus 5.5", levels: LMH },
  { base: "gemini-4-carbon", name: "Gemini 4 Carbon", levels: LMH },
  { base: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", levels: LMHX },
  { base: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", levels: LMH },
  { base: "gemini-4-argon", name: "Gemini 4 Argon", levels: LMH },
  { base: "gemini-3.8-flash", name: "Gemini 3.8 Flash", levels: LMH },
]

/** A vision row of the snapshot. `prov` is the suffix of `MODEL_PROVIDER_*`. */
function row(id: string, name: string, max: number, out: number, prov = "GOOGLE") {
  return { id, name, max, out, prov: `MODEL_PROVIDER_${prov}`, img: true }
}

/** Model family of an id. */
export type ModelFamily = "gemini" | "claude" | "gpt-oss" | "image" | "unknown"

/** Family of a model id, from its prefix. */
export function antigravityFamily(modelId: string): ModelFamily {
  if (modelId.includes("claude")) return "claude"
  if (modelId.includes("gpt-oss")) return "gpt-oss"
  if (modelId.includes("image")) return "image"
  if (modelId.startsWith("gemini")) return "gemini"
  return "unknown"
}

/** Thinking suffix of a model id (`gemini-4-neon-high` to `HIGH`), or undefined. */
export function thinkingSuffixOf(modelId: string): string | undefined {
  const m = /-(minimal|low|medium|high|xhigh)$/i.exec(modelId)
  return m ? (m[1] as string).toUpperCase() : undefined
}

/**
 * Capability table of one backend id, before the effort levels are set.
 *
 * Flash Lite is tested first: `gemini-3.1-flash-lite` has "3." and a 65535
 * output limit, and it is not a Gemini 3 Flash.
 */
export function antigravityCapabilitiesFor(row: { id: string; out: number }): Capabilities {
  const family = antigravityFamily(row.id)
  if (family === "claude") return CAPS_CLAUDE_VERTEX
  if (family === "gpt-oss") return CAPS_GPT_OSS
  if (family === "image") return CAPS_IMAGE_GEN
  if (row.id.includes("flash-lite")) return CAPS_GEMINI_FLASH_LITE
  if (row.out >= 262_144) return CAPS_GEMINI_4
  if (row.out >= 65_536 && row.id.includes("flash")) return CAPS_GEMINI_3_FLASH
  if (row.out >= 65_536) return CAPS_GEMINI_4_SMALL_OUT
  return CAPS_GEMINI_FLASH_LITE
}

/** Effort levels of an id with no family: its own suffix, or none. */
function singleEffortLevels(id: string): string[] {
  const suffix = thinkingSuffixOf(id)?.toLowerCase()
  return suffix ? [suffix] : []
}

/** A normalized backend row: the one shape both sources map to. */
interface NormalRow {
  id: string
  name: string
  out: number
  img: boolean
  recommended?: boolean
  vertexModelId?: string
}

function tagsFor(capabilities: Capabilities, img: boolean, recommended?: boolean): string[] {
  const tags = ["antigravity"]
  if (recommended) tags.push("recommended")
  if (img) tags.push("vision")
  if (capabilities.thinking.visible) tags.push("reasoning")
  if (capabilities.effort.levels.length > 1) tags.push("thinking-levels")
  return tags
}

/** Spec of one id with no family. */
function singleSpec(r: NormalRow): ProviderModelSpec {
  const levels = singleEffortLevels(r.id)
  const capabilities = withEffort(antigravityCapabilitiesFor(r), levels, levels[0])
  return {
    id: r.id,
    providerId: ANTIGRAVITY_PROVIDER_ID,
    surfaceId: ANTIGRAVITY_SURFACE_ID,
    displayName: r.name,
    tags: tagsFor(capabilities, r.img, r.recommended),
    capabilities,
    estimateTokens: estimatorForModelId(r.id, "gemma"),
    pricing: PRICING_ANTIGRAVITY_PLAN,
    vendorIds: { model: r.id, ...(r.vertexModelId ? { vertex: r.vertexModelId } : {}) },
  }
}

/** Spec of one family. `rep` is the backend row of the default effort. */
function groupSpec(group: AntigravityModelGroup, rep: NormalRow): ProviderModelSpec {
  const capabilities = withEffort(
    antigravityCapabilitiesFor(rep),
    group.levels,
    group.defaultEffort,
  )
  return {
    id: group.base,
    aliases: group.levels.map((level) => `${group.base}-${level}`),
    providerId: ANTIGRAVITY_PROVIDER_ID,
    surfaceId: ANTIGRAVITY_SURFACE_ID,
    displayName: group.name,
    tags: tagsFor(capabilities, rep.img, rep.recommended),
    capabilities,
    estimateTokens: estimatorForModelId(group.base, "gemma"),
    pricing: PRICING_ANTIGRAVITY_PLAN,
    vendorIds: {
      model: `${group.base}-${group.defaultEffort}`,
      [EFFORT_BASE_VENDOR_KEY]: group.base,
      ...(rep.vertexModelId ? { vertex: rep.vertexModelId } : {}),
    },
  }
}

/**
 * Default effort of a family: the suffix of the backend default agent model
 * when it is in the family, else `medium`, else the first level.
 */
export function antigravityGroupDefaultEffort(
  base: string,
  levels: ReadonlyArray<string>,
  defaultAgentModelId?: string,
): string {
  for (const level of levels) {
    if (defaultAgentModelId === `${base}-${level}`) return level
  }
  if (levels.includes(FALLBACK_FAMILY_EFFORT)) return FALLBACK_FAMILY_EFFORT
  return levels[0] ?? FALLBACK_FAMILY_EFFORT
}

/**
 * Build the catalog rows: one spec per family, then one spec per id that is
 * in no family. A family level with no backend row is dropped, so the wire
 * never names an id that the backend does not list.
 */
function buildSpecs(
  rows: ReadonlyArray<NormalRow>,
  groups: ReadonlyArray<{ base: string; name: string; levels: ReadonlyArray<string> }>,
  defaultAgentModelId: string | undefined,
): { specs: ProviderModelSpec[]; groups: AntigravityModelGroup[] } {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const memberIds = new Set<string>()
  const specs: ProviderModelSpec[] = []
  const built: AntigravityModelGroup[] = []
  for (const g of groups) {
    const levels = g.levels.map((l) => l.toLowerCase()).filter((l) => byId.has(`${g.base}-${l}`))
    if (levels.length === 0) continue
    const group: AntigravityModelGroup = {
      base: g.base,
      name: g.name,
      levels,
      defaultEffort: antigravityGroupDefaultEffort(g.base, levels, defaultAgentModelId),
    }
    for (const level of levels) memberIds.add(`${g.base}-${level}`)
    const rep = byId.get(`${g.base}-${group.defaultEffort}`) as NormalRow
    specs.push(groupSpec(group, rep))
    built.push(group)
  }
  for (const r of rows) {
    if (memberIds.has(r.id) || r.id.startsWith("tab_")) continue
    specs.push(singleSpec(r))
  }
  return { specs, groups: built }
}

function normalFromCatalog(id: string, r: CatalogModelRow): NormalRow {
  return {
    id,
    name: r.displayName ?? id,
    out: r.maxOutputTokens ?? 65_536,
    img: r.supportsImages ?? true,
    recommended: r.recommended,
    vertexModelId: r.vertexModelId,
  }
}

/**
 * Build the catalog rows from a live `fetchAvailableModels` response: the same
 * family rows as the static catalog, for any family the account lists.
 */
export function antigravitySpecsFromCatalog(response: CatalogResponse): ProviderModelSpec[] {
  return buildFromCatalog(response).specs
}

function buildFromCatalog(response: CatalogResponse) {
  const rows = Object.entries(response.models ?? {}).map(([id, r]) => normalFromCatalog(id, r))
  const groups = Object.entries(response.groupedModels ?? {}).map(([base, g]) => ({
    base,
    name: g.displayName ?? base,
    levels: (g.supportedThinkingLevels ?? [])
      .map((l) => l.thinkingSuffix ?? "")
      .filter((l) => l.length > 0),
  }))
  return buildSpecs(rows, groups, response.defaultAgentModelId)
}

/** Build a provider model spec from one live catalog row with no family. */
export function antigravityModelSpecFromCatalog(
  id: string,
  row: CatalogModelRow,
): ProviderModelSpec {
  return singleSpec(normalFromCatalog(id, row))
}

/** Build a provider model spec from one snapshot row, as a row with no family. */
export function antigravityModelSpecFromSnapshot(row: CatalogSnapshotRow): ProviderModelSpec {
  return singleSpec(row)
}

const STATIC = buildSpecs(SNAPSHOT, SNAPSHOT_GROUPS, SNAPSHOT_DEFAULT_AGENT_MODEL)

/** The static catalog: one spec per family, then the ids with no family. */
export const ANTIGRAVITY_MODELS: ReadonlyArray<ProviderModelSpec> = STATIC.specs

/** The families of the static catalog. */
export const ANTIGRAVITY_MODEL_GROUPS: ReadonlyArray<AntigravityModelGroup> = STATIC.groups

/** A local view of a registered model, for label helpers. Keyed by id and alias. */
const localCatalog = new Map<string, { name: string; contextWindow: number; tags: string[] }>()

/** Family specs of the last live catalog, keyed by base id and by alias. */
const liveFamilies = new Map<string, ProviderModelSpec>()

/**
 * Keep the families of a live catalog, so a later ad hoc registration of a
 * new family (or of one of its suffixed ids) gets the family row.
 */
export function rememberAntigravityLiveCatalog(response: CatalogResponse): void {
  for (const spec of buildFromCatalog(response).specs) {
    if (!spec.vendorIds?.[EFFORT_BASE_VENDOR_KEY]) continue
    liveFamilies.set(spec.id, spec)
    for (const alias of spec.aliases ?? []) liveFamilies.set(alias, spec)
  }
}

/** Drop the remembered live families. Tests call this between cases. */
export function clearAntigravityLiveFamilies(): void {
  liveFamilies.clear()
}

function remember(spec: ProviderModelSpec): void {
  const view = {
    name: spec.displayName,
    contextWindow: spec.capabilities.contextWindow,
    tags: [...(spec.tags ?? [])],
  }
  localCatalog.set(spec.id, view)
  for (const alias of spec.aliases ?? []) localCatalog.set(alias, view)
}

/** Register the static catalog and set the default model. */
export function registerAntigravityModels(registrar: ModelRegistrar): string[] {
  for (const spec of ANTIGRAVITY_MODELS) {
    registrar.register(spec)
    remember(spec)
  }
  registrar.setDefault(ANTIGRAVITY_DEFAULT_MODEL)
  return ANTIGRAVITY_MODELS.map((s) => s.id)
}

/**
 * Register one model that the static catalog does not have (a live-only id).
 * A base id or a suffixed id of a remembered live family registers the family
 * row. Any other id registers a row with no family.
 */
export function registerAntigravityAdHocModelInto(
  registrar: ModelRegistrar,
  modelId: string,
  row?: CatalogModelRow,
): void {
  if (localCatalog.has(modelId)) return
  const family = liveFamilies.get(modelId)
  if (family && !localCatalog.has(family.id)) {
    registrar.register(family)
    remember(family)
    return
  }
  const spec = antigravityModelSpecFromCatalog(modelId, row ?? {})
  registrar.register(spec)
  remember(spec)
}

/** Context window of a registered id or alias, when this process registered it. */
export function antigravityContextWindow(modelId: string): number | undefined {
  return localCatalog.get(modelId)?.contextWindow
}

/** Short provider code for the status bar. */
const SHORT_CODE = "agy"

/** Compact status-bar label (`agy-4-neon`). */
export function antigravityModelShortLabel(modelId: string): string {
  if (!modelId) return ""
  const token = modelId
    .replace(/^gemini-/, "")
    .replace(/^claude-/, "claude-")
    .replace(/^gpt-oss-/, "oss-")
  return token ? `${SHORT_CODE}-${token}` : SHORT_CODE
}

/** Version token: the model id with the vendor prefix removed. */
export function antigravityModelVersionToken(modelId: string): string {
  return modelId.replace(/^gemini-/, "")
}

/**
 * The static catalog row of an id or an alias, the same rule as the host
 * registry: `gemini-4-neon-high` gives the `gemini-4-neon` row.
 */
export function findAntigravityModel(idOrAlias: string): ProviderModelSpec | undefined {
  return ANTIGRAVITY_MODELS.find((s) => s.id === idOrAlias || s.aliases?.includes(idOrAlias))
}

/** All model ids of the static catalog (tests and docs). */
export function listAntigravityStaticModelIds(): string[] {
  return ANTIGRAVITY_MODELS.map((s) => s.id)
}
