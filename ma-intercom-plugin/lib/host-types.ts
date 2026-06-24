/**
 * Local type stubs mirroring minimal-agent's plugin contract.
 *
 * Why local copies?
 *   External plugins don't sit inside the agent's source tree, so they can't
 *   import `@minimal-agent/plugin-api` or `../../../src`, and a plugin should
 *   not reach into the agent's modules anyway. It talks to the host only
 *   through the context the loader passes in. TypeScript types are structural
 *   and erased at runtime, so a local mirror lets us type-check this plugin
 *   standalone (bun test, editor IntelliSense) while staying byte-compatible
 *   with the agent's real contract.
 *
 * Source of truth in the host: `plugin-api/src/types/plugin.ts` and
 * `plugin-api/src/types/host-capabilities.ts`. Keep the fields we use narrow;
 * update here if the host contract changes.
 *
 * @module lib/host-types
 */

import type { Transport } from "./transport.ts"

// ---------------------------------------------------------------------------
// Shared identity
// ---------------------------------------------------------------------------

/**
 * Boot-time identity of the host agent, shared with every handler context.
 * Mirror of `AgentContext`. We read `sessionId` (whose presence + inbox this
 * is), `pid` (liveness), `model`, and `version`.
 */
export interface AgentContext {
  /** Per-process session uuid. Same value the host's `getSessionId()` returns. */
  readonly sessionId: string
  /** Agent process id. */
  readonly pid: number
  /** Resolved model id the agent runs on. */
  readonly model: string
  /** Agent semver. */
  readonly version: string
}

// ---------------------------------------------------------------------------
// Host capability surface (the subset we declare in the manifest)
// ---------------------------------------------------------------------------

/** One row of the global session index (`sessions:read`). */
export interface SessionIndexEntry {
  readonly sid: string
  readonly createdAt: string
  readonly cwd: string
  readonly model: string
}

/** Liveness verdict the host computes (`sessions:read` meta). We surface it as a fallback. */
export type HostSessionLiveness =
  | {
      readonly status: "live"
      readonly source: string
      readonly pid?: number
      readonly since?: string
    }
  | { readonly status: "dead"; readonly source: string; readonly reason: string }
  | { readonly status: "unknown"; readonly source: string; readonly reason: string }

/** Always-available session metadata (`sessions:read` meta). Narrowed to what we read. */
export interface SessionMetaView {
  readonly sid: string
  readonly createdAt: string | null
  readonly cwd: string | null
  readonly model: string | null
  readonly agentVersion: string | null
  readonly recordCount: number
  readonly counts: Readonly<Record<string, number>>
  readonly firstPrompt: string | null
  readonly lastActivity: string | null
  readonly liveness: HostSessionLiveness
  readonly hasTasks: boolean
  readonly blobCount: number
}

/** One record in a {@link RecordWindow}. */
export interface RecordView {
  readonly index: number
  readonly kind: string
  readonly ts: string | null
  readonly summary: string
  readonly preview: string
  readonly clipped: boolean
  readonly fullChars: number
}

/** A stable, lazy window into a session's records (`sessions:read` window). */
export interface RecordWindow {
  readonly sid: string
  readonly items: readonly RecordView[]
  readonly total: number
  readonly firstIndex: number | null
  readonly lastIndex: number | null
}

/** Options for {@link SessionsReadApi.window}. */
export interface WindowOpts {
  readonly anchor: "start" | "end"
  readonly offset?: number
  readonly limit?: number
  readonly previewChars?: number
}

/** `sessions:read` — read-only access to the session store. Narrowed to what we call. */
export interface SessionsReadApi {
  list(opts?: {
    cwd?: string
    query?: string
    limit?: number
    offset?: number
  }): Promise<{ items: readonly SessionIndexEntry[]; total: number }>
  meta(sid: string): Promise<SessionMetaView | null>
  window(sid: string, opts: WindowOpts): Promise<RecordWindow | null>
}

/**
 * `intercom:transport` (host-brokered, NOT YET WIRED IN CORE) — the registry a
 * decoupled transport-provider plugin (the future `minimal-agent-cloud`) uses to
 * hand Intercom a remote {@link Transport} WITHOUT either plugin importing the
 * other. Same dependency-inversion shape core already uses for provider plugins
 * (`ProviderPlugin.register(ctx)` + a host registrar): the cloud plugin calls
 * `register(remoteTransport)`, Intercom calls `list()` and folds the results
 * into its {@link CompositeTransport}.
 *
 * This is a STUB declaration for A5: the host does not populate
 * `transportRegistry` yet (the core capability lands in a later pass — my other
 * lane), so today `ctx.host?.transportRegistry` is always `undefined` and
 * Intercom falls back to local-only. Declaring it now lets the wiring compile
 * and be ready, and documents the exact seam the cloud plugin fills.
 *
 * The registry traffics in objects satisfying Intercom's {@link Transport} shape
 * structurally; the cloud plugin re-declares the same shape locally (the
 * "re-declare the slice you consume as a local structural interface" rule) and
 * implements it. The host is a neutral broker that just holds + returns them.
 */
export interface TransportRegistryApi {
  /** A transport-provider plugin registers its remote transport here. */
  register(transport: Transport): void
  /** Intercom reads every registered remote transport to build its Composite. */
  list(): Transport[]
}

/**
 * The frozen capability host handed to the plugin as `ctx.host`. Only the
 * namespaces the manifest declared are populated; the rest are `undefined`,
 * so we always narrow before use.
 *
 * We declare `sessions` (the one capability the manifest requests today) and
 * `transportRegistry` (the stubbed remote-transport injection seam — absent
 * until the core capability is wired, so always narrowed before use). The host
 * populates other namespaces (clock, logger, ...) when granted, but this plugin
 * doesn't use them, so we don't re-declare their contracts here (a stale local
 * copy of a contract we never call is just drift waiting to happen). For
 * diagnostics the handlers use the always-present `ctx.log`, not `host.logger`.
 */
export interface PluginHost {
  readonly capabilities: readonly string[]
  readonly sessions?: SessionsReadApi
  /**
   * Remote-transport registry (`intercom:transport`). STUB: undefined until the
   * core capability is wired. Narrow before use (`if (ctx.host?.transportRegistry)`).
   */
  readonly transportRegistry?: TransportRegistryApi
}

// ---------------------------------------------------------------------------
// Tool handler context
// ---------------------------------------------------------------------------

/** A tool trigger: the model called one of this plugin's tools. */
export interface ToolTrigger {
  type: "tool"
  /** The tool name as declared in the manifest (`Peers`, `Send`, `Inbox`). */
  name: string
  /** Raw input the model produced. Validate before use. */
  input: Record<string, unknown>
  /** The tool_use id from the wire protocol. */
  tool_use_id?: string
}

/**
 * Runtime context passed to a tool-call handler. Mirror of `TUIContext`,
 * narrowed to the fields we consume.
 */
export interface TUIContext {
  trigger: ToolTrigger | { type: "inline_tag"; [k: string]: unknown }
  /** Absolute path to the plugin's own directory. */
  packageDir: string
  /** The agent's current working directory. */
  cwd: string
  /** Environment dict. The loader injects `TUI_PLUGIN_PROTOCOL=1` and friends. */
  env: Record<string, string>
  /** Cancelled when the user aborts the turn or a timeout fires. */
  abort: AbortSignal
  stdout: NodeJS.WriteStream
  stdin: NodeJS.ReadStream
  stderr: NodeJS.WriteStream
  /** Boot-time agent identity. Optional only on the legacy back-compat path. */
  agent?: AgentContext
  /** Frozen capability host (only declared namespaces populated). */
  host?: PluginHost
}

/** A handler's return value. Mirror of `TUIResult`. */
export type TUIResult =
  | {
      kind: "tool_result"
      /** Sent back to the model. */
      content: string
      is_error?: boolean
      /** Optional ANSI body rendered in the transcript (no truncation). */
      display?: string
      /** Optional header content slot (after the icon+label). */
      displayHeader?: string
      /** Optional footer content slot (after the closing glyph). */
      displayFooter?: string
    }
  | { kind: "rendered"; ansi: string }
  | { kind: "interactive_result"; value: unknown }

export type TUIHandler = (ctx: TUIContext) => Promise<TUIResult>

// ---------------------------------------------------------------------------
// Live-area slot context
// ---------------------------------------------------------------------------

/**
 * Runtime context passed to a live-area slot handler. Mirror of
 * `LiveAreaHandlerContext`, narrowed to what we use.
 *
 * A slot is invoked at REPL start and then every `refreshMs`. It returns a
 * string (the row to paint), `null` (clear the row), or throws (clear + log).
 */
export interface LiveAreaHandlerContext {
  /** Absolute path to the plugin's own directory. */
  packageDir: string
  /** The agent's current working directory. */
  cwd: string
  /** Plugin-scoped environment. */
  env: Record<string, string>
  /** Aborts when the per-invocation timeout fires or the REPL is closing. */
  abort: AbortSignal
  stderr: NodeJS.WriteStream
  /** Monotonically increasing tick counter for this slot (0 on first call). */
  tick: number
  /**
   * Fire-and-forget emit onto the shared plugin event bus. We use it to wake
   * an idle peer between turns via `emit("prompt.inject", {text, source})`.
   * Optional and best-effort: `undefined` (or a no-op) when constructed
   * without a bus (some tests).
   */
  emit?: (channel: string, payload?: unknown) => void
  /** Boot-time agent identity. Optional only on the legacy back-compat path. */
  agent?: AgentContext
}

export type LiveAreaHandler = (
  ctx: LiveAreaHandlerContext,
) => Promise<string | null> | string | null

// ---------------------------------------------------------------------------
// Event subscription context
// ---------------------------------------------------------------------------

/**
 * Runtime context passed to an event-subscription handler. Mirror of
 * `EventHandlerContext`, narrowed. We subscribe to `turn.didStart`,
 * `turn.didEnd`, and `agent.willStop` to enrich our presence record.
 */
export interface EventHandlerContext<TPayload = unknown> {
  /** The event name that triggered this invocation. */
  event: string
  /** Payload provided by the emitter. Shape is event-specific. */
  payload: TPayload
  /** Absolute path to the plugin's own directory. */
  packageDir: string
  /** The agent's current working directory. */
  cwd: string
  /** Plugin-scoped environment. */
  env: Record<string, string>
  /** Re-emit on the same bus. */
  emit: (event: string, payload?: unknown) => void
  /** Aborts when the agent is shutting down. */
  abort: AbortSignal
  stderr: NodeJS.WriteStream
  /** Boot-time agent identity. Optional only on the legacy back-compat path. */
  agent?: AgentContext
}

export type EventHandler<TPayload = unknown> = (
  ctx: EventHandlerContext<TPayload>,
) => void | Promise<void>

// ---------------------------------------------------------------------------
// Turn-attachment context (the `turnAttachments` manifest port)
// ---------------------------------------------------------------------------

/**
 * A model-facing content block. The host's turn-attachment registry expects
 * `toAttachment(): ContentBlock | null`; a text block satisfies that union
 * structurally, so we emit one without importing host code.
 */
export interface AttachmentTextBlock {
  type: "text"
  text: string
}

/**
 * Context handed to a turn-attachment factory at instantiation. Mirror of
 * the host's `TurnAttachmentContext`. Deliberately small.
 */
export interface TurnAttachmentContext {
  /** The live session id, or `null` when no session is plumbed through. */
  sessionId: string | null
  /** The loader's event bus, when present. Typed `unknown` by the host on purpose. */
  bus?: unknown
}

/** The producer shape the host drains once per `Agent.run` at the user-content seam. */
export interface TurnAttachmentProducer {
  toAttachment(): AttachmentTextBlock | null
}

export type TurnAttachmentFactory = (ctx: TurnAttachmentContext) => TurnAttachmentProducer
