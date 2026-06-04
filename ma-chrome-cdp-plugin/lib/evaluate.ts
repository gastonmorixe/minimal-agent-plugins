/**
 * Shape `Runtime.evaluate` replies into a friendly value-or-error.
 *
 * CDP returns either `result.result.value` (when `returnByValue:true`) or
 * `result.exceptionDetails` on a thrown error. We normalize a thrown error to
 * `{ __error: "<description>" }` so callers (and the model) get a JSON-safe
 * object instead of a rejected promise. Pure + tested.
 *
 * @module lib/evaluate
 */

export const EVALUATE_PARAMS = {
  returnByValue: true,
  awaitPromise: true,
  userGesture: true,
} as const

export interface EvalErrorShape {
  __error: string
}

interface RuntimeEvalReply {
  result?: {
    result?: { value?: unknown }
    exceptionDetails?: {
      exception?: { description?: string }
      text?: string
    }
  }
}

/** True if `v` is the normalized eval-error shape. */
export function isEvalError(v: unknown): v is EvalErrorShape {
  return typeof v === "object" && v !== null && "__error" in v
}

/**
 * Extract the value from a `Runtime.evaluate` reply, or an `{__error}` object
 * when the page threw. Never throws.
 */
export function extractEvalResult(reply: RuntimeEvalReply): unknown {
  const ex = reply.result?.exceptionDetails
  if (ex) {
    const desc = ex.exception?.description ?? ex.text ?? "evaluation error"
    return { __error: desc } satisfies EvalErrorShape
  }
  return reply.result?.result?.value
}
