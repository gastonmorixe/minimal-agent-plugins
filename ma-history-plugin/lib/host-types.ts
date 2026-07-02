/**
 * LOCAL structural re-declaration of the host plugin-contract slice this
 * plugin consumes. An external plugin may NOT import host code
 * (`@minimal-agent/plugin-api` or core `src/...`), not even type-only — it
 * must be able to live in its own repository. TypeScript types are structural
 * and erased at runtime, so the real host contexts the loader passes satisfy
 * these while we type-check + unit-test standalone.
 *
 * Source of truth in the host: `plugin-api/src/types/plugin.ts`
 * (`EventHandler`, `EventHandlerContext`, `HookHandlerContext`). Kept narrow
 * to the fields the two handlers read (`payload`, `cwd`, `log`).
 *
 * @module lib/host-types
 */

/** Plugin-scoped diagnostic logger. Mirror of the host's `PluginLogger`. */
export interface PluginLogger {
  info(source: string, msg: string): void
  warn(source: string, msg: string): void
  error(source: string, msg: string): void
  debug(source: string, msg: string): void
}

/**
 * The slice of `EventHandlerContext` the submit handler reads: the payload,
 * the agent cwd, and the logger. Mirror of the host's `EventHandlerContext`.
 */
export interface EventHandlerContext<TPayload = unknown> {
  payload: TPayload
  cwd: string
  log: PluginLogger
}

/** An event handler. Mirror of the host's `EventHandler`. */
export type EventHandler<TPayload = unknown> = (
  ctx: EventHandlerContext<TPayload>,
) => void | Promise<void>

/**
 * The slice of `HookHandlerContext` the key handler reads: just the agent
 * cwd. Mirror of the host's `HookHandlerContext`.
 */
export interface HookHandlerContext {
  cwd: string
}
