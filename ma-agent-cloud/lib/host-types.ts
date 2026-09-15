/**
 * Local structural mirrors of the minimal-agent plugin contract.
 *
 * This plugin lives in its own repo and may NOT import the host (`src/...`) nor
 * any sibling plugin (e.g. ma-intercom-plugin) — the enforced decoupling rule.
 * TypeScript types are structural and erased at runtime, so we re-declare the
 * exact slice we consume; the host's real frozen objects satisfy these
 * interfaces at runtime without a cast.
 *
 * Source of truth in the host: `plugin-api/src/types/host-capabilities.ts`
 * (`PluginHost`, `TransportRegistryApi`, `RegisteredTransport`) and
 * `plugin-api/src/types/plugin.ts` (`TUIContext`, `TUIResult`). Keep the fields
 * narrow; update here if the host contract changes.
 *
 * @module lib/host-types
 */

import type { Transport } from "./transport.ts"

// ---------------------------------------------------------------------------
// Shared identity
// ---------------------------------------------------------------------------

/** Boot-time identity of the host agent. Mirror of `AgentContext`. */
export interface AgentContext {
  readonly sessionId: string
  readonly pid: number
  readonly model: string
  readonly version: string
}

// ---------------------------------------------------------------------------
// transport:registry capability (the seam this plugin FILLS)
// ---------------------------------------------------------------------------

/**
 * The host's transport registry, granted under the `transport:registry`
 * capability. We re-declare it locally (structural mirror of the host's
 * `TransportRegistryApi`). Core treats a transport as opaque; we register a
 * full {@link Transport} (the host accepts it structurally because it only
 * requires `{ id }`).
 */
export interface TransportRegistryApi {
  register(transport: Transport): void
  unregister(id: string): void
  list(): Transport[]
}

/**
 * The frozen capability host handed to a tool/inline handler as `ctx.host`.
 * Only the namespaces our manifest declared are populated; the rest are
 * `undefined`, so we narrow before use. We declare only `transportRegistry`
 * (the one capability we request).
 */
export interface PluginHost {
  readonly capabilities: readonly string[]
  readonly transportRegistry?: TransportRegistryApi
}

// ---------------------------------------------------------------------------
// Tool handler context
// ---------------------------------------------------------------------------

/** A tool trigger: the model called one of this plugin's tools. */
export interface ToolTrigger {
  type: "tool"
  name: string
  input: Record<string, unknown>
  tool_use_id?: string
}

/** Runtime context passed to a tool-call handler. Mirror of `TUIContext`, narrowed. */
export interface TUIContext {
  trigger: ToolTrigger | { type: "inline_tag"; [k: string]: unknown }
  packageDir: string
  cwd: string
  env: Record<string, string>
  abort: AbortSignal
  stdout: NodeJS.WriteStream
  stdin: NodeJS.ReadStream
  stderr: NodeJS.WriteStream
  agent?: AgentContext
  host?: PluginHost
}

/** A handler's return value. Mirror of `TUIResult`. */
export type TUIResult =
  | {
      kind: "tool_result"
      content: string
      is_error?: boolean
      display?: string
      displayHeader?: string
      displayFooter?: string
    }
  | { kind: "rendered"; ansi: string }
  | { kind: "interactive_result"; value: unknown }

export type TUIHandler = (ctx: TUIContext) => Promise<TUIResult>

/**
 * Runtime context passed to a live-area slot handler. Mirror of
 * `LiveAreaHandlerContext`, narrowed to what the uploader slot uses. A slot is
 * invoked at REPL start and then every `refreshMs`, off the turn loop, with an
 * in-flight guard — the ideal never-block hook for background uploads.
 */
export interface LiveAreaHandlerContext {
  packageDir: string
  cwd: string
  env: Record<string, string>
  abort: AbortSignal
  stderr: NodeJS.WriteStream
  /** Monotonic tick counter for this slot (0 on first call). */
  tick: number
  /**
   * Fire-and-forget emit onto the shared plugin event bus. Used to inject a
   * claimed pending prompt into the turn loop via `emit("prompt.inject", {text})`.
   * Optional + best-effort: `undefined` when the host wired no bus (some tests).
   */
  emit?: (channel: string, payload?: unknown) => void
  /** Boot-time agent identity. Optional only on the legacy back-compat path. */
  agent?: AgentContext
}

export type LiveAreaHandler = (
  ctx: LiveAreaHandlerContext,
) => Promise<string | null> | string | null
