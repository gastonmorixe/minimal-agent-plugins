/**
 * Local type stubs mirroring minimal-agent's plugin contract.
 *
 * Source of truth: plugin-api/src/types/plugin.ts (and host-capabilities.ts
 * for the blobs:read slice). Minimal slice — only fields this plugin uses.
 *
 * External plugins live outside the agent's source tree, so they can't import
 * `@minimal-agent/plugin-api` or core `src/` at runtime. TypeScript types are
 * structural and erased at runtime, so a local minimal-slice mirror lets this
 * plugin type-check standalone while staying byte-compatible with the host.
 *
 * @module lib/host-types
 */

/** Boot-time agent identity. This plugin reads `sessionId`. */
export interface AgentContext {
  readonly sessionId: string
  readonly pid: number
  readonly model: string
  readonly version: string
}

/**
 * `blobs:read` slice — spilled tool-output access for a session. This plugin
 * calls `read(sid, toolUseId, {maxBytes})` and reads `text`, `bytes`, `clipped`.
 */
export interface BlobsReadApi {
  read(
    sid: string,
    toolUseId: string,
    opts?: { maxBytes?: number },
  ): Promise<{ text: string; bytes: number; clipped: boolean; path: string } | null>
}

/**
 * Capability host slice — this plugin declares `blobs:read` and narrows on
 * `ctx.host?.blobs` at runtime.
 */
export interface PluginHost {
  readonly capabilities: readonly string[]
  readonly blobs?: BlobsReadApi
}

/**
 * Minimal plugin logger slice (the test supplies a stub; the handler does not
 * call it directly, but the context literal carries it).
 */
export interface PluginLogger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  debug(...args: unknown[]): void
}

/**
 * What triggered a handler. This plugin reads the `inline_tag` variant
 * (`attrs`); the `tool` variant is mirrored for completeness of the union.
 */
export type TUITrigger =
  | {
      type: "tool"
      name: string
      input: Record<string, unknown>
      tool_use_id: string
    }
  | {
      type: "inline_tag"
      name: string
      attrs: Record<string, string>
      body: string
      self_closing: boolean
    }

/**
 * Runtime context passed to a module handler. Minimal slice: this plugin reads
 * `trigger`, `cwd`, `agent`, and `host`. The remaining fields are carried
 * because the handler's own test constructs the full context literal.
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
  host?: PluginHost
}

/**
 * Handler result. Minimal slice: this plugin returns only the `rendered`
 * variant (ansi).
 */
export type TUIResult = { kind: "rendered"; ansi: string }
