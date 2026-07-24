/**
 * Cursor session metadata for the status bar (MVP stub).
 *
 * Optional GetMe / usage later. Cache-only; never throws.
 *
 * @module llm/providers/cursor/session-info
 */

import type { ProviderSessionContext, ProviderSessionInfo } from "./lib/provider-plugin.ts"

/**
 * Resolve Cursor session metadata. Scaffold returns `{}` (context-only);
 * host synthesizes window + label from the registry.
 */
export async function fetchCursorSessionInfo(
  ctx: ProviderSessionContext,
): Promise<ProviderSessionInfo | null> {
  if (ctx.signal?.aborted) return {}
  return {}
}
