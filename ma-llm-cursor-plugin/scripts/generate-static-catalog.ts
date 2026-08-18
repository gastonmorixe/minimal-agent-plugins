/**
 * Regenerates static-catalog-part-*.ts from authenticated parameterized
 * AvailableModels (`use_model_parameters=true`).
 *
 * bun run scripts/generate-static-catalog.ts
 *
 * Uses cursor-oauth-2 when present. Writes six parts under this package.
 */
import { homedir } from "node:os"
import { join } from "node:path"

import { effortParamIdFromTags, fastParamIdFromTags } from "../capabilities.ts"
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

const store = parseJsonc(
  await Bun.file(join(homedir(), ".minimal-agent", "auth.jsonc")).text(),
) as Store
const entry =
  store.entries?.find((e) => e.name === "cursor-oauth-2") ??
  store.entries?.find((e) => e.id === "cursor-oauth")
if (!entry?.secrets.accessToken) throw new Error("no cursor-oauth-2 token")

const ids = await loadClientIds()
const headers = buildCursorHeaders({
  token: entry.secrets.accessToken,
  ids,
  streaming: false,
  clientType: "cli",
})
const response = await fetch("https://api2.cursor.sh/aiserver.v1.AiService/AvailableModels", {
  method: "POST",
  headers,
  body: Buffer.from(
    encodeAvailableModelsRequest({ useModelParameters: true, doNotUseMarkdown: true }),
  ),
})
if (!response.ok) throw new Error(`AvailableModels ${response.status}`)
const decoded = decodeAvailableModelsResponse(new Uint8Array(await response.arrayBuffer()))
const expanded = expandCursorCatalog(decoded).filter((row) => row.id !== "cursor-auto")

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
  lines.push("  }")
  return lines.join("\n")
}

const chunkSize = Math.ceil(rows.length / PARTS)
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

console.error(
  `total ${rows.length} host ids from ${decoded.models.length} parameterized parents (useModelParameters=${decoded.useModelParameters})`,
)
