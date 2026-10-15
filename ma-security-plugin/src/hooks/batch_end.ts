/**
 * `tool.didBatch` hook. Skeleton: pass-through. Later halts on CAT escalation only.
 *
 * @module src/hooks/batch_end
 */

import type { ChainResult, ToolDidBatchPayload } from "../host-types.ts"

/** Batch end (stub). Returns undefined (pass-through). */
export default function batchEnd(_payload: ToolDidBatchPayload): ChainResult<ToolDidBatchPayload> {
  try {
    return undefined
  } catch {
    return undefined
  }
}
