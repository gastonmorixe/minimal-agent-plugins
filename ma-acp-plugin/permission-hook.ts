/**
 * `tool.willInvoke` chain hook for the ACP approval gate. The manifest
 * marks it `failClosed`, so core denies the call if this handler throws.
 *
 * With no active gate (approval off, or not in ACP host mode) it passes
 * through, and the tool runs.
 *
 * @module permission-hook
 */

import type { ToolWillInvokePayload } from "@minimal-agent/core/sdk/lifecycle"

import { activeGate, type GateResult } from "./permission.ts"

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
