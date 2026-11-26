/**
 * JSON-Schema to Gemini/OpenAPI-subset sanitizer.
 *
 * The Cloud Code Assist backend takes a restricted OpenAPI subset for tool
 * parameters. `agy` sends upper-case `type` values and never sends
 * `additionalProperties`, `$schema`, or a `oneOf`/`anyOf` at the parameter
 * root. This module downgrades a general JSON Schema to that subset instead
 * of failing: a dropped keyword costs precision, a rejected request costs the
 * whole turn.
 *
 * @module llm/providers/antigravity/schema-sanitize
 */

/** Keywords the backend accepts. Everything else is dropped. */
const KEPT_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "format",
  "description",
  "title",
  "properties",
  "items",
  "required",
  "enum",
  "nullable",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "default",
  "example",
  "anyOf",
])

/** Map of a lower-case JSON Schema type to the upper-case wire value. */
const TYPE_MAP: Readonly<Record<string, string>> = {
  object: "OBJECT",
  array: "ARRAY",
  string: "STRING",
  number: "NUMBER",
  integer: "INTEGER",
  boolean: "BOOLEAN",
  null: "NULL",
}

/**
 * Upper-case one `type` value and split a nullable type array.
 *
 * `["string","null"]` becomes `type:"STRING", nullable:true`. A list of two
 * real types cannot be expressed, so the first one wins.
 */
function normalizeType(value: unknown): { type?: string; nullable?: boolean } {
  if (typeof value === "string") {
    const mapped = TYPE_MAP[value.toLowerCase()]
    return mapped ? { type: mapped } : {}
  }
  if (Array.isArray(value)) {
    const names = value.filter((v): v is string => typeof v === "string")
    const nullable = names.some((v) => v.toLowerCase() === "null")
    const real = names.find((v) => v.toLowerCase() !== "null")
    const mapped = real ? TYPE_MAP[real.toLowerCase()] : undefined
    const out: { type?: string; nullable?: boolean } = {}
    if (mapped) out.type = mapped
    if (nullable) out.nullable = true
    return out
  }
  return {}
}

/** Sanitize each value of a `properties` object. */
function sanitizeProperties(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const out: Record<string, unknown> = {}
  for (const [name, sub] of Object.entries(value as Record<string, unknown>)) {
    out[name] = sanitizeGeminiSchema(sub)
  }
  return out
}

/**
 * Drop `required` entries that name no declared property.
 *
 * The backend rejects a request whose `required` names an unknown property.
 * An empty list is dropped too, because the subset has no use for it.
 */
function sanitizeRequired(
  value: unknown,
  properties: Record<string, unknown> | undefined,
): unknown {
  if (!Array.isArray(value) || !properties) return undefined
  const kept = value.filter((v): v is string => typeof v === "string" && v in properties)
  return kept.length > 0 ? kept : undefined
}

/**
 * Sanitize one JSON Schema node into the backend subset.
 *
 * Keeps the documented keywords, upper-cases `type`, turns a nullable type
 * array into `nullable:true`, and recurses into `properties`, `items` and
 * `anyOf`. A non-object input returns an empty object schema.
 *
 * @param schema - JSON Schema fragment of a tool parameter or a whole input.
 * @returns A new object. The input is never changed.
 */
export function sanitizeGeminiSchema(schema: unknown): Record<string, unknown> {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return {}
  const src = schema as Record<string, unknown>
  const out: Record<string, unknown> = {}

  // `properties` goes first: `required` is filtered against it.
  const properties = sanitizeProperties(src.properties)
  if (properties) out.properties = properties

  for (const [key, value] of Object.entries(src)) {
    if (!KEPT_KEYWORDS.has(key) || key === "properties") continue
    if (value === undefined) continue
    if (key === "type") {
      const { type, nullable } = normalizeType(value)
      if (type) out.type = type
      if (nullable) out.nullable = true
      continue
    }
    if (key === "required") {
      const kept = sanitizeRequired(value, properties)
      if (kept) out.required = kept
      continue
    }
    if (key === "items") {
      out.items = sanitizeGeminiSchema(value)
      continue
    }
    if (key === "anyOf") {
      if (!Array.isArray(value)) continue
      const branches = value.map((v) => sanitizeGeminiSchema(v))
      if (branches.length > 0) out.anyOf = branches
      continue
    }
    out[key] = value
  }

  // An object schema with no type still needs one: the backend validates it.
  if (out.properties && !out.type) out.type = "OBJECT"
  return out
}
