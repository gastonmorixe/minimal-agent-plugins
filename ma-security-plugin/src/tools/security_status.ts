/** SecurityStatus tool. Runtime data must be supplied by its caller. */
import type { TUIContext, TUIResult } from "../host-types.ts"
import { buildSecurityStatus, type SecurityStatusInputProvider } from "../status.ts"

/** Sync handler. No provider state or host reads. */
export default function securityStatus(
  _ctx: TUIContext,
  inputProvider: SecurityStatusInputProvider = () => ({}),
): TUIResult {
  try {
    const report = buildSecurityStatus(inputProvider())
    return { kind: "tool_result", content: JSON.stringify(report.json), display: report.text }
  } catch {
    return { kind: "tool_result", content: "SecurityStatus: internal error", is_error: true }
  }
}
