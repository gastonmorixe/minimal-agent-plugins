/**
 * Strict function tools for the OpenAI Responses API.
 *
 * With no `strict` key, the Responses API normalizes a tool schema into strict
 * mode by itself: it marks each property as required, and it keeps the
 * property type as it is. The model must then send each optional property, and
 * with no null in the type it sends a filler such as `""` for a value it does
 * not want. Example: `Task {"action":"list","id":""}` failed with "`id` must
 * be a non-empty string" (research 2026-11-17-session-173b7fd8-tool-input-loss).
 *
 * This module does the strict conversion itself, the way OpenAI documents it:
 * each property is required, and each property that was optional gets `null`
 * as an allowed type. The model then sends `null` for an unused optional
 * property. {@link dropOptionalNulls} removes those nulls from the call input
 * before the tool sees it, so the tool gets the same input shape as before.
 *
 * A schema that cannot be converted safely is sent unchanged, with no
 * `strict` key: the server keeps its own normalization for that tool.
 *
 * @module llm/providers/openai/responses/strict-tools
 */

/** A JSON object. */
type Json = Record<string, unknown>

/**
 * Keywords that strict mode accepts in a schema. Anything else makes the
 * schema "not convertible" (sent unchanged). Source: OpenAI Structured Outputs,
 * "Supported schemas".
 */
const SUPPORTED_KEYWORDS = new Set([
  "type",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
])
// Not converted on purpose (the tool is sent unchanged): `anyOf` (the null
// drop cannot know which branch a value took) and `const` (null cannot be
// added to it). A schema with either keeps the server's own normalization.

/**
 * Keywords that strict mode does not accept but that carry no constraint.
 * They are removed, not refused. `default` is documentation for the model (the
 * tool applies its own default when the property is absent). `$schema` names
 * the dialect only. `title` and `examples` are text.
 */
const DROPPED_KEYWORDS = new Set(["$schema", "default", "title", "examples"])

/** The JSON Schema types. */
const TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"])

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Thrown inside the converter when a schema cannot be made strict. */
class NotConvertible extends Error {}

/**
 * Add `null` to the allowed values of `schema`, a property that was optional.
 * `null` then means "not given", and {@link dropOptionalNulls} removes it. So
 * the original type must not allow null already: there, null can be a real
 * value that the tool reads differently from "not given".
 */
function withNull(types: readonly string[], out: Json): Json {
  if (types.includes("null")) throw new NotConvertible("optional property already allows null")
  out.type = types.length === 1 ? [types[0], "null"] : [...types, "null"]
  // An enum lists the allowed values: null must be one of them too.
  if (Array.isArray(out.enum)) out.enum = [...out.enum, null]
  return out
}

/**
 * Convert one schema node. `optional` is true for a property that was not
 * required. Each case that cannot be converted EXACTLY throws: a property with
 * no `type` (it takes any value, also null, an object or an array), an array
 * with no `items`, an object that allows other keys, a `required` name that is
 * not a property.
 */
function convertNode(schema: unknown, optional: boolean): Json {
  if (!isObject(schema)) throw new NotConvertible("schema is not an object")
  const out: Json = {}
  for (const [key, value] of Object.entries(schema)) {
    if (DROPPED_KEYWORDS.has(key)) continue
    if (!SUPPORTED_KEYWORDS.has(key)) throw new NotConvertible(`keyword ${key}`)
    out[key] = value
  }
  const type = out.type
  const types = typeof type === "string" ? [type] : Array.isArray(type) ? type : undefined
  if (types === undefined || types.length === 0) throw new NotConvertible("no type")
  if (!types.every((t) => typeof t === "string" && TYPES.has(t))) {
    throw new NotConvertible("unknown type")
  }
  if (types.includes("object")) {
    const props = out.properties
    if (!isObject(props)) throw new NotConvertible("object with no properties")
    // A missing `additionalProperties` allows other keys (JSON Schema), so it
    // is "open" too. Only an explicit `false` converts without a change.
    if (out.additionalProperties !== false) {
      throw new NotConvertible("object allows additional properties")
    }
    const requiredList = out.required === undefined ? [] : out.required
    if (!Array.isArray(requiredList)) throw new NotConvertible("required is not a list")
    if (!requiredList.every((name) => typeof name === "string" && Object.hasOwn(props, name))) {
      throw new NotConvertible("required name is not a property")
    }
    const required = new Set<unknown>(requiredList)
    const converted: Json = {}
    for (const [name, prop] of Object.entries(props)) {
      converted[name] = convertNode(prop, !required.has(name))
    }
    out.properties = converted
    out.required = Object.keys(converted)
    out.additionalProperties = false
  }
  if (types.includes("array")) {
    // Strict mode needs `items` on each array ("array schema must define
    // items", from the API). With no `items` the array takes any value.
    if (out.items === undefined) throw new NotConvertible("array with no items")
    out.items = convertNode(out.items, false)
  }
  return optional ? withNull(types as string[], out) : out
}

/**
 * The strict form of a function tool's `parameters`, or `undefined` when the
 * schema cannot be converted safely (then send it unchanged, with no `strict`).
 */
export function toStrictParameters(schema: unknown): Json | undefined {
  if (!isObject(schema) || schema.type !== "object") return undefined
  try {
    return convertNode(schema, false)
  } catch (error) {
    if (error instanceof NotConvertible) return undefined
    throw error
  }
}

/**
 * Remove, at each depth, each property of `input` whose value is `null` and
 * that was optional in `schema` (the tool's ORIGINAL `parameters`). The model
 * sends `null` for an unused optional property of a strict tool, and the
 * converter adds null to optional properties at each depth. A null in a
 * required property stays: the original schema did not allow the property
 * to be absent, so the tool reports it. Returns a new value; `input` is not
 * changed.
 */
export function dropOptionalNulls(input: unknown, schema: unknown): unknown {
  if (Array.isArray(input)) {
    const items = isObject(schema) ? schema.items : undefined
    return items === undefined ? input : input.map((v) => dropOptionalNulls(v, items))
  }
  if (!isObject(input) || !isObject(schema) || !isObject(schema.properties)) return input
  const props = schema.properties
  const required = new Set(Array.isArray(schema.required) ? (schema.required as unknown[]) : [])
  const out: Json = {}
  for (const [key, value] of Object.entries(input)) {
    if (value === null && Object.hasOwn(props, key) && !required.has(key)) continue
    out[key] = Object.hasOwn(props, key) ? dropOptionalNulls(value, props[key]) : value
  }
  return out
}

/**
 * Original `parameters` of each tool that {@link toStrictParameters} made
 * strict, by tool name. The stream translator uses it to drop the nulls of
 * unused optional properties ({@link dropOptionalNulls}).
 */
export function strictToolSchemas(
  tools: readonly { name: string; inputSchema?: unknown; strict?: boolean; server?: unknown }[],
): ReadonlyMap<string, unknown> {
  const out = new Map<string, unknown>()
  for (const tool of tools) {
    if (tool.server || tool.strict === false) continue
    if (toStrictParameters(tool.inputSchema) !== undefined) out.set(tool.name, tool.inputSchema)
  }
  return out
}
