/**
 * Minimal google.protobuf.Value / map decode for MCP tool args.
 *
 * @module llm/providers/cursor/proto/value-decode
 */

import { decodeFields, fieldBytes, fieldString } from "./wire.ts"

/**
 * Decode one map\<string, Value\> entry (key=field 1, value=field 2).
 * Each protobuf map entry is a message with these two fields.
 */
export function decodeMapEntry(entryBody: Uint8Array): { key: string; value: unknown } | undefined {
  let key: string | undefined
  let value: unknown
  for (const ef of decodeFields(entryBody)) {
    if (ef.no === 1) key = fieldString(ef) ?? undefined
    if (ef.no === 2 && ef.wire === 2) {
      const vb = fieldBytes(ef)
      if (vb) value = decodeProtobufValue(vb)
    }
  }
  if (key === undefined) return undefined
  return { key, value }
}

/** Decode a protobuf string-to-Value map field body to a plain object. */
export function decodeStringValueMap(body: Uint8Array): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of decodeFields(body)) {
    if (f.wire !== 2) continue
    const entry = fieldBytes(f)
    if (!entry) continue
    const parsed = decodeMapEntry(entry)
    if (parsed) out[parsed.key] = parsed.value
  }
  return out
}

/**
 * Decode one google.protobuf.Value message.
 *
 * google.protobuf.Value oneof kind:
 *   field 1: null_value   (enum NullValue, wire 0)
 *   field 2: number_value (double, wire 1 — fixed 64-bit)
 *   field 3: string_value (string, wire 2)
 *   field 4: bool_value   (bool, wire 0)
 *   field 5: struct_value (Struct message, wire 2)
 *   field 6: list_value   (ListValue message, wire 2)
 */
export function decodeProtobufValue(body: Uint8Array): unknown {
  for (const f of decodeFields(body)) {
    switch (f.no) {
      case 1: // null_value
        return null
      case 2: // number_value (double — wire type 1, 8 bytes)
        if (f.wire === 1 && f.value instanceof Uint8Array && f.value.length === 8) {
          return new DataView(f.value.buffer, f.value.byteOffset, 8).getFloat64(0, true)
        }
        return Number(f.value ?? 0)
      case 3: // string_value
        return fieldString(f) ?? ""
      case 4: // bool_value
        return f.value === 1 || f.value === 1n
      case 5: {
        // struct_value
        const sb = fieldBytes(f)
        return sb ? decodeStringValueMap(sb) : {}
      }
      case 6: {
        // list_value (ListValue has field 1 = repeated Value)
        const lb = fieldBytes(f)
        if (!lb) return []
        const items: unknown[] = []
        for (const lf of decodeFields(lb)) {
          if (lf.wire === 2) {
            const vb = fieldBytes(lf)
            if (vb) items.push(decodeProtobufValue(vb))
          }
        }
        return items
      }
      default:
        break
    }
  }
  return null
}
