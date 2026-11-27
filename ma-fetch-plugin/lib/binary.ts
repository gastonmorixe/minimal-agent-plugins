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

import type { SidebandApi } from "@minimal-agent/core/plugin-api/types/sideband"

import { agentHome } from "./paths.ts"

/** The slice of the session sideband API that renders the `binary-result` tag. */
export type BinarySideband = Pick<SidebandApi, "render">

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

/** The image types that core can give to the model as an image block. */
const ATTACHABLE_IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
])

/** True when Fetch returns the body as a core attachment, not as a saved `.bin`. */
export function isAttachableImage(mime: string): boolean {
  return ATTACHABLE_IMAGE_MIMES.has(mime)
}

/**
 * Model-facing text for an image body that Fetch gives as an attachment.
 * Core adds the image block (or the gate text) and the saved path after it.
 */
export function formatImageAttached(opts: {
  url: string
  mime: string
  sizeBytes: number
}): string {
  return `Fetch got an image from ${opts.url} (${opts.mime}, ${formatBytes(opts.sizeBytes)}). The harness gives the image or its saved path below.`
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

/** The attrs of a `binary-result` tag. Attr order is the wire order. */
function binaryAttrs(opts: {
  mime: string
  sizeBytes: number
  base64?: boolean
  path?: string
  sha256?: string
}): Record<string, string> {
  return {
    mime: opts.mime,
    size: formatBytes(opts.sizeBytes),
    ...(opts.base64 ? { encoding: "base64" } : {}),
    ...(opts.path ? { path: opts.path } : {}),
    ...(opts.sha256 ? { sha256: opts.sha256 } : {}),
    tool: "Fetch",
  }
}

/** The tag, then the prose after one empty line. With no tag (no codec), the prose only. */
function tagThenProse(tag: string, prose: string): string {
  return tag === "" ? prose : `${tag}\n\n${prose}`
}

/**
 * Model-facing replacement when binary is withheld (default).
 * Tag shape matches core `formatBinaryResultMessage`. The codec of `sb`
 * writes the tag (kind `binary-result`).
 */
export function formatBinaryWithheld(
  opts: {
    mime: string
    sizeBytes: number
    path?: string
    sha256?: string
  },
  sb: BinarySideband | undefined,
): string {
  const tag = sb?.render("binary-result", { attrs: binaryAttrs(opts) }) ?? ""
  const prose = `The harness did not put the binary body in the model context. The body is not valid text, and it uses tokens for no purpose.${
    opts.path ? " The harness saved the full bytes at the path above." : ""
  } Do one of these: call the tool again with binary=true to get base64 if the body is small enough, Read the saved path, or ask the user to attach the file.`
  return tagThenProse(tag, prose)
}

/**
 * Model-facing body when `binary: true`. Base64 under the size cap;
 * otherwise same withhold message with `optedInButWithheld` prose.
 * With no codec the base64 form is `""` (the whole form is the tag).
 */
export function formatBinaryOptedIn(
  opts: {
    bytes: Uint8Array
    mime: string
    path?: string
    sha256?: string
  },
  sb: BinarySideband | undefined,
): string {
  const base = {
    mime: opts.mime,
    sizeBytes: opts.bytes.length,
    path: opts.path,
    sha256: opts.sha256,
  }
  if (opts.bytes.length > MAX_INLINE_BINARY_BYTES) {
    const tag = sb?.render("binary-result", { attrs: binaryAttrs(base) }) ?? ""
    return tagThenProse(
      tag,
      "The binary body is too large to include as base64 in the tool output budget. " +
        "Use the path above. Read that path, or ask the user to attach the file to their message.",
    )
  }
  const b64 = Buffer.from(opts.bytes).toString("base64")
  return (
    sb?.render("binary-result", { attrs: binaryAttrs({ ...base, base64: true }), body: b64 }) ?? ""
  )
}
