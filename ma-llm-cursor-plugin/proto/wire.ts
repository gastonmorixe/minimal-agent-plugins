/**
 * Minimal protobuf wire helpers for Cursor Connect RPCs (encode + decode).
 * Scalar T codes used: 8=bool, 9=string, 5=int32, 0/varint enums.
 *
 * Ported from the Phase 1 spike. Pure + unit-testable. No network.
 *
 * @module llm/providers/cursor/proto/wire
 */

/** Concatenate byte arrays into one buffer. */
export function concat(...parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0)
  const out = new Uint8Array(n)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** Encode an unsigned protobuf varint. */
export function encVarint(n: number | bigint): Uint8Array {
  const bytes: number[] = []
  if (typeof n === "bigint") {
    let b = n
    if (b < 0n) b = BigInt.asUintN(64, b)
    while (b >= 0x80n) {
      bytes.push(Number(b & 0x7fn) | 0x80)
      b >>= 7n
    }
    bytes.push(Number(b))
    return new Uint8Array(bytes)
  }

  if (n > 0xffffffff) {
    let b = BigInt(n)
    while (b >= 0x80n) {
      bytes.push(Number(b & 0x7fn) | 0x80)
      b >>= 7n
    }
    bytes.push(Number(b))
    return new Uint8Array(bytes)
  }

  if (n < 0) {
    let b = BigInt.asUintN(64, BigInt(n))
    while (b >= 0x80n) {
      bytes.push(Number(b & 0x7fn) | 0x80)
      b >>= 7n
    }
    bytes.push(Number(b))
    return new Uint8Array(bytes)
  }

  let u = n >>> 0
  while (u > 0x7f) {
    bytes.push((u & 0x7f) | 0x80)
    u >>>= 7
  }
  bytes.push(u)
  return new Uint8Array(bytes)
}

/** Encode a protobuf field key (field number + wire type). */
export function encKey(fieldNo: number, wire: 0 | 1 | 2 | 5): Uint8Array {
  return encVarint((fieldNo << 3) | wire)
}

/** Encode a length-delimited UTF-8 string field. */
export function encString(fieldNo: number, s: string): Uint8Array {
  const b = new TextEncoder().encode(s)
  return concat(encKey(fieldNo, 2), encVarint(b.length), b)
}

/** Encode a length-delimited bytes field. */
export function encBytes(fieldNo: number, b: Uint8Array): Uint8Array {
  return concat(encKey(fieldNo, 2), encVarint(b.length), b)
}

/** Encode a bool field; proto3 default false is omitted. */
export function encBool(fieldNo: number, v: boolean): Uint8Array {
  if (!v) return new Uint8Array(0)
  return concat(encKey(fieldNo, 0), encVarint(1))
}

/** Encode bool even when false (for optional fields we want present). */
export function encBoolExplicit(fieldNo: number, v: boolean): Uint8Array {
  return concat(encKey(fieldNo, 0), encVarint(v ? 1 : 0))
}

/** Encode a non-zero varint field; zero is omitted (proto3 default). */
export function encVarintField(fieldNo: number, v: number): Uint8Array {
  if (v === 0) return new Uint8Array(0)
  return concat(encKey(fieldNo, 0), encVarint(v))
}

/** Encode an enum as a non-zero varint field. */
export function encEnum(fieldNo: number, v: number): Uint8Array {
  return encVarintField(fieldNo, v)
}

/** Encode a nested message as a length-delimited field. */
export function encMsg(fieldNo: number, body: Uint8Array): Uint8Array {
  return concat(encKey(fieldNo, 2), encVarint(body.length), body)
}

/** Encode repeated string fields (packed as separate length-delimited entries). */
export function encRepeatedString(fieldNo: number, values: string[]): Uint8Array {
  return concat(...values.map((s) => encString(fieldNo, s)))
}

// --- decode ---

/** One decoded protobuf field. */
export type ProtoField = {
  no: number
  wire: number
  value: Uint8Array | number | bigint
}

/** Decode a varint starting at offset; returns value and next offset. */
export function decVarint(buf: Uint8Array, offset: number): { value: number; next: number } {
  let result = 0
  let shift = 0
  let pos = offset
  while (pos < buf.length) {
    const b = buf[pos]!
    pos++
    result |= (b & 0x7f) << shift
    if ((b & 0x80) === 0) break
    shift += 7
    if (shift > 35) break
  }
  return { value: result >>> 0, next: pos }
}

/** Decode all top-level fields from a protobuf message buffer. */
export function decodeFields(buf: Uint8Array): ProtoField[] {
  const out: ProtoField[] = []
  let i = 0
  while (i < buf.length) {
    const { value: key, next } = decVarint(buf, i)
    i = next
    const no = key >>> 3
    const wire = key & 7
    if (wire === 0) {
      const v = decVarint(buf, i)
      out.push({ no, wire, value: v.value })
      i = v.next
    } else if (wire === 2) {
      const len = decVarint(buf, i)
      i = len.next
      const slice = buf.subarray(i, i + len.value)
      out.push({ no, wire, value: slice })
      i += len.value
    } else if (wire === 5) {
      const slice = buf.subarray(i, i + 4)
      out.push({ no, wire, value: slice })
      i += 4
    } else if (wire === 1) {
      const slice = buf.subarray(i, i + 8)
      out.push({ no, wire, value: slice })
      i += 8
    } else {
      break
    }
  }
  return out
}

/** Bytes payload of a length-delimited field, or null. */
export function fieldBytes(f: ProtoField): Uint8Array | null {
  return f.wire === 2 && f.value instanceof Uint8Array ? f.value : null
}

/** UTF-8 string payload of a length-delimited field, or null. */
export function fieldString(f: ProtoField): string | null {
  const b = fieldBytes(f)
  return b ? new TextDecoder().decode(b) : null
}

/** Varint payload of a wire-0 field, or null. */
export function fieldVarint(f: ProtoField): number | null {
  return f.wire === 0 && typeof f.value === "number" ? f.value : null
}

/** All fields with the given field number. */
export function getFields(buf: Uint8Array, no: number): ProtoField[] {
  return decodeFields(buf).filter((f) => f.no === no)
}

/** First string value for field number, if any. */
export function getFirstString(buf: Uint8Array, no: number): string | undefined {
  for (const f of getFields(buf, no)) {
    const s = fieldString(f)
    if (s != null) return s
  }
  return undefined
}

/** First varint value for field number, if any. */
export function getFirstVarint(buf: Uint8Array, no: number): number | undefined {
  for (const f of getFields(buf, no)) {
    const v = fieldVarint(f)
    if (v != null) return v
  }
  return undefined
}

/** First nested message bytes for field number, if any. */
export function getFirstMsg(buf: Uint8Array, no: number): Uint8Array | undefined {
  for (const f of getFields(buf, no)) {
    const b = fieldBytes(f)
    if (b) return b
  }
  return undefined
}

/** All nested message payloads for a repeated message field. */
export function getRepeatedMsg(buf: Uint8Array, no: number): Uint8Array[] {
  const out: Uint8Array[] = []
  for (const f of getFields(buf, no)) {
    const b = fieldBytes(f)
    if (b) out.push(b)
  }
  return out
}

/** All string values for a repeated string field. */
export function getRepeatedString(buf: Uint8Array, no: number): string[] {
  const out: string[] = []
  for (const f of getFields(buf, no)) {
    const s = fieldString(f)
    if (s != null) out.push(s)
  }
  return out
}

/** Bool for field number (varint ≠ 0), or undefined if absent. */
export function getBool(buf: Uint8Array, no: number): boolean | undefined {
  const v = getFirstVarint(buf, no)
  if (v === undefined) return undefined
  return v !== 0
}
