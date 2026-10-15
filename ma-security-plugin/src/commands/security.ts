/**
 * `/security` command. Skeleton: shows the same report as SecurityStatus.
 *
 * @module src/commands/security
 */

import type { CommandContext, CommandResult } from "../host-types.ts"
import { reportText } from "../status.ts"

/** /security handler. Sync. Never throws. */
export default function securityCommand(_ctx: CommandContext): CommandResult {
  try {
    return { kind: "notice", lines: [reportText()] }
  } catch {
    return { kind: "error", message: "security: internal error" }
  }
}
