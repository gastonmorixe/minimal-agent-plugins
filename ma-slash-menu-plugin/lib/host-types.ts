/**
 * Local mirror of the bits of minimal-agent's plugin contract this
 * plugin actually uses. Lets us type-check standalone (bun test,
 * editor IntelliSense) without coupling to a `../../../minimal-agent/src/...`
 * path that wouldn't exist for everyone.
 *
 * Same pattern as `ma-fetch-plugin/lib/types.ts`. If the agent's
 * contract changes, update this file. The fields we use are narrow on
 * purpose — see `HookHandlerContext` and `EventHandlerContext` below.
 *
 * @module ma-slash-menu/lib/host-types
 */

/**
 * Mirror of `src/plugins/types.ts:CommandInfo` — one registered slash
 * command, as exposed read-only through `ctx.listCommands()`.
 */
export interface CommandInfo {
  /** Command name without the slash (e.g. "config"). */
  name: string
  /** One-line description. */
  summary: string
  /** Optional argument hint. */
  argHint?: string
  /** Owning plugin id. */
  pluginId: string
}

/**
 * Mirror of `src/plugins/types.ts:HookHandlerContext`.
 *
 * Only the fields we actually consume are typed; the rest are noted in
 * comments for discoverability.
 */
export interface HookHandlerContext {
  /** Channel name being dispatched (e.g. "editor.key"). */
  channel: string
  /** Plugin package directory (absolute). */
  packageDir: string
  /** The agent's cwd. */
  cwd: string
  /** Plugin-scoped environment. */
  env: Record<string, string>
  /** Aborts on bus disposal. */
  abort: AbortSignal
  /** Listener priority post-clamping. */
  priority: number
  /**
   * Emit on the agent bus. Routed by target channel shape (sync /
   * async). Added May 2026 so hook handlers can fan out to other
   * channels (e.g. an `editor.key` listener emitting
   * `editor.footer.set`).
   */
  emit: (channel: string, payload?: unknown) => void
  /**
   * Read-only snapshot of every registered slash command (host-populated).
   * `undefined` on hosts that predate the command registry — narrow with
   * `ctx.listCommands?.() ?? []`.
   */
  listCommands?: () => CommandInfo[]
  stderr: NodeJS.WriteStream
}

/**
 * Mirror of `src/plugins/types.ts:EventHandlerContext`.
 */
export interface EventHandlerContext<TPayload = unknown> {
  event: string
  payload: TPayload
  packageDir: string
  cwd: string
  env: Record<string, string>
  emit: (event: string, payload?: unknown) => void
  /** See {@link HookHandlerContext.listCommands}. */
  listCommands?: () => CommandInfo[]
  abort: AbortSignal
  stderr: NodeJS.WriteStream
}
