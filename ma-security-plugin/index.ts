/**
 * ma-security-plugin entry. The host loader binds one module per manifest
 * entry (only `export: "default"` is supported), so each handler lives in its
 * own file. This module is the single table of every handler, keyed by
 * manifest id, for tests and for future in-process wiring.
 *
 * @module index
 */

import securityCommand from "./src/commands/security.ts"
import batchEnd from "./src/hooks/batch_end.ts"
import guardInvoke from "./src/hooks/guard_invoke.ts"
import redactSend from "./src/hooks/redact_send.ts"
import turnStart from "./src/hooks/turn_start.ts"
import securityStatus from "./src/tools/security_status.ts"

/** Hook handlers keyed by channel. */
export const hooks = {
  "message.willSend": redactSend,
  "tool.willInvoke": guardInvoke,
  "turn.willStart": turnStart,
  "tool.didBatch": batchEnd,
} as const

/** Tool handlers keyed by tool name. */
export const tools = { SecurityStatus: securityStatus } as const

/** Command handlers keyed by command name. */
export const commands = { security: securityCommand } as const
