/** Bounded validation of advertised Cursor MCP argument schemas. */
export function isArgumentObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Supported keywords: type, required, properties, additionalProperties, items,
 * enum, minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf.
 * Unknown keywords remain host validation responsibilities.
 */
export function validateMcpArguments(
  schema: unknown,
  value: unknown,
  path = "arguments",
  depth = 0,
): string | undefined {
  if (depth > 32) return `${path}: schema nesting limit exceeded`
  if (!isArgumentObject(schema)) return undefined
  const types = Array.isArray(schema.type) ? schema.type : [schema.type]
  if (
    schema.type !== undefined &&
    !types.some((type) => {
      switch (type) {
        case "object":
          return isArgumentObject(value)
        case "array":
          return Array.isArray(value)
        case "string":
          return typeof value === "string"
        case "boolean":
          return typeof value === "boolean"
        case "null":
          return value === null
        case "number":
          return typeof value === "number" && Number.isFinite(value)
        case "integer":
          return typeof value === "number" && Number.isSafeInteger(value)
        default:
          return true
      }
    })
  )
    return `${path}: invalid type`
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))
  )
    return `${path}: invalid enum value`
  if (typeof value === "number") {
    for (const key of [
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "multipleOf",
    ] as const) {
      const bound = schema[key]
      if (typeof bound !== "number") continue
      const invalid =
        key === "minimum"
          ? value < bound
          : key === "maximum"
            ? value > bound
            : key === "exclusiveMinimum"
              ? value <= bound
              : key === "exclusiveMaximum"
                ? value >= bound
                : bound > 0 && Math.abs(value / bound - Math.round(value / bound)) > 1e-9
      if (invalid) return `${path}: violates ${key}`
    }
  }
  if (isArgumentObject(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required)
        if (typeof key === "string" && !Object.hasOwn(value, key)) return `${path}.${key}: required`
    }
    const properties = isArgumentObject(schema.properties) ? schema.properties : {}
    for (const [key, item] of Object.entries(value)) {
      const declared = Object.hasOwn(properties, key)
      if (!declared && schema.additionalProperties === false)
        return `${path}.${key}: unexpected property`
      const error = validateMcpArguments(
        declared ? properties[key] : schema.additionalProperties,
        item,
        `${path}.${key}`,
        depth + 1,
      )
      if (error) return error
    }
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    for (const [index, item] of value.entries()) {
      const error = validateMcpArguments(schema.items, item, `${path}[${index}]`, depth + 1)
      if (error) return error
    }
  }
  return undefined
}

/** Validate explicit built-in path aliases on a copy. Core owns normalization. */
export function argumentsForValidation(
  name: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (!["Read", "Edit", "Write"].includes(name) || !Object.hasOwn(input, "path")) return input
  const copy = { ...input }
  if (!Object.hasOwn(copy, "file_path")) copy.file_path = copy.path
  delete copy.path
  return copy
}
