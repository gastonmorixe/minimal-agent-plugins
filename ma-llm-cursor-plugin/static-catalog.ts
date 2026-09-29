/**
 * Generated from authenticated Cursor AvailableModels (parameterized).
 *
 * Source probe: 2026-09-29 via AvailableModels with
 * use_model_parameters=true, include_hidden_models=true,
 * include_long_context_models=true, variants_will_be_shown_in_exploded_list=true.
 * Parents use API names (`grok-4.6`); exploded variant host ids keep legacy
 * slugs (`cursor-grok-4.6-high`) for AgentService/Run.
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
