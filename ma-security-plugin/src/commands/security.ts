/** Read-only /security report and /security rules list. */
import type { CommandContext, CommandResult } from "../host-types.ts"
import { buildSecurityStatus, type SecurityStatusInputProvider } from "../status.ts"

/** Sync handler. Runtime wiring supplies an optional snapshot provider. */
export default function securityCommand(
  ctx: CommandContext,
  inputProvider: SecurityStatusInputProvider = () => ({}),
): CommandResult {
  try {
    const report = buildSecurityStatus(inputProvider())
    if (ctx.argv?.trim() === "rules") {
      return {
        kind: "notice",
        lines: report.json.rules.map((rule) => `${rule.id}: ${rule.status}`),
      }
    }
    return { kind: "notice", lines: [report.text] }
  } catch {
    return { kind: "error", message: "security: internal error" }
  }
}
