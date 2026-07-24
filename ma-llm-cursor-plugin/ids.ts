/**
 * Machine / client ids for checksum + Cursor request headers.
 *
 * Auth policy (Gaston): never keychain, never bare CURSOR_* token envs.
 * Credentials only via MA provider auth store. This module is fingerprint only.
 *
 * Optional non-secret overrides use MA_CURSOR_* only.
 *
 * @module llm/providers/cursor/ids
 */

import { homedir } from "node:os"
import { join } from "node:path"

/** Client fingerprint bag attached to every Connect call. */
export type ClientIds = {
  machineId: string
  macMachineId?: string
  clientKey: string
  sessionId: string
  configVersion?: string
}

/** Hex-encode a byte array. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/** SHA-256 hex of a UTF-8 string (WebCrypto). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return toHex(new Uint8Array(digest))
}

/**
 * Build a {@link ClientIds} bag from known parts (no FS).
 * `clientKey` defaults to SHA-256(machineId) when omitted (64 hex, matches live).
 */
export async function buildClientIds(parts: {
  machineId: string
  macMachineId?: string
  clientKey?: string
  sessionId?: string
  configVersion?: string
}): Promise<ClientIds> {
  const clientKey = parts.clientKey ?? (await sha256Hex(parts.machineId))
  return {
    machineId: parts.machineId,
    macMachineId: parts.macMachineId,
    clientKey,
    sessionId: parts.sessionId ?? crypto.randomUUID(),
    configVersion: parts.configVersion ?? process.env.MA_CURSOR_CONFIG_VERSION,
  }
}

/**
 * Load machine ids for checksum fingerprint.
 *
 * Prefer MA_CURSOR_* env overrides. Optional Cursor IDE telemetry files are
 * fingerprint-only (not auth). Never reads macOS Keychain or access tokens.
 */
export async function loadClientIds(): Promise<ClientIds> {
  let machineId = process.env.MA_CURSOR_MACHINE_ID?.trim() ?? ""
  let macMachineId = process.env.MA_CURSOR_MAC_MACHINE_ID?.trim() || undefined

  if (!machineId) {
    const storagePath = join(
      homedir(),
      "Library/Application Support/Cursor/User/globalStorage/storage.json",
    )
    try {
      const j = JSON.parse(await Bun.file(storagePath).text()) as Record<string, string>
      machineId = j["telemetry.machineId"] ?? ""
      macMachineId = macMachineId ?? (j["telemetry.macMachineId"] || undefined)
    } catch {
      // optional — Cursor may not be installed
    }
  }

  if (!machineId) {
    try {
      machineId = (
        await Bun.file(join(homedir(), "Library/Application Support/Cursor/machineid")).text()
      ).trim()
    } catch {
      machineId =
        crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 32)
    }
  }

  const clientKey = process.env.MA_CURSOR_CLIENT_KEY ?? (await sha256Hex(machineId))

  return buildClientIds({
    machineId,
    macMachineId,
    clientKey,
    configVersion: process.env.MA_CURSOR_CONFIG_VERSION,
  })
}
