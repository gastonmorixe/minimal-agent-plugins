/**
 * Local type stubs mirroring minimal-agent's plugin contract.
 *
 * External plugins live outside the agent's source tree, so the in-tree
 * plugin types import that embedded plugins use isn't available. TS types are
 * structural and erased at runtime, so a local mirror lets this plugin
 * type-check standalone (bun test, editor IntelliSense) while staying
 * byte-compatible with the agent's real contract. Mirrors the same stub the
 * ma-chrome-cdp-plugin / ma-fetch-plugin keep.
 *
 * @module lib/types
 */

export interface ToolTrigger {
  type: "tool"
  name: string
  input: Record<string, unknown>
}

export interface TUIContext {
  trigger: ToolTrigger | { type: "inline_tag"; [k: string]: unknown }
  packageDir: string
  cwd: string
  env: Record<string, string>
  abort: AbortSignal
  stdout: NodeJS.WriteStream
  stdin: NodeJS.ReadStream
  stderr: NodeJS.WriteStream
}

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
