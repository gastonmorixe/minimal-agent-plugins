/**
 * LOCAL structural re-declaration of the host plugin-contract slice this
 * plugin consumes. An external plugin may NOT import host code
 * (`@minimal-agent/plugin-api` or core `src/...`), not even type-only — it
 * must be able to live in its own repository. TypeScript types are structural
 * and erased at runtime, so the real host objects the loader passes satisfy
 * these while we type-check + unit-test standalone.
 *
 * Source of truth in the host: `plugin-api/src/types/plugin.ts`
 * (`TUIContext`, `TUITrigger`, `TUIResult`, `ToolAvailability`,
 * `ToolAvailabilityContext`, `LiveAreaHandlerContext`, and the supporting
 * `AgentContext` / `PluginLogger` / `PluginHost` / `ModelInfoSnapshot` /
 * `SubagentModelRecommendation` shapes). Keep this narrow to the fields the
 * plugin reads and update it if the host contract changes.
 *
 * @module sub-agents/lib/host-types
 */

/** Boot-time agent identity. Mirror of the host's `AgentContext`. */
export interface AgentContext {
  readonly sessionId: string
  readonly pid: number
  readonly model: string
  readonly version: string
}

/** Plugin-scoped diagnostic logger. Mirror of the host's `PluginLogger`. */
export interface PluginLogger {
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
  debug(msg: string): void
}

/**
 * Live model snapshot. Mirror of the slice of `ModelInfoSnapshot` we read.
 * `providerId` is required on the host's full snapshot; optional here so
 * partial test fakes stay valid, but when present it is the lead's live
 * provider and MUST win over unscoped registry last-write-wins for the
 * lead's own model id (dual-registered SKUs like `grok-4.5`).
 */
export interface ModelInfoSnapshot {
  modelId: string
  providerId?: string
}

/** Provider role→model recommendation. Mirror of `SubagentModelRecommendation`. */
export interface SubagentModelRecommendation {
  role: string
  modelId: string
  effort?: string
}

/**
 * The capability-host slice this plugin reads: the model registry's `find`.
 * Mirror of the relevant part of the host's `PluginHost`.
 */
export interface PluginHost {
  models?: {
    find(modelId: string): { providerId?: string } | undefined
  }
}

/**
 * What triggered a TUI handler. Mirror of the host's `TUITrigger` union: the
 * `tool` arm (which every sub-agents handler runs under) carries the tool
 * name, parsed input, and wire id.
 */
export type TUITrigger =
  | {
      type: "tool"
      name: string
      input: Record<string, unknown>
      tool_use_id: string
    }
  | { type: "inline_tag"; name: string; body: string }

/**
 * The slice of `TUIContext` this plugin reads. Mirror of the host's
 * `TUIContext`: the trigger, package/cwd/env, the abort signal, the terminal
 * handles, the logger, the optional frozen agent identity, and the optional
 * live model-query / recommendation / capability-host hooks (all narrowed at
 * the call site).
 */
export interface TUIContext {
  trigger: TUITrigger
  packageDir: string
  cwd: string
  env: Record<string, string>
  abort: AbortSignal
  stdout: NodeJS.WriteStream
  stdin: NodeJS.ReadStream
  stderr: NodeJS.WriteStream
  log: PluginLogger
  agent?: AgentContext
  queryModelInfo?: () => ModelInfoSnapshot | undefined
  recommendSubagentModels?: () => SubagentModelRecommendation[]
  host?: PluginHost
}

/**
 * The `tool_result` result a sub-agents handler returns. Mirror of that arm
 * of the host's `TUIResult` union.
 */
export interface TUIResult {
  kind: "tool_result"
  content: string
  is_error?: boolean
  display?: string
  displayHeader?: string
  displayFooter?: string
}

/**
 * The read-only context a tool-availability predicate sees. Mirror of the
 * host's `ToolAvailabilityContext` (we only read `env`).
 */
export interface ToolAvailabilityContext {
  env: Record<string, string | undefined>
  cwd?: string
  agent?: AgentContext
}

/** A tool-availability predicate. Mirror of the host's `ToolAvailability`. */
export type ToolAvailability = (ctx: ToolAvailabilityContext) => boolean

/**
 * The slice of `LiveAreaHandlerContext` the heartbeat slot reads. Mirror of
 * the host's `LiveAreaHandlerContext`.
 */
export interface LiveAreaHandlerContext {
  packageDir: string
  cwd: string
  env: Record<string, string>
  abort: AbortSignal
  stderr: NodeJS.WriteStream
  log: PluginLogger
  tick: number
  emit?: (channel: string, payload?: unknown) => void
  agent?: AgentContext
}
