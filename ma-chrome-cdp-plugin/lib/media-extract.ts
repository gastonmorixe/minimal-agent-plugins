/**
 * Take base64 media (screenshots, PDFs, screencast frames, image data URIs)
 * out of a daemon response, so the model gets the bytes as a tool attachment
 * and not as base64 text. Pure and tested.
 *
 * Rules:
 * 1. Known fields: `send` of `Page.captureScreenshot` (`result.data`, the MIME
 *    type from `params.format`, png by default), `send` of `Page.printToPDF`
 *    (`result.data`, a PDF), and each `Page.screencastFrame` event of
 *    `events` (`params.data`, jpeg by default).
 * 2. Generic: any other string longer than {@link MIN_GENERIC_CHARS} that is
 *    plain base64, or a `data:<mime>;base64,` URI, and whose first bytes are
 *    a full png, jpeg, gif, webp or pdf header ({@link sniffHeader}).
 * 3. Each taken string becomes a short placeholder.
 * 4. At most {@link MAX_ATTACHMENTS} per response. The newest (the last in
 *    walk order) stay. An older one gets a "dropped" placeholder.
 *
 * The input is never changed: the function gives a copy of the body.
 *
 * @module lib/media-extract
 */

/** The maximum number of attachments of one response. */
export const MAX_ATTACHMENTS = 8

/** A generic (not known) string must be longer than this to be checked. */
export const MIN_GENERIC_CHARS = 1024

/** One attachment that the handler gives to core (`ToolAttachment`). */
export interface MediaAttachment {
  /** The decoded bytes. */
  bytes: Uint8Array
  /** The MIME type from the magic bytes, else from the known field. */
  mimeType: string
  /** Where the bytes came from, for example `result.data`. */
  label: string
}

/** The request that made the response. */
export interface ExtractContext {
  /** The tool action (route), for example `send` or `events`. */
  action: string
  /** For `send`: the CDP method. */
  method?: string
  /** For `send`: the CDP params. */
  params?: unknown
}

/** What {@link extractMedia} gives. */
export interface ExtractResult {
  /** A copy of the body with placeholders in place of the media strings. */
  body: unknown
  /** The attachments, in body order. Empty when the body has no media. */
  attachments: MediaAttachment[]
}

/** One known field: the holder object of the input, the key, and the fallback MIME type. */
interface KnownSlot {
  key: string
  mime: string
  frame: boolean
}

/** One string found in the walk, before the cap. */
interface Candidate {
  holder: Record<string, unknown> | unknown[]
  key: string | number
  base64: string
  mime: string
  label: string
  frame: boolean
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
const DATA_URI = /^data:([\w.+-]+\/[\w.+-]+)(?:;[\w.+-]+=[^;,]*)*;base64,/i

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** True for a plain base64 string (no whitespace, correct length). */
export function isBase64(s: string): boolean {
  return s.length > 0 && s.length % 4 === 0 && BASE64.test(s)
}

/** The MIME type from the magic of the first bytes, or null. */
export function sniffMagic(b: Uint8Array): string | null {
  const at = (i: number, bytes: number[]) => bytes.every((x, j) => b[i + j] === x)
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (at(0, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (at(0, [0x47, 0x49, 0x46, 0x38]) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) {
    return "image/gif"
  }
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp"
  if (at(0, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"
  return null
}

/**
 * The MIME type from a full file header, or null. Stricter than
 * {@link sniffMagic}: the generic path uses it, because a bad image block
 * can stay in history and make later API requests fail.
 *
 * - PNG: the 8 byte signature, then the `IHDR` chunk type at byte 12.
 * - JPEG: `FF D8 FF`, then a marker byte in `E0`..`EF`, `DB` or `C0`..`C3`.
 * - GIF: `GIF87a` or `GIF89a`. WebP: `RIFF....WEBP`. PDF: `%PDF-`.
 */
export function sniffHeader(b: Uint8Array): string | null {
  const mime = sniffMagic(b)
  if (mime === "image/png") {
    return b[12] === 0x49 && b[13] === 0x48 && b[14] === 0x44 && b[15] === 0x52 ? mime : null
  }
  if (mime === "image/jpeg") {
    const m = b[3] ?? 0
    return (m >= 0xe0 && m <= 0xef) || m === 0xdb || (m >= 0xc0 && m <= 0xc3) ? mime : null
  }
  return mime
}

/** Decode base64 with one copy only: a view on the Buffer memory. */
function decode(base64: string): Uint8Array {
  const b = Buffer.from(base64, "base64")
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
}

/** Base64 chars to decode for a sniff: 88 chars give 66 bytes. */
const SNIFF_CHARS = 88

/** The loose magic MIME type of a base64 string (known fields). */
function sniffBase64(base64: string): string | null {
  return sniffMagic(decode(base64.slice(0, SNIFF_CHARS)))
}

/** The strict header MIME type of a base64 string (generic path). */
function sniffBase64Strict(base64: string): string | null {
  return sniffHeader(decode(base64.slice(0, SNIFF_CHARS)))
}

/** The decoded size of a base64 string, in bytes. */
function decodedSize(base64: string): number {
  const pad = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0
  return (base64.length / 4) * 3 - pad
}

/** A size as `24 B` (under 1 KB) or `12.3 KB`. */
export function formatKB(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

/**
 * The placeholder of a kept attachment. It replaces a JSON string value, so
 * it is a plain data value with no brackets.
 */
export function attachmentPlaceholder(n: number, mime: string, bytes: number): string {
  return `attachment ${n} (${mime}, ${formatKB(bytes)}): sent as an image or a saved file`
}

/** The placeholder of an attachment over the cap. A plain data value too. */
export function droppedPlaceholder(frame: boolean, mime: string, bytes: number): string {
  return frame
    ? `frame dropped (${formatKB(bytes)})`
    : `attachment dropped (${mime}, ${formatKB(bytes)})`
}

function screenshotMime(params: unknown): string {
  const format = isRecord(params) ? params.format : undefined
  if (format === "jpeg") return "image/jpeg"
  if (format === "webp") return "image/webp"
  return "image/png"
}

/** The known fields of this response, keyed by their holder object in the input. */
function knownSlots(body: unknown, ctx: ExtractContext): Map<object, KnownSlot> {
  const slots = new Map<object, KnownSlot>()
  if (!isRecord(body)) return slots
  if (ctx.action === "send" && isRecord(body.result)) {
    if (ctx.method === "Page.captureScreenshot") {
      slots.set(body.result, { key: "data", mime: screenshotMime(ctx.params), frame: false })
    } else if (ctx.method === "Page.printToPDF") {
      slots.set(body.result, { key: "data", mime: "application/pdf", frame: false })
    }
  }
  if (ctx.action === "events" && Array.isArray(body.events)) {
    for (const ev of body.events) {
      if (isRecord(ev) && ev.method === "Page.screencastFrame" && isRecord(ev.params)) {
        slots.set(ev.params, { key: "data", mime: "image/jpeg", frame: true })
      }
    }
  }
  return slots
}

/** A candidate for a generic string, or null. */
function genericCandidate(s: string): { base64: string; mime: string } | null {
  if (s.length <= MIN_GENERIC_CHARS) return null
  const uri = DATA_URI.exec(s)
  if (uri) {
    const base64 = s.slice(uri[0].length)
    if (!isBase64(base64)) return null
    const mime = sniffBase64Strict(base64)
    return mime ? { base64, mime } : null
  }
  if (!isBase64(s)) return null
  const mime = sniffBase64Strict(s)
  return mime ? { base64: s, mime } : null
}

/** A copy of `node`, with each candidate string recorded on its new holder. */
function walk(
  node: unknown,
  path: string,
  known: Map<object, KnownSlot>,
  out: Candidate[],
): unknown {
  if (Array.isArray(node)) {
    const copy: unknown[] = []
    node.forEach((v, i) => {
      copy.push(walk(v, `${path}[${i}]`, known, out))
      if (typeof v === "string") consider(copy, i, v, `${path}[${i}]`, undefined, out)
    })
    return copy
  }
  if (!isRecord(node)) return node
  const slot = known.get(node)
  const copy: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node)) {
    const p = path ? `${path}.${k}` : k
    copy[k] = walk(v, p, known, out)
    if (typeof v === "string") consider(copy, k, v, p, slot?.key === k ? slot : undefined, out)
  }
  return copy
}

/** Record one string leaf when it is media. */
function consider(
  holder: Record<string, unknown> | unknown[],
  key: string | number,
  s: string,
  label: string,
  slot: KnownSlot | undefined,
  out: Candidate[],
): void {
  if (slot) {
    if (!isBase64(s)) return
    const mime = sniffBase64(s) ?? slot.mime
    out.push({ holder, key, base64: s, mime, label, frame: slot.frame })
    return
  }
  const g = genericCandidate(s)
  if (g) out.push({ holder, key, base64: g.base64, mime: g.mime, label, frame: false })
}

function setAt(holder: Record<string, unknown> | unknown[], key: string | number, v: string): void {
  if (Array.isArray(holder)) holder[key as number] = v
  else holder[key as string] = v
}

/**
 * Take the media strings out of a daemon response body.
 *
 * @param body - The daemon response body. Not changed.
 * @param ctx - The action, and for `send` the method and params.
 * @returns A copy of the body with placeholders, and the attachments.
 */
export function extractMedia(body: unknown, ctx: ExtractContext): ExtractResult {
  const found: Candidate[] = []
  const copy = walk(body, "", knownSlots(body, ctx), found)
  if (found.length === 0) return { body, attachments: [] }
  const firstKept = Math.max(0, found.length - MAX_ATTACHMENTS)
  const attachments: MediaAttachment[] = []
  found.forEach((c, i) => {
    const size = decodedSize(c.base64)
    if (i < firstKept) {
      setAt(c.holder, c.key, droppedPlaceholder(c.frame, c.mime, size))
      return
    }
    const bytes = decode(c.base64)
    attachments.push({ bytes, mimeType: c.mime, label: c.label })
    setAt(c.holder, c.key, attachmentPlaceholder(attachments.length, c.mime, bytes.length))
  })
  return { body: copy, attachments }
}
