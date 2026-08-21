/**
 * LOCAL structural re-declaration of the host surfaces this plugin consumes.
 *
 * An external plugin may NOT import host code (`@minimal-agent/plugin-api`
 * or core `src/...`), not even type-only — it must be able to live in its
 * own repository. TypeScript types are structural and erased at runtime, so
 * the real host context the loader passes satisfies these while we
 * type-check standalone.
 *
 * Sources of truth in the host:
 *   - `plugin-api/src/types/host-capabilities.ts` (`SessionTokensView`,
 *     `SessionInfoReadApi`).
 *   - `plugin-api/src/types/plugin.ts` (`LiveAreaHandlerContext`).
 * Keep the slices narrow — only what this plugin reads.
 *
 * @module tps/host-types
 */

/**
 * Cumulative token counters for the current session. Mirror of the leaf
 * `SessionTokensView`. This plugin reads ONLY `output`.
 */
export interface SessionTokensView {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheCreate: number
  readonly total: number
  readonly turns: number
  readonly contextSize: number
  readonly contextSizeEstimated: boolean
}

/** The `session-info:read` capability slice this plugin reads off `ctx.host`. */
export interface SessionInfoReadApi {
  tokens(): SessionTokensView
}

/** The capability host slice this plugin narrows. Mirror of `PluginHost`. */
export interface PluginHost {
  sessionInfo?: SessionInfoReadApi
}

/**
 * The slice of `LiveAreaHandlerContext` this plugin's slot consumes: the
 * capability host and the keyed footer-tail publisher.
 */
export interface LiveAreaHandlerContext {
  abort: AbortSignal
  host?: PluginHost
  /**
   * Publish (or clear, with "") this plugin's right-aligned footer tail.
   * Keyed per plugin id by the scheduler; optional + best-effort.
   */
  setFooterTail?: (text: string) => void
}

/**
 * The slice of `EventHandlerContext` the `llm.outputDelta` subscription
 * consumes. The loader always invokes `fn(ctx)`, never `fn(payload)`.
 */
export interface EventHandlerContext {
  event: string
  payload: unknown
}
