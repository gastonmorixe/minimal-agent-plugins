/**
 * `message.willSend` hook. Skeleton: pass-through. Never halts.
 *
 * @module src/hooks/redact_send
 */

import type { ChainResult, SendSnapshot } from "../host-types.ts"

/** Redact send (stub). Returns undefined (pass-through). */
export default function redactSend(_payload: SendSnapshot): ChainResult<SendSnapshot> {
  try {
    return undefined
  } catch {
    return undefined
  }
}
