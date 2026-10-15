/**
 * `turn.willStart` hook. Skeleton: pass-through. Never halts.
 *
 * @module src/hooks/turn_start
 */

import type { ChainResult, TurnWillStartPayload } from "../host-types.ts"

/** Notice turn start (stub). Returns undefined (pass-through). */
export default function turnStart(
  _payload: TurnWillStartPayload,
): ChainResult<TurnWillStartPayload> {
  try {
    return undefined
  } catch {
    return undefined
  }
}
