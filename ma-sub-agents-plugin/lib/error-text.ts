/**
 * Text of a worker's `error` event.
 *
 * Core sends an EMPTY `message` for a CoreError and carries
 * `error: {kind, fields}`. This plugin imports no host types, so it reads the shape and
 * writes the text itself. The text is never "" and never "error".
 *
 * @module sub-agents/lib/error-text
 */

/** The typed facts of a core `error` event. */
export interface ErrorFacts {
  readonly kind: string
  readonly fields: Readonly<Record<string, unknown>>
}

function optText(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined
}

/** Read `{kind, fields}` from an unknown `error` field. Undefined when it is not one. */
export function readErrorFacts(v: unknown): ErrorFacts | undefined {
  if (v === null || typeof v !== "object") return undefined
  const o = v as { kind?: unknown; fields?: unknown }
  if (typeof o.kind !== "string" || o.kind === "") return undefined
  const fields =
    typeof o.fields === "object" && o.fields !== null && !Array.isArray(o.fields)
      ? (o.fields as Record<string, unknown>)
      : {}
  return { kind: o.kind, fields }
}

/**
 * Text of the facts of a failed approval hook (`failure: {label?, detail}`):
 * `approval hook "<label>" failed (<detail>)`. Undefined when there are no facts.
 */
export function approvalFailureText(failure: unknown): string | undefined {
  if (failure === null || typeof failure !== "object" || Array.isArray(failure)) return undefined
  const label = optText((failure as { label?: unknown }).label)
  const detail = optText((failure as { detail?: unknown }).detail)
  let text = label !== undefined ? `approval hook "${label}" failed` : "approval hook failed"
  if (detail !== undefined) text += ` (${detail})`
  return text
}

/**
 * Text of a `LifecycleDeniedError` from its fields:
 * `<hook> hook denied[: <reason>][ (approval hook "<label>" failed (<detail>))]`.
 */
export function lifecycleDeniedText(f: Readonly<Record<string, unknown>>): string {
  let text = `${optText(f.hook) ?? "lifecycle"} hook denied`
  const reason = optText(f.reason)
  if (reason !== undefined) text += `: ${reason}`
  const failure = approvalFailureText(f.failure)
  if (failure !== undefined) text += ` (${failure})`
  return text
}

/**
 * Text of an `error` event: a non-empty `message` wins. Else a
 * `LifecycleDeniedError` gets its deny text, and any other kind gives the
 * kind name. With neither, "error".
 */
export function errorEventText(message: unknown, error: ErrorFacts | undefined): string {
  if (typeof message === "string" && message !== "") return message
  if (error === undefined) return "error"
  if (error.kind === "LifecycleDeniedError") return lifecycleDeniedText(error.fields)
  return error.kind
}
