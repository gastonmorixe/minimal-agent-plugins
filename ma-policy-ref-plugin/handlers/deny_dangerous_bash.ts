/**
 * `tool.willInvoke` — deny Bash commands that look like `rm -rf /`.
 *
 * @module handlers/deny_dangerous_bash
 */

export interface ToolWillInvokePayload {
  tool: string
  toolUseId: string
  input: Record<string, unknown>
  cwd: string
}

/** Match rm -rf aimed at filesystem root (common exfil/fixture pattern). */
export function isDangerousRmRf(command: string): boolean {
  const c = command.trim()
  return /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|--force\s+)*\/\s*$/.test(c) || /\brm\s+-rf\s+\/\b/.test(c)
}

/** HookBus `tool.willInvoke` handler (default export for the manifest). */
export default function denyDangerousBash(
  payload: ToolWillInvokePayload,
): ToolWillInvokePayload | { halt: true; reason: string; payload: ToolWillInvokePayload } {
  if (payload.tool !== "Bash") return payload
  const command = typeof payload.input.command === "string" ? payload.input.command : ""
  if (!isDangerousRmRf(command)) return payload
  return {
    halt: true,
    reason: "Bash command blocked by policy-ref: refusing rm -rf targeting /.",
    payload,
  }
}
