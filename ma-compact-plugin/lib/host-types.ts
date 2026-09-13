/**
 * LOCAL structural re-declaration of the host plugin-contract slice this
 * plugin consumes. An external plugin may NOT import host code
 * (`@minimal-agent/plugin-api` or core `src/...`), not even type-only — it
 * must be able to live in its own repository. TypeScript types are structural
 * and erased at runtime, so the real host context the loader passes satisfies
 * these while we type-check standalone.
 *
 * Source of truth in the host: `plugin-api/src/types/plugin.ts`
 * (`TUIContext`, `TUIResult`) and core
 * `src/plugins/host/capabilities.ts` (`CapabilityToken "context:compact"`,
 * `PluginHost`). The `ContextCompactApi` shape below mirrors the landed
 * core seam: field `compact` with method `requestCompact(opts)`.
 *
 * @module compact/lib/host-types
 */

/** Compaction engine. Mirror of core `CompactMode` (agent/context-compact). */
export type CompactMode = "remote" | "tail" | "local" | "fork"

/** Why a compact was requested. The tool subset of core `CompactReason`. */
export type CompactTriggerReason = "manual" | "auto"

/**
 * Options the host's compact seam accepts. Mirror of the slice of core
 * `CompactRequestOpts` this plugin sets (`reason`, `mode`, `keepTail`,
 * `focus`). Progress sinks stay host-side; the plugin never sees them.
 */
export interface CompactRequestOpts {
  reason?: CompactTriggerReason
  mode?: CompactMode
  keepTail?: number
  focus?: string
}

/** Outcome of a queue request. `queued: true` means the host accepted it. */
export interface CompactQueueResult {
  queued: boolean
}

/**
 * The `context:compact` capability. Mirrors the landed core seam: the host queues the request and
 * performs the history rewrite after the turn. The plugin never calls
 * `agent.compact()` directly.
 */
export interface ContextCompactApi {
  requestCompact(opts: CompactRequestOpts): Promise<CompactQueueResult> | CompactQueueResult
}

/** The capability host slice this plugin narrows. Mirror of `PluginHost`. */
export interface PluginHost {
  compact?: ContextCompactApi
}

/**
 * What triggered the handler. Mirror of the host's `TUITrigger` `tool` arm.
 */
export type TUITrigger =
  | { type: "tool"; name: string; input: Record<string, unknown>; tool_use_id: string }
  | { type: "inline_tag"; name: string; body: string }

/**
 * The slice of `TUIContext` this plugin reads: the trigger plus the
 * capability host (`compact`). Mirror of the host's `TUIContext`.
 */
export interface TUIContext {
  trigger: TUITrigger
  cwd: string
  env: Record<string, string>
  host?: PluginHost
}

/** The `tool_result` result this handler returns. Mirror of `TUIResult`. */
export interface TUIResult {
  kind: "tool_result"
  content: string
  is_error?: boolean
  displayHeader?: string
}
