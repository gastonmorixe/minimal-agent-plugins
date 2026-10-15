/**
 * SecurityStatus tool. Skeleton: returns the minimal status report.
 *
 * @module src/tools/security_status
 */

import type { TUIContext, TUIResult } from "../host-types.ts"
import { reportText } from "../status.ts"

/** SecurityStatus handler. Sync. Never throws. */
export default function securityStatus(_ctx: TUIContext): TUIResult {
  try {
    const text = reportText()
    return { kind: "tool_result", content: text, display: text }
  } catch {
    return { kind: "tool_result", content: "SecurityStatus: internal error", is_error: true }
  }
}
