/**
 * Binary-body detection + model-facing message for Fetch.
 *
 * Plugins cannot import core `src/tools/binary-guard.ts` at runtime, so this
 * is a local, dependency-free copy of the magic-byte sniff + message shape.
 * The wire tag (`<ma::agent::binary-result …/>`) is kept identical so core's
 * defense-in-depth guard recognizes plugin-emitted annotations and does not
 * double-wrap.
 *
 * @module lib/binary
 */

import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { agentHome } from "./paths.ts"

/** Max raw bytes we base64-inline when the model set `binary: true`. */
export const MAX_INLINE_BINARY_BYTES = 48 * 1024

const SAMPLE_BYTES = 8_192
const CONTROL_RATIO_THRESHOLD = 0.02
const MIN_RATIO_SAMPLE = 64

/**
 * Best-effort mime from magic bytes. Mirrors core `media/probe.ts:sniffMime`
 * for the formats we care about (images + PDF); everything else is
 * `application/octet-stream`.
 */
export function sniffMime(b: Uint8Array): string {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg"
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  ) {
    return "image/png"
  }
  if (ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a")) return "image/gif"
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) return "image/webp"
  if (ascii(b, 0, "%PDF-")) return "application/pdf"
  if (
    b.length >= 4 &&
    b[0] === 0x50 &&
    b[1] === 0x4b &&
    (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)
  ) {
    return "application/zip"
  }
  return "application/octet-stream"
}

function ascii(b: Uint8Array, start: number, str: string): boolean {
  if (start + str.length > b.length) return false
  for (let i = 0; i < str.length; i++) {
    if (b[start + i] !== str.charCodeAt(i)) return false
  }
  return true
}

/**
 * Classify raw response bytes as binary or text.
 *
 * Known image/PDF magic → binary. Otherwise NUL / high C0-control density
 * in the head sample → binary. Clean UTF-8 text → not binary.
 */
export function classifyBinaryBytes(bytes: Uint8Array): { binary: boolean; mime: string } {
  if (bytes.length === 0) return { binary: false, mime: "text/plain" }

  const mime = sniffMime(bytes)
  if (mime !== "application/octet-stream") {
    return { binary: true, mime }
  }

  const sample = bytes.subarray(0, Math.min(bytes.length, SAMPLE_BYTES))
  let controls = 0
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i]!
    if (b === 0) return { binary: true, mime: "application/octet-stream" }
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) controls++
  }
  if (sample.length >= MIN_RATIO_SAMPLE && controls / sample.length >= CONTROL_RATIO_THRESHOLD) {
    return { binary: true, mime: "application/octet-stream" }
  }
  return { binary: false, mime: "text/plain" }
}

/** Compact byte formatter matching the Fetch footer style. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function shortSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16)
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
}

/**
 * Persist binary body next to the session blobs dir when we know the
 * session id, else under `~/.minimal-agent/sessions/fetch-bin/`. Returns
 * absolute path + short sha256.
 */
export function persistBinaryBody(opts: {
  bytes: Uint8Array
  toolUseId?: string
  sessionId?: string
  env?: NodeJS.ProcessEnv
}): { path: string; sha256: string } {
  const env = opts.env ?? process.env
  const home = agentHome(env)
  const sid = opts.sessionId?.trim()
  const id = (opts.toolUseId?.trim() || `fetch-${Date.now().toString(36)}`).replace(
    /[^a-zA-Z0-9._-]/g,
    "_",
  )
  const dir = sid ? join(home, "sessions", `${sid}.blobs`) : join(home, "sessions", "fetch-bin")
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${id}.bin`)
  writeFileSync(path, opts.bytes)
  return { path, sha256: shortSha256(opts.bytes) }
}

/**
 * Model-facing replacement when binary is withheld (default).
 * Tag shape matches core `formatBinaryResultMessage`.
 */
export function formatBinaryWithheld(opts: {
  mime: string
  sizeBytes: number
  path?: string
  sha256?: string
}): string {
  const attrs = [
    `mime="${escapeAttr(opts.mime)}"`,
    `size="${escapeAttr(formatBytes(opts.sizeBytes))}"`,
  ]
  if (opts.path) attrs.push(`path="${escapeAttr(opts.path)}"`)
  if (opts.sha256) attrs.push(`sha256="${escapeAttr(opts.sha256)}"`)
  attrs.push(`tool="Fetch"`)
  const tag = `<ma::agent::binary-result ${attrs.join(" ")} />`
  const prose = `Binary body withheld from model context (not valid text; dumping it wastes tokens).${
    opts.path ? " Full bytes saved at the path above." : ""
  } Re-call with binary=true for base64 when small enough, Read the saved path, or ask the user to attach the file.`
  return `${tag}\n\n${prose}`
}

/**
 * Model-facing body when `binary: true`. Base64 under the size cap;
 * otherwise same withhold message with `optedInButWithheld` prose.
 */
export function formatBinaryOptedIn(opts: {
  bytes: Uint8Array
  mime: string
  path?: string
  sha256?: string
}): string {
  if (opts.bytes.length > MAX_INLINE_BINARY_BYTES) {
    const attrs = [
      `mime="${escapeAttr(opts.mime)}"`,
      `size="${escapeAttr(formatBytes(opts.bytes.length))}"`,
    ]
    if (opts.path) attrs.push(`path="${escapeAttr(opts.path)}"`)
    if (opts.sha256) attrs.push(`sha256="${escapeAttr(opts.sha256)}"`)
    attrs.push(`tool="Fetch"`)
    return (
      `<ma::agent::binary-result ${attrs.join(" ")} />\n\n` +
      "Binary body is too large to inline as base64 under the tool-output budget. " +
      "Use the path above (Read it, or ask the user to attach the file to their message)."
    )
  }
  const b64 = Buffer.from(opts.bytes).toString("base64")
  const attrs = [
    `mime="${escapeAttr(opts.mime)}"`,
    `size="${escapeAttr(formatBytes(opts.bytes.length))}"`,
    `encoding="base64"`,
  ]
  if (opts.path) attrs.push(`path="${escapeAttr(opts.path)}"`)
  if (opts.sha256) attrs.push(`sha256="${escapeAttr(opts.sha256)}"`)
  attrs.push(`tool="Fetch"`)
  return `<ma::agent::binary-result ${attrs.join(" ")}>\n${b64}\n</ma::agent::binary-result>`
}
