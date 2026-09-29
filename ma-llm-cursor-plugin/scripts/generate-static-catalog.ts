/**
 * Regenerates static-catalog-part-*.ts from authenticated parameterized
 * AvailableModels (`use_model_parameters=true`, including hidden + long-context).
 *
 * bun run scripts/generate-static-catalog.ts
 *
 * Auth: prefers ~/.minimal-agent/auth.jsonc entry named `cursor-oauth-2`
 * (then any `cursor-oauth*` with an accessToken). Optional override:
 *   CURSOR_ACCESS_TOKEN=… bun run scripts/generate-static-catalog.ts
 *
 * Also writes:
 *   tmp/available-models-snapshot.json  (decoded summary for diffs)
 */
import { homedir } from "node:os"
import { join } from "node:path"

import {
  effortParamIdFromTags,
  fastParamIdFromTags,
  resolveCursorEffortParamId,
} from "../capabilities.ts"
import { expandCursorCatalog } from "../catalog-expand.ts"
import { buildCursorHeaders } from "../headers.ts"
import { loadClientIds } from "../ids.ts"
import { parseJsonc } from "../lib/jsonc.ts"
import { encodeAvailableModelsRequest } from "../proto/available-models-request.ts"
import { decodeAvailableModelsResponse } from "../proto/models-decode.ts"
import type { CursorStaticCatalogRow } from "../static-catalog-row.ts"

type Store = {
  entries?: Array<{ id: string; name?: string; secrets: Record<string, string> }>
}

const pluginRoot = join(import.meta.dir, "..")
const PARTS = 6
const today = new Date().toISOString().slice(0, 10)

function resolveAccessToken(store: Store): string {
  const fromEnv = process.env.CURSOR_ACCESS_TOKEN?.trim()
  if (fromEnv) return fromEnv

  const entries = store.entries ?? []
  const preferred =
    entries.find((e) => e.name === "cursor-oauth-2") ??
    entries.find((e) => e.id === "cursor-oauth" && e.name?.startsWith("cursor-oauth")) ??
    entries.find((e) => e.id === "cursor-oauth")
  const token = preferred?.secrets.accessToken?.trim()
  if (!token) {
    throw new Error(
      "no Cursor access token (set CURSOR_ACCESS_TOKEN or add cursor-oauth-2 in ~/.minimal-agent/auth.jsonc)",
    )
  }
  return token
}

async function loadAuthStore(): Promise<Store> {
  const authPath = join(homedir(), ".minimal-agent", "auth.jsonc")
  const file = Bun.file(authPath)
  if (!(await file.exists())) {
    throw new Error(
      `missing ${authPath} (set CURSOR_ACCESS_TOKEN or create auth.jsonc with cursor-oauth-2)`,
    )
  }
  try {
    return parseJsonc(await file.text()) as Store
  } catch {
    throw new Error(`could not parse ${authPath} (fix JSONC or set CURSOR_ACCESS_TOKEN)`)
  }
}

let accessToken: string
try {
  const fromEnv = process.env.CURSOR_ACCESS_TOKEN?.trim()
  accessToken = fromEnv ? fromEnv : resolveAccessToken(await loadAuthStore())
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(`generate-static-catalog: ${msg}`)
  process.exit(1)
}

const ids = await loadClientIds()
const headers = buildCursorHeaders({
  token: accessToken,
  ids,
  streaming: false,
  clientType: "cli",
})
const response = await fetch("https://api2.cursor.sh/aiserver.v1.AiService/AvailableModels", {
  method: "POST",
  headers,
  body: Buffer.from(
    encodeAvailableModelsRequest({
      useModelParameters: true,
      doNotUseMarkdown: true,
      includeHiddenModels: true,
      includeLongContextModels: true,
      variantsWillBeShownInExplodedList: true,
    }),
  ),
})
if (!response.ok) throw new Error(`AvailableModels ${response.status}`)
const decoded = decodeAvailableModelsResponse(new Uint8Array(await response.arrayBuffer()))
const expanded = expandCursorCatalog(decoded, { includeHidden: true }).filter(
  (row) => row.id !== "cursor-auto",
)

const hiddenParents = decoded.models.filter((m) => m.isHidden).length
const visibleParents = decoded.models.length - hiddenParents

const rows: CursorStaticCatalogRow[] = expanded.map((entry) => {
  const row: CursorStaticCatalogRow = {
    id: entry.id,
    wireId: entry.wireId,
    displayName: entry.displayName,
    defaultOn: entry.tags.includes("default-on"),
    supportsThinking: entry.capabilities.thinking.visible,
    supportsImages: entry.capabilities.modalities.image,
    contextWindow: entry.capabilities.contextWindow,
    maxOutputTokens: entry.capabilities.maxOutputTokens,
    effortLevels: entry.capabilities.effort.levels,
  }
  if (entry.capabilities.speedFast) row.speedFast = true
  if (entry.parentWireId) row.parentWireId = entry.parentWireId
  if (entry.runModelId) row.runModelId = entry.runModelId
  if (entry.defaultRunModelId) row.defaultRunModelId = entry.defaultRunModelId
  if (entry.parameterValues && entry.parameterValues.length > 0) {
    row.parameterValues = entry.parameterValues
  }
  if (entry.defaultParameterValues && entry.defaultParameterValues.length > 0) {
    row.defaultParameterValues = entry.defaultParameterValues
  }
  const effortParamId = effortParamIdFromTags(entry.tags)
  if (effortParamId) row.effortParamId = effortParamId
  const fastParamId = fastParamIdFromTags(entry.tags)
  if (fastParamId) row.fastParamId = fastParamId
  if (entry.tags.includes("max-mode")) row.maxMode = true
  if (entry.useVariantString) row.useVariantString = true
  if (entry.tags.includes("hidden")) row.isHidden = true
  return row
})

function emitRow(row: CursorStaticCatalogRow): string {
  const lines = [
    "  {",
    `    id: ${JSON.stringify(row.id)},`,
    `    wireId: ${JSON.stringify(row.wireId)},`,
    `    displayName: ${JSON.stringify(row.displayName)},`,
    `    defaultOn: ${row.defaultOn},`,
    `    supportsThinking: ${row.supportsThinking},`,
    `    supportsImages: ${row.supportsImages},`,
    `    contextWindow: ${row.contextWindow},`,
    `    maxOutputTokens: ${row.maxOutputTokens},`,
    `    effortLevels: ${JSON.stringify(row.effortLevels)},`,
  ]
  if (row.speedFast) lines.push("    speedFast: true,")
  if (row.parentWireId) lines.push(`    parentWireId: ${JSON.stringify(row.parentWireId)},`)
  if (row.runModelId) lines.push(`    runModelId: ${JSON.stringify(row.runModelId)},`)
  if (row.defaultRunModelId) {
    lines.push(`    defaultRunModelId: ${JSON.stringify(row.defaultRunModelId)},`)
  }
  if (row.parameterValues) {
    lines.push(`    parameterValues: ${JSON.stringify(row.parameterValues)},`)
  }
  if (row.defaultParameterValues) {
    lines.push(`    defaultParameterValues: ${JSON.stringify(row.defaultParameterValues)},`)
  }
  if (row.effortParamId) lines.push(`    effortParamId: ${JSON.stringify(row.effortParamId)},`)
  if (row.fastParamId) lines.push(`    fastParamId: ${JSON.stringify(row.fastParamId)},`)
  if (row.maxMode) lines.push("    maxMode: true,")
  if (row.useVariantString) lines.push("    useVariantString: true,")
  if (row.isHidden) lines.push("    isHidden: true,")
  lines.push("  }")
  return lines.join("\n")
}

const chunkSize = Math.ceil(rows.length / PARTS) || 1
for (let i = 0; i < PARTS; i++) {
  const chunk = rows.slice(i * chunkSize, (i + 1) * chunkSize)
  const body = chunk.map(emitRow).join(",\n")
  const contents = `/** Generated from authenticated Cursor AvailableModels; do not hand edit. */
import type { CursorStaticCatalogRow } from "./static-catalog-row.ts"

export const CURSOR_STATIC_CATALOG_PART: readonly CursorStaticCatalogRow[] = [
${body}
]
`
  const dest = join(pluginRoot, `static-catalog-part-${i + 1}.ts`)
  await Bun.write(dest, contents)
  console.error(`wrote ${dest} (${chunk.length} rows)`)
}

await Bun.write(
  join(pluginRoot, "static-catalog.ts"),
  `/**
 * Generated from authenticated Cursor AvailableModels (parameterized).
 *
 * Source probe: ${today} via AvailableModels with
 * use_model_parameters=true, include_hidden_models=true,
 * include_long_context_models=true, variants_will_be_shown_in_exploded_list=true.
 * Parents use API names (\`grok-4.6\`); exploded variant host ids keep legacy
 * slugs (\`cursor-grok-4.6-high\`) for AgentService/Run.
 *
 * Regenerate: bun run scripts/generate-static-catalog.ts
 */

import { CURSOR_STATIC_CATALOG_PART as static_catalog_part_1 } from "./static-catalog-part-1.ts"
import { CURSOR_STATIC_CATALOG_PART as static_catalog_part_2 } from "./static-catalog-part-2.ts"
import { CURSOR_STATIC_CATALOG_PART as static_catalog_part_3 } from "./static-catalog-part-3.ts"
import { CURSOR_STATIC_CATALOG_PART as static_catalog_part_4 } from "./static-catalog-part-4.ts"
import { CURSOR_STATIC_CATALOG_PART as static_catalog_part_5 } from "./static-catalog-part-5.ts"
import { CURSOR_STATIC_CATALOG_PART as static_catalog_part_6 } from "./static-catalog-part-6.ts"
import type { CursorStaticCatalogRow } from "./static-catalog-row.ts"

export type { CursorStaticCatalogRow } from "./static-catalog-row.ts"

export const CURSOR_STATIC_CATALOG: readonly CursorStaticCatalogRow[] = [
  ...static_catalog_part_1,
  ...static_catalog_part_2,
  ...static_catalog_part_3,
  ...static_catalog_part_4,
  ...static_catalog_part_5,
  ...static_catalog_part_6,
]
`,
)

const snapshot = {
  capturedAt: new Date().toISOString(),
  request: {
    useModelParameters: true,
    includeHiddenModels: true,
    includeLongContextModels: true,
    variantsWillBeShownInExplodedList: true,
  },
  parentCount: decoded.models.length,
  visibleParents,
  hiddenParents,
  hostRowCount: rows.length,
  hiddenHostRows: rows.filter((r) => r.isHidden).length,
  useModelParameters: decoded.useModelParameters,
  parents: decoded.models.map((m) => ({
    name: m.name,
    clientDisplayName: m.clientDisplayName,
    isHidden: Boolean(m.isHidden),
    defaultOn: Boolean(m.defaultOn),
    supportsAgent: m.supportsAgent,
    supportsThinking: m.supportsThinking,
    supportsImages: m.supportsImages,
    supportsMaxMode: m.supportsMaxMode,
    contextTokenLimit: m.contextTokenLimit,
    contextTokenLimitForMaxMode: m.contextTokenLimitForMaxMode,
    legacySlugs: m.legacySlugs ?? [],
    idAliases: m.idAliases ?? [],
    parameterDefinitionIds: (m.parameterDefinitions ?? []).map((d) => d.id).filter(Boolean),
    effortParamId: resolveCursorEffortParamId(m),
    variantCount: m.variants?.length ?? 0,
    variantLegacySlugs: (m.variants ?? []).map((v) => v.legacySlug).filter(Boolean),
  })),
  hostIds: rows.map((r) => r.id),
}

await Bun.write(
  join(pluginRoot, "tmp/available-models-snapshot.json"),
  `${JSON.stringify(snapshot, null, 2)}\n`,
)

console.error(
  `total ${rows.length} host ids from ${decoded.models.length} parents ` +
    `(visible=${visibleParents}, hidden=${hiddenParents}, useModelParameters=${decoded.useModelParameters})`,
)
console.error(`wrote ${join(pluginRoot, "tmp/available-models-snapshot.json")}`)
