/**
 * Reconstruct `x-cursor-checksum` from Cursor IDE (workbench.desktop.main.js).
 *
 * Algorithm (Ilf / Alf) — report 09 / spike:
 * 1. `ts = floor(Date.now() / 1e6)` as 6-byte big-endian
 * 2. scramble: `t=165`; for i in bytes: `b[i] = ((b[i]^t) + i%256) & 255`; `t=b[i]`
 * 3. base64(scramble)
 * 4. header = `${b64}${machineId}` or `${b64}${machineId}/${macMachineId}`
 *
 * Pure + unit-testable. No network.
 *
 * Ownership note: Phase 2.0 port by Jack for Exit 2.0; Christina may adopt for
 * auth/header fidelity work.
 *
 * @module llm/providers/cursor/checksum
 */

/** Scramble the 6 timestamp bytes in place (returns a new buffer). */
export function scrambleTimestampBytes(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes)
  let t = 165
  for (let n = 0; n < out.length; n++) {
    out[n] = ((out[n]! ^ t) + (n % 256)) & 255
    t = out[n]!
  }
  return out
}

/** Encode `floor(nowMs / 1e6)` as 6 big-endian bytes (JS shift semantics). */
export function timestampBytes(nowMs = Date.now()): Uint8Array {
  const E = Math.floor(nowMs / 1e6)
  return new Uint8Array([
    (E >> 40) & 255,
    (E >> 32) & 255,
    (E >> 24) & 255,
    (E >> 16) & 255,
    (E >> 8) & 255,
    E & 255,
  ])
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64")
}

/**
 * Build the `x-cursor-checksum` header value.
 *
 * @param machineId - telemetry machine id (typically 64 hex chars)
 * @param macMachineId - optional mac machine id; when present, appended after `/`
 * @param nowMs - injectable clock for tests
 */
export function buildCursorChecksum(
  machineId: string,
  macMachineId?: string,
  nowMs = Date.now(),
): string {
  const scrambled = scrambleTimestampBytes(timestampBytes(nowMs))
  const prefix = b64(scrambled)
  if (macMachineId && macMachineId.length > 0) {
    return `${prefix}${machineId}/${macMachineId}`
  }
  return `${prefix}${machineId}`
}
