/**
 * Engine view of the minimal-agent channels that config hooks can use.
 *
 * Shapes come from core `src/plugins/hooks/channels.ts` (chain:
 * turn.willStart:68, compact.willRun:124, tool.willInvoke:172,
 * tool.didInvoke:189, tool.didBatch:199, subagent.willSpawn:461; broadcast:
 * agent.willStop:44, compact.didRun:132, cwd.didChange:141,
 * instructions.didLoad:150, notification.emit:442). `turn.willStop` and
 * `session.willStart` are the new chain seams in SPEC.md "New general core
 * seams" (core `src/plugins/hooks/channels.ts:81`, `:92`). The manifest
 * registers both.
 *
 * @module engine/channels
 */

/** How the engine treats one channel. */
export interface ChannelInfo {
  /** A deny can halt the chain (it blocks). */
  blocking: boolean
  /** Exit-0 plain stdout becomes context (else it goes to the debug log). */
  plainTextContext: boolean
  /** Async hooks' queued output is injected here. */
  injectsQueued: boolean
  /** Total time budget for all hooks on the channel (ms). */
  budgetMs?: number
}

/** Session-end hooks share a 1.5 s total budget (SPEC.md "Engine execution"). */
export const SESSION_END_BUDGET_MS = 1500

/** Every channel config hooks can name. */
export const HOOK_CHANNELS: Readonly<Record<string, ChannelInfo>> = {
  "turn.willStart": { blocking: true, plainTextContext: true, injectsQueued: true },
  "session.willStart": { blocking: false, plainTextContext: true, injectsQueued: false },
  "turn.willStop": { blocking: true, plainTextContext: false, injectsQueued: false },
  "tool.willInvoke": { blocking: true, plainTextContext: false, injectsQueued: false },
  "tool.didInvoke": { blocking: false, plainTextContext: false, injectsQueued: false },
  "tool.didBatch": { blocking: true, plainTextContext: false, injectsQueued: false },
  "compact.willRun": { blocking: true, plainTextContext: false, injectsQueued: false },
  "compact.didRun": { blocking: false, plainTextContext: false, injectsQueued: false },
  "subagent.willSpawn": { blocking: true, plainTextContext: false, injectsQueued: false },
  "agent.willStop": {
    blocking: false,
    plainTextContext: false,
    injectsQueued: false,
    budgetMs: SESSION_END_BUDGET_MS,
  },
  "cwd.didChange": { blocking: false, plainTextContext: false, injectsQueued: false },
  "instructions.didLoad": { blocking: false, plainTextContext: false, injectsQueued: false },
  "notification.emit": { blocking: false, plainTextContext: false, injectsQueued: false },
}

/**
 * Payload keys a hook may rewrite, per channel (review B3 MAJOR 2). This is
 * the one allow-list for native `payload` patches and Claude `updatedInput`.
 * `tool.willInvoke` takes `input` (core `src/plugins/hooks/channels.ts:172`).
 * `turn.willStart` takes `text`, the model-facing prompt (core
 * `src/plugins/hooks/channels.ts:61-62`). The plugin registers no
 * message-like channel (see manifest.json `permissions`), so none is listed.
 * Every other channel is context only: a patch is ignored.
 */
export const REWRITABLE_KEYS: Readonly<Record<string, readonly string[]>> = {
  "tool.willInvoke": ["input"],
  "turn.willStart": ["text"],
}

/** The payload keys a hook may rewrite on this channel (`[]` = none). */
export function rewritableKeys(channel: string): readonly string[] {
  return Object.hasOwn(REWRITABLE_KEYS, channel) ? (REWRITABLE_KEYS[channel] ?? []) : []
}

/** Channel info, or a non-blocking default for an unknown name. */
export function channelInfo(channel: string): ChannelInfo {
  return (
    HOOK_CHANNELS[channel] ?? { blocking: false, plainTextContext: false, injectsQueued: false }
  )
}

/** True when the engine knows this channel. */
export function isHookChannel(channel: string): boolean {
  return Object.hasOwn(HOOK_CHANNELS, channel)
}
