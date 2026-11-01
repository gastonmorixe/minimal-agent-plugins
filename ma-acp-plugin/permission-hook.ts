/**
 * `tool.willInvoke` chain hook for the ACP approval gate. The manifest
 * marks it `failClosed`, so core denies the call if this handler throws.
 *
 * With no active gate (approval off, or not in ACP host mode) it passes
 * through, and the tool runs.
 *
 * When it loads, it calls `setHookRegistered(true)`. The host mode reads
 * that flag at `session/new` to know that the gate can work.
 *
 * @module permission-hook
 */

import type { ToolWillInvokePayload } from "@minimal-agent/core/sdk/lifecycle"

import { activeGate, type GateResult, setHookRegistered } from "./permission.ts"

// Tell the host mode that core loaded this hook. If this module fails to
// load, or the manifest has no grant for the channel, core skips the hook
// and this line never runs.
setHookRegistered(true)

function isPayload(x: unknown): x is ToolWillInvokePayload {
  if (typeof x !== "object" || x === null) return false
  const p = x as Record<string, unknown>
  return typeof p.tool === "string" && typeof p.toolUseId === "string"
}

/** Manifest `hooks[]` default export. */
export default async function toolWillInvoke(payload: unknown): Promise<GateResult> {
  const gate = activeGate()
  if (!gate) return undefined
  if (!isPayload(payload)) {
    return {
      halt: true,
      reason: "Tool call denied by the ACP approval gate: malformed hook payload.",
    }
  }
  return gate.check(payload)
}
