/**
 * LOCAL structural re-declaration of the host surfaces this plugin
 * consumes that have no home in the leaf contract package.
 *
 * The decoupling contract (Wave D): a plugin may NOT import host code
 * (`src/...`), not even type-only — it must be able to live in its own
 * repository. Provider-neutral types that the package owns are imported
 * from `@minimal-agent/plugin-api/*`; the slices below are host-internal
 * shapes with no package export, so we re-declare exactly the fields we
 * use and rely on TypeScript's structural typing (the real host object
 * satisfies these at runtime).
 *
 * The host-side source of truth is `src/session-tokens.ts`. Keep field
 * names in lockstep — the plugin's own tests pin the rendered output.
 *
 * @module quota-status/host-types
 */

/**
 * Session-wide token accumulator snapshot. Mirror of the host's
 * `SessionTokens` (`src/session-tokens.ts`). The renderer reads
 * `contextSize` for the context-usage bar and the other cumulative
 * fields for the (debug) totals; all are plain numbers.
 */
export interface SessionTokens {
  /** New input tokens (not served from cache). Cumulative across turns. */
  input: number
  /** Output (generated) tokens. Cumulative across turns. */
  output: number
  /** Cumulative `cache_read_input_tokens` across all turns. */
  cacheRead: number
  /** Input tokens written to cache. Cumulative. */
  cacheCreate: number
  /** Sum of all four cumulative fields. */
  total: number
  /** Number of API responses contributing to these totals. */
  turns: number
  /** Latest turn's footprint in context window. */
  contextSize: number
  /** True when contextSize is an estimate (no billed usage for latest turn). */
  contextSizeEstimated: boolean
}

// ---------------------------------------------------------------------------
// Provider session info (leaf mirror)
// ---------------------------------------------------------------------------

/** One plan/rate-limit window. Mirror of the leaf `QuotaWindow`. */
export interface QuotaWindow {
  /** Provider-defined id, also used verbatim as the short display label. */
  id: string
  /** Utilization fraction in `[0, 1]`. */
  utilization: number
  /** Epoch milliseconds when the window resets, if the provider reports it. */
  resetAtMs?: number
}

/** Provider quota snapshot. Mirror of the leaf `QuotaSnapshot`. */
export interface QuotaSnapshot {
  windows: QuotaWindow[]
  /** Optional provider-neutral overage state. */
  overage?: { active: boolean }
}

/**
 * The active provider's per-session snapshot. Mirror of the leaf
 * `ProviderSessionInfo` (all fields optional).
 */
export interface ProviderSessionInfo {
  contextWindow?: number
  modelLabel?: string
  quota?: QuotaSnapshot
}

// ---------------------------------------------------------------------------
// LiveAreaHandlerContext slice (with the session-info:read capability)
// ---------------------------------------------------------------------------

/**
 * The `session-info:read` capability slice this plugin reads off `ctx.host`.
 * Mirror of the host's `SessionInfoReadApi`: `providerInfo` resolves the
 * active provider's snapshot; `tokens` reads the cumulative session counters.
 */
export interface SessionInfoReadApi {
  providerInfo(
    modelId: string,
    opts?: { signal?: AbortSignal; providerId?: string },
  ): Promise<ProviderSessionInfo>
  tokens(): SessionTokens
}

/** The capability host slice this plugin narrows. Mirror of `PluginHost`. */
export interface PluginHost {
  sessionInfo?: SessionInfoReadApi
}

/**
 * The slice of `LiveAreaHandlerContext` the quota slot reads: the abort
 * signal (forwarded into the provider probe) and the capability host (for
 * the session-info snapshot). Mirror of the host's `LiveAreaHandlerContext`.
 */
export interface LiveAreaHandlerContext {
  abort: AbortSignal
  host?: PluginHost
  /**
   * Display-width cells the host reserves on this line for segments it
   * appends after the slot's own content (decoration suffix + joined
   * footer tails, gaps included). Width-aware renderers subtract this
   * from their usable budget so compression reacts to the FULL painted
   * line. `undefined` when the host doesn't provide it (older host,
   * tests) — treat as 0.
   */
  footerReservedWidth?: number
}
