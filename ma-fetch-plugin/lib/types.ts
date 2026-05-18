/**
 * Local type stubs mirroring minimal-agent's plugin contract.
 *
 * Why local copies?
 *   External plugins don't sit inside the agent's source tree, so the
 *   `../../../src/plugins/types.ts` import that embedded plugins use
 *   isn't available. TypeScript types are structural and erased at
 *   runtime - keeping a local mirror lets us type-check this plugin
 *   standalone (bun test, editor IntelliSense) while staying byte-
 *   compatible with the agent's actual contract.
 *
 * If the agent's contract changes, update this file. The fields we
 * actually use are intentionally narrow: see `TUIContext` (just
 * `trigger`, `cwd`, `packageDir`, `env`, `abort`, `stderr`) and
 * `TUIResult` (the `tool_result` variant only).
 */

export interface ToolTrigger {
  type: "tool"
  /** The tool name as declared in the manifest (`Fetch`). */
  name: string
  /** Raw input the model produced. Validate before use. */
  input: Record<string, unknown>
}

export interface TUIContext {
  trigger: ToolTrigger | { type: "inline_tag"; [k: string]: unknown }
  /** Absolute path to the plugin's own directory. */
  packageDir: string
  /** The agent's current working directory. */
  cwd: string
  /** Environment dict. Loader injects `TUI_PLUGIN_PROTOCOL=1` and friends. */
  env: Record<string, string>
  /** Cancelled when the user aborts the turn or a timeout fires. */
  abort: AbortSignal
  stdout: NodeJS.WriteStream
  stdin: NodeJS.ReadStream
  stderr: NodeJS.WriteStream
}

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
