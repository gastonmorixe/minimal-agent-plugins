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

/** The slice of `ctx.prompts` this plugin uses. Mirror of `PluginPromptsContext`. */
export interface PluginPrompts {
  render(name: string, vars?: Readonly<Record<string, string | number | boolean>>): string
  expand(text: string): string
}

/** Lead tool name policy. Mirror of core `StartupProfileTools` (plugin-api/types/startup-profile). */
export type StartupProfileTools =
  | { readonly kind: "all" }
  | { readonly kind: "none" }
  | { readonly kind: "list"; readonly names: readonly string[] }

/** One system-prompt part override. Mirror of core `StartupProfilePromptPart`. */
export type StartupProfilePromptPart =
  | { readonly kind: "default" }
  | { readonly kind: "replace"; readonly text: string }
  | { readonly kind: "omit" }

/** System-prompt part names. Mirror of core `StartupProfilePartName`. */
export type StartupProfilePartName =
  | "full"
  | "identity"
  | "providerPreamble"
  | "instructions"
  | "toolOutputConventions"
  | "sessionContext"

/** Final system-prompt overrides. Mirror of core `StartupProfileSystemPrompt`. */
export type StartupProfileSystemPrompt = Readonly<
  Partial<Record<StartupProfilePartName, StartupProfilePromptPart>>
> & { readonly unsafeProviderOverrides?: boolean }

/** The lead's final startup settings. Mirror of core `StartupProfile`. */
export interface StartupProfile {
  readonly version: 1
  readonly systemPrompt: StartupProfileSystemPrompt
  readonly noAgentsMd: boolean
  readonly pluginPrompts: {
    readonly all: boolean
    readonly suppress: readonly string[]
    readonly keep: readonly string[]
  }
  readonly plugins: { readonly disable: readonly string[]; readonly enable: readonly string[] }
  readonly bare: boolean
  readonly tools: StartupProfileTools
  /** Lead prompt-cache anchor flag. Absent in an older profile. */
  readonly cacheAnchor?: boolean
  /** Lead older-turn thinking mode. Absent in an older profile. */
  readonly thinkingHistory?: "strip" | "keep"
}

/** One mode and its tool permissions. Mirror of core `ModePolicyEntry`. */
export interface ModePolicyEntry {
  readonly id: string
  readonly label?: string
  /**
   * Derived from effective rules, first rule per tool wins. `allow` / `deny`:
   * tools whose first rule is allow:true / allow:false. `match`: tools whose
   * first rule is a predicate ("match") rule. The lists are disjoint. "*" allowed.
   * `match` is absent on an older core: treat it as empty.
   */
  readonly permissions: {
    readonly allow: readonly string[]
    readonly deny: readonly string[]
    readonly match?: readonly string[]
  }
}

/** The lead's live target. Mirror of core `TargetSnapshot`. */
export interface TargetSnapshot {
  credentialName?: string
  providerId?: string
  model: string
  effort?: string
}

/** Live mode + tool policy of the lead. Mirror of core `HostPolicySnapshot`. */
export interface HostPolicySnapshot {
  /** Live mode id at call time, null = no mode (unrestricted). */
  readonly activeModeId: string | null
  readonly modes: readonly ModePolicyEntry[]
  /** Lead tool name policy (--tools/--no-tools). */
  readonly tools: StartupProfileTools
}

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
 *
 * `effort.levels` (when present) is the lead model's declared reasoning
 * levels — used to reject per-spawn `effort` values the worker would die
 * on at boot, instead of advertising a universal low|medium|high menu.
 */
export interface ModelInfoSnapshot {
  modelId: string
  providerId?: string
  effort?: {
    levels: string[]
    default?: string
  }
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
    /** Provider-scoped lookup (no cross-provider fallback). Optional on older hosts. */
    findForProvider?(modelId: string, providerId: string): { providerId?: string } | undefined
    /** Every registered entry. Present on older hosts that lack `findForProvider`. */
    list?(): readonly { id: string; providerId?: string; aliases?: readonly string[] }[]
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
  /** Prompt template access. Absent when the host wires no provider. */
  prompts?: PluginPrompts
  queryModelInfo?: () => ModelInfoSnapshot | undefined
  recommendSubagentModels?: () => SubagentModelRecommendation[]
  host?: PluginHost
  /** Live mode + tool policy snapshot. Absent on older cores (SPEC T8). */
  queryHostPolicy?: () => HostPolicySnapshot | undefined
  /**
   * The lead's live target (credential, provider, model, effort). It follows
   * a target switch during the session. Absent on older cores, and in a host
   * with more sessions in one process.
   */
  queryTarget?: () => TargetSnapshot | undefined
  /** The lead's startup profile and its file path. Absent on older cores. */
  startupProfile?: () => { path: string; profile: StartupProfile } | undefined
  emitChain?: <T>(
    channel: string,
    payload: T,
  ) => Promise<{
    payload: T
    halted: boolean
    reason?: string
    /** True when a failClosed listener failed (threw, timed out, bad result). */
    failed?: boolean
    /** Set with `failed`: the listener label and the error text. */
    failure?: { label?: string; detail: string }
  }>
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

/** Runtime context passed to an events[] handler. Mirror of the slice we read. */
export interface EventHandlerContext<TPayload = unknown> {
  event: string
  payload: TPayload
  env: Record<string, string>
  log: PluginLogger
  agent?: AgentContext
}

/**
 * Runtime context passed to a hooks[] handler. Mirror of the host's
 * `HookHandlerContext`, narrowed to what this plugin's lifecycle hooks read.
 */
export interface HookHandlerContext {
  channel?: string
  packageDir?: string
  cwd: string
  env: Record<string, string>
  abort?: AbortSignal
  priority?: number
  emit?: (channel: string, payload?: unknown) => void
  stderr?: NodeJS.WriteStream
  agent?: AgentContext
  log?: PluginLogger
}
