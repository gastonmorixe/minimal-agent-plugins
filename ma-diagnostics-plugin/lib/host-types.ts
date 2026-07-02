/**
 * LOCAL structural re-declaration of the host plugin-contract slice this
 * plugin consumes. An external plugin may NOT import host code
 * (`@minimal-agent/plugin-api` or core `src/...`), not even type-only — it
 * must be able to live in its own repository. TypeScript types are structural
 * and erased at runtime, so the real host context the loader passes satisfies
 * these while we type-check standalone.
 *
 * Source of truth in the host: `plugin-api/src/types/plugin.ts`
 * (`LiveAreaHandlerContext`). The LSP-status slot only reads
 * `setDecorationSuffix` — the host-owned seam that replaced the old shared
 * `decoration-suffix` module singleton, so a moved plugin never gets a
 * divergent second copy of the holder. Keep this narrow.
 *
 * @module lib/host-types
 */

/**
 * The slice of `LiveAreaHandlerContext` this plugin's live-area slot reads:
 * just the decoration-suffix publisher. Mirror of the host's
 * `LiveAreaHandlerContext`.
 */
export interface LiveAreaHandlerContext {
  /**
   * Publish (or clear, with `""`) a short decoration-line suffix onto the
   * host's live-area footer. Host owns the storage + the reader; optional +
   * best-effort, so consumers narrow (`ctx.setDecorationSuffix?.(badge)`).
   */
  setDecorationSuffix?: (suffix: string) => void
}
