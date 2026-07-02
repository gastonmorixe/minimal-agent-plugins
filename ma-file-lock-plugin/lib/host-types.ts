/**
 * LOCAL structural re-declaration of the host plugin-contract slice this
 * plugin consumes. An external plugin may NOT import host code
 * (`@minimal-agent/plugin-api` or core `src/...`), not even type-only — it
 * must be able to live in its own repository. TypeScript types are structural
 * and erased at runtime, so the real host objects the loader passes satisfy
 * these while we type-check + unit-test standalone.
 *
 * Source of truth in the host: `plugin-api/src/types/plugin.ts` (`TUIContext`,
 * `TUITrigger`, `TUIResult`). Keep this narrow to the fields the handler and
 * its tests use, and update it if the host contract changes.
 *
 * @module lib/host-types
 */

/**
 * Plugin-scoped diagnostic logger. Structural + permissive: the handler never
 * calls it, but the host (and the unit test) pass a full syslog-style logger,
 * so any object of no-op methods satisfies this.
 */
export type PluginLogger = Record<string, (...args: unknown[]) => void>

/**
 * What triggered a TUI handler. Mirror of the host's `TUITrigger` union: the
 * `tool` arm (which this handler runs under) carries the tool name, parsed
 * input, and wire id.
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
 * The slice of `TUIContext` this plugin reads (trigger, cwd) plus the fields
 * its unit test constructs so the mirror stays assignable from a full host
 * context literal. Mirror of the host's `TUIContext`.
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
}

/**
 * The `tool_result` result this handler returns. Mirror of that arm of the
 * host's `TUIResult` union.
 */
export interface TUIResult {
  kind: "tool_result"
  content: string
  is_error?: boolean
  display?: string
}
