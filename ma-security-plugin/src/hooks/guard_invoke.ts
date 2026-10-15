/**
 * `tool.willInvoke` hook. Skeleton: allow every call.
 *
 * @module src/hooks/guard_invoke
 */

import type { ChainResult, ToolWillInvokePayload } from "../host-types.ts"

/** Guard invoke (stub). Returns undefined: pass-through, allow. */
export default function guardInvoke(
  _payload: ToolWillInvokePayload,
): ChainResult<ToolWillInvokePayload> {
  try {
    return undefined
  } catch {
    return undefined
  }
}
