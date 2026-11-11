/**
 * L3 feature `structuredOutput` (`docs/acp-extensions.md` section 5.e):
 * parse the final assistant text as JSON, check it against the request
 * schema, and decide whether to retry.
 *
 * The plugin has zero runtime dependencies (`package.json`), and neither
 * the plugin nor core ships a JSON Schema validator. So this file has a
 * small validator for a common subset. Limits:
 *
 * - Keywords checked: `type` (a name or an array of names: `object`,
 *   `array`, `string`, `number`, `integer`, `boolean`, `null`),
 *   `properties`, `required`, `items` (one schema for every item), `enum`,
 *   `const`, and `additionalProperties: false`.
 * - Every other keyword (`$ref`, `anyOf`, `oneOf`, `allOf`, `pattern`,
 *   `minimum`, `minLength`, `format`, tuple `items`, ...) is IGNORED. A value
 *   that breaks only an ignored keyword passes.
 * - A boolean schema: `true` accepts all, `false` rejects all.
 *
 * Text parsing: trim, then strip one surrounding Markdown code fence (three
 * backticks, with an optional language tag such as json), then `JSON.parse`.
 *
 * Pure. No I/O. Never throws.
 *
 * @module structured-output
 */

/** Default number of retries after the first run (contract 5.e). */
export const STRUCTURED_OUTPUT_MAX_RETRIES = 2

type Json = unknown

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** The JSON type name of a value, `integer` for whole numbers. */
function typeName(v: Json): string {
  if (v === null) return "null"
  if (Array.isArray(v)) return "array"
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number"
  return typeof v
}

function typeMatches(v: Json, want: string): boolean {
  const got = typeName(v)
  if (want === "number") return got === "number" || got === "integer"
  return got === want
}

/**
 * Max nesting depth that `validateJson` and `jsonEqual` walk. Schema and
 * value both come from the client, so without a cap a deep pair can
 * overflow the stack. Deeper input is a validation error, not a throw.
 */
export const MAX_SCHEMA_DEPTH = 64

/**
 * Deep equality for JSON values (for `enum` and `const`). Deeper than
 * {@link MAX_SCHEMA_DEPTH}: not equal.
 */
function jsonEqual(a: Json, b: Json, depth = 0): boolean {
  if (a === b) return true
  if (depth >= MAX_SCHEMA_DEPTH) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => jsonEqual(x, b[i], depth + 1))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    return (
      ka.length === kb.length &&
      ka.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k], depth + 1))
    )
  }
  return false
}

/**
 * Check `value` against `schema` (the subset above). Returns the first
 * error as one line with a JSON path (`$.a[0]`), or `undefined` when valid.
 */
export function validateJson(value: Json, schema: unknown, path = "$"): string | undefined {
  return validateAt(value, schema, path, 0)
}

function validateAt(value: Json, schema: unknown, path: string, depth: number): string | undefined {
  if (schema === true || schema === undefined) return undefined
  if (depth > MAX_SCHEMA_DEPTH) {
    return `${path}: nesting is deeper than ${MAX_SCHEMA_DEPTH} levels`
  }
  if (schema === false) return `${path}: no value is allowed here`
  if (!isPlainObject(schema)) return undefined
  const { type } = schema
  if (typeof type === "string" || Array.isArray(type)) {
    const wants = (Array.isArray(type) ? type : [type]).filter(
      (t): t is string => typeof t === "string",
    )
    if (wants.length > 0 && !wants.some((t) => typeMatches(value, t))) {
      return `${path}: expected ${wants.join(" or ")}, got ${typeName(value)}`
    }
  }
  if (Object.hasOwn(schema, "const") && !jsonEqual(value, schema.const)) {
    return `${path}: must be ${JSON.stringify(schema.const)}`
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => jsonEqual(value, e))) {
    return `${path}: must be one of ${JSON.stringify(schema.enum)}`
  }
  if (isPlainObject(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !Object.hasOwn(value, key)) {
          return `${path}: missing required property "${key}"`
        }
      }
    }
    const props = isPlainObject(schema.properties) ? schema.properties : {}
    for (const [key, sub] of Object.entries(props)) {
      if (!Object.hasOwn(value, key)) continue
      const err = validateAt(value[key], sub, `${path}.${key}`, depth + 1)
      if (err) return err
    }
    if (schema.additionalProperties === false) {
      const extra = Object.keys(value).find((k) => !Object.hasOwn(props, k))
      if (extra !== undefined) return `${path}: property "${extra}" is not allowed`
    }
  }
  if (Array.isArray(value) && isPlainObject(schema.items)) {
    for (let i = 0; i < value.length; i++) {
      const err = validateAt(value[i], schema.items, `${path}[${i}]`, depth + 1)
      if (err) return err
    }
  }
  return undefined
}

/** The outcome of one check. */
export type StructuredCheck =
  | { readonly ok: true; readonly value: Json }
  | { readonly ok: false; readonly message: string }

/** Strip one surrounding Markdown code fence, if present. */
function stripFence(text: string): string {
  const m = /^```[A-Za-z0-9_-]*\s*\n([\s\S]*?)\n?```$/.exec(text)
  return m ? (m[1] ?? "") : text
}

/** Parse `text` as JSON and check it against `schema`. */
export function checkStructuredOutput(text: string, schema: object): StructuredCheck {
  const body = stripFence(text.trim()).trim()
  if (body === "") return { ok: false, message: "the reply is empty, expected JSON" }
  let value: Json
  try {
    value = JSON.parse(body)
  } catch (e) {
    return {
      ok: false,
      message: `the reply is not valid JSON (${e instanceof Error ? e.message : String(e)})`,
    }
  }
  let err: string | undefined
  try {
    err = validateJson(value, schema)
  } catch (e) {
    err = `the schema check failed (${e instanceof Error ? e.message : String(e)})`
  }
  return err
    ? { ok: false, message: `the reply does not match the schema: ${err}` }
    : { ok: true, value }
}

/** The user message for a retry. Short, and it has the validation error. */
export function correctivePrompt(message: string): string {
  return `Your previous reply was rejected: ${message}. Reply again with only one JSON value that matches the required JSON Schema. No other text, no code fence.`
}

/** What to do after one run of a structured turn. */
export type StructuredStep =
  | { readonly kind: "retry"; readonly prompt: string }
  | { readonly kind: "done"; readonly meta: Record<string, unknown> }

/** `_meta` keys of the reply (contract 5.e). */
export const OUTPUT_META_KEY = "minimal-agent/output"
export const OUTPUT_ERROR_META_KEY = "minimal-agent/outputError"

/**
 * Decide the next step. Valid: done with `{output}`. Invalid and
 * `retriesUsed < maxRetries` and the run `completed`: retry. Else done with
 * `{outputError: {message}}`.
 */
export function decideStructuredStep(input: {
  readonly check: StructuredCheck
  readonly retriesUsed: number
  readonly maxRetries?: number
  readonly outcome: string
}): StructuredStep {
  const { check, retriesUsed, outcome } = input
  const maxRetries = input.maxRetries ?? STRUCTURED_OUTPUT_MAX_RETRIES
  if (check.ok) return { kind: "done", meta: { [OUTPUT_META_KEY]: check.value } }
  if (outcome === "completed" && retriesUsed < maxRetries) {
    return { kind: "retry", prompt: correctivePrompt(check.message) }
  }
  const tries = retriesUsed + 1
  return {
    kind: "done",
    meta: {
      [OUTPUT_ERROR_META_KEY]: {
        message: `${check.message} (after ${tries} ${tries === 1 ? "attempt" : "attempts"})`,
      },
    },
  }
}
