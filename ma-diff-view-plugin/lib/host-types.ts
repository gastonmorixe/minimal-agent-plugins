/**
 * Local type stubs mirroring minimal-agent's plugin contract.
 *
 * Source of truth: plugin-api/src/types/plugin.ts. Minimal slice — only
 * fields this plugin uses.
 *
 * External plugins live outside the agent's source tree, so they can't import
 * `@minimal-agent/plugin-api` or core `src/` at runtime. TypeScript types are
 * structural and erased at runtime, so a local minimal-slice mirror lets this
 * plugin type-check standalone while staying byte-compatible with the host.
 *
 * @module lib/host-types
 */

/**
 * What triggered a handler. Minimal slice: this plugin reads the `tool`
 * variant (`input`) and the `inline_tag` variant (`attrs`, `body`).
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
 * only `trigger`.
 */
export interface TUIContext {
  /** What triggered this handler. */
  trigger: TUITrigger
}

/**
 * Handler result. Minimal slice: this plugin returns the `tool_result` variant
 * (content, is_error, display) and the `rendered` variant (ansi).
 */
export type TUIResult =
  | {
      kind: "tool_result"
      content: string
      is_error?: boolean
      display?: string
    }
  | { kind: "rendered"; ansi: string }
