/**
 * Shared helpers for the prompt tool handlers.
 *
 * @module handlers/shared
 */

import { loadPromptsConfig } from "../lib/config.ts"
import type { TUIContext, TUIResult } from "../lib/host-types.ts"
import { defaultDeps, type StoreDeps } from "../lib/store.ts"

/** Resolve store deps from a tool context + user config. */
export function depsFor(ctx: TUIContext): StoreDeps {
  const config = loadPromptsConfig()
  return defaultDeps(ctx.env, ctx.cwd, config.projectScope, {
    maxBodyBytes: config.maxBodyBytes,
    maxPrompts: config.maxPrompts,
  })
}

/** Build a tool error result. */
export function errResult(tool: string, message: string): TUIResult {
  return {
    kind: "tool_result",
    content: `${tool}: ${message}`,
    is_error: true,
    displayHeader: "error",
    display: message,
  }
}

/** Clip a string to n chars with an ellipsis. */
export function clip(s: string, n: number): string {
  if (s.length <= n) return s
  return `${s.slice(0, n - 1)}…`
}
