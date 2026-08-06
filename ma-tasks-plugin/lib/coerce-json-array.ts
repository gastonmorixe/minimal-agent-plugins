/**
 * Coerce stringified JSON arrays that tool-calling models (Cursor/Grok/…)
 * often emit for nested fields like `items` / `titles` / `order` / `children`.
 *
 * Providers parse the top-level `arguments` object once. If the model nests a
 * JSON-encoded array *inside* a string field, it stays a string. Without
 * coercion, strict `Array.isArray` rejects a payload that is otherwise valid.
 *
 * @module tasks/lib/coerce-json-array
 */

export type CoerceArrayResult =
  | { ok: true; value: unknown[]; coerced: boolean }
  | { ok: false; error: string }

/**
 * If `raw` is already an array, return it.
 * If `raw` is a string that `JSON.parse`s to an array, return that array and
 * mark `coerced: true`.
 * Otherwise return a model-facing error that names the field.
 */
export function coerceJsonArray(raw: unknown, field: string): CoerceArrayResult {
  if (Array.isArray(raw)) {
    return { ok: true, value: raw, coerced: false }
  }
  if (typeof raw !== "string") {
    return {
      ok: false,
      error: `\`${field}\` must be a non-empty array (got ${typeLabel(raw)})`,
    }
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return {
      ok: false,
      error: `\`${field}\` was an empty string; pass a JSON array, ` + `not a stringified array`,
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return {
      ok: false,
      error:
        `\`${field}\` was a string; pass a JSON array, not a stringified array ` +
        `(JSON.parse failed)`,
    }
  }
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      error:
        `\`${field}\` was a JSON string but parsed to ${typeLabel(parsed)}; ` +
        `pass a JSON array, not a stringified non-array`,
    }
  }
  return { ok: true, value: parsed, coerced: true }
}

function typeLabel(v: unknown): string {
  if (v === null) return "null"
  if (Array.isArray(v)) return "array"
  return typeof v
}
