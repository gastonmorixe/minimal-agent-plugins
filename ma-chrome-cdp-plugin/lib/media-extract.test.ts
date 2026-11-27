import { describe, expect, test } from "bun:test"

import {
  extractMedia,
  isBase64,
  MAX_ATTACHMENTS,
  MIN_GENERIC_CHARS,
  sniffHeader,
  sniffMagic,
} from "./media-extract.ts"

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
/** The PNG signature, then the IHDR chunk length and type. */
const PNG_HEADER = [...PNG_MAGIC, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]
const JPEG_MAGIC = [0xff, 0xd8, 0xff, 0xe0]
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]
const WEBP_MAGIC = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]

/** Bytes that start with `magic` and have `size` bytes in total. */
function bytesOf(magic: number[], size = 64): Uint8Array {
  const b = new Uint8Array(Math.max(size, magic.length))
  b.set(magic, 0)
  for (let i = magic.length; i < b.length; i++) b[i] = (i * 7) % 256
  return b
}
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64")
/** Base64 longer than the generic limit. */
const bigB64 = (magic: number[]) => b64(bytesOf(magic, MIN_GENERIC_CHARS))

describe("sniffMagic and isBase64", () => {
  test("known magic", () => {
    expect(sniffMagic(bytesOf(PNG_MAGIC))).toBe("image/png")
    expect(sniffMagic(bytesOf(JPEG_MAGIC))).toBe("image/jpeg")
    expect(sniffMagic(bytesOf(PDF_MAGIC))).toBe("application/pdf")
    expect(sniffMagic(bytesOf(WEBP_MAGIC))).toBe("image/webp")
    expect(sniffMagic(bytesOf([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe("image/gif")
    expect(sniffMagic(bytesOf([1, 2, 3]))).toBeNull()
  })
  test("sniffHeader takes full headers", () => {
    expect(sniffHeader(bytesOf(PNG_HEADER))).toBe("image/png")
    for (const m of [0xe0, 0xe1, 0xef, 0xdb, 0xc0, 0xc2]) {
      expect(sniffHeader(bytesOf([0xff, 0xd8, 0xff, m]))).toBe("image/jpeg")
    }
    expect(sniffHeader(bytesOf([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]))).toBe("image/gif")
    expect(sniffHeader(bytesOf([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe("image/gif")
    expect(sniffHeader(bytesOf(WEBP_MAGIC))).toBe("image/webp")
    expect(sniffHeader(bytesOf(PDF_MAGIC))).toBe("application/pdf")
  })
  test("sniffHeader rejects bad headers", () => {
    // PNG signature with no IHDR chunk.
    expect(sniffHeader(bytesOf(PNG_MAGIC))).toBeNull()
    // FF D8 FF and a marker byte out of the set.
    for (const m of [0x00, 0x41, 0xc4, 0xd0, 0xf0, 0xff]) {
      expect(sniffHeader(bytesOf([0xff, 0xd8, 0xff, m]))).toBeNull()
    }
    // FF D8 with no FF after it.
    expect(sniffHeader(bytesOf([0xff, 0xd8, 0x00, 0xe0]))).toBeNull()
    expect(sniffHeader(bytesOf([0x47, 0x49, 0x46, 0x38, 0x38, 0x61]))).toBeNull()
    expect(
      sniffHeader(bytesOf([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20])),
    ).toBeNull()
    expect(sniffHeader(bytesOf([0x25, 0x50, 0x44, 0x46, 0x31]))).toBeNull()
  })
  test("base64 shape", () => {
    expect(isBase64("QUJD")).toBe(true)
    expect(isBase64("QUJ")).toBe(false)
    expect(isBase64("QU JD")).toBe(false)
    expect(isBase64("")).toBe(false)
  })
})

describe("extractMedia known fields", () => {
  test("Page.captureScreenshot png (default format)", () => {
    const png = bytesOf(PNG_MAGIC, 40)
    const body = { result: { data: b64(png) }, sessionId: "s1" }
    const r = extractMedia(body, { action: "send", method: "Page.captureScreenshot", params: {} })
    expect(r.attachments).toHaveLength(1)
    expect(r.attachments[0]!.mimeType).toBe("image/png")
    expect(r.attachments[0]!.label).toBe("result.data")
    expect(Array.from(r.attachments[0]!.bytes)).toEqual(Array.from(png))
    const data = (r.body as { result: { data: string } }).result.data
    expect(data).toBe("attachment 1 (image/png, 40 B): sent as an image or a saved file")
    expect((r.body as { sessionId: string }).sessionId).toBe("s1")
  })

  test("Page.captureScreenshot jpeg from params.format", () => {
    // Bytes with no magic: the MIME type comes from params.format.
    const body = { result: { data: b64(bytesOf([1, 2, 3], 30)) } }
    const r = extractMedia(body, {
      action: "send",
      method: "Page.captureScreenshot",
      params: { format: "jpeg" },
    })
    expect(r.attachments[0]!.mimeType).toBe("image/jpeg")
  })

  test("Page.printToPDF gives application/pdf", () => {
    const body = { result: { data: b64(bytesOf(PDF_MAGIC, 100)), stream: null } }
    const r = extractMedia(body, { action: "send", method: "Page.printToPDF" })
    expect(r.attachments[0]!.mimeType).toBe("application/pdf")
    expect(JSON.stringify(r.body)).toContain("application/pdf")
    expect(JSON.stringify(r.body)).not.toContain(b64(bytesOf(PDF_MAGIC, 100)))
  })

  test("a short non-base64 data field of a known method stays", () => {
    const body = { result: { data: "not base64!" } }
    const r = extractMedia(body, { action: "send", method: "Page.captureScreenshot" })
    expect(r.attachments).toEqual([])
    expect(r.body).toBe(body)
  })
})

describe("extractMedia generic", () => {
  test("a data URI from eval (canvas.toDataURL)", () => {
    const body = { result: `data:image/png;base64,${bigB64(PNG_HEADER)}` }
    const r = extractMedia(body, { action: "eval" })
    expect(r.attachments).toHaveLength(1)
    expect(r.attachments[0]!.mimeType).toBe("image/png")
    expect((r.body as { result: string }).result).toStartWith("attachment 1 (image/png,")
  })

  test("plain base64 with magic, deep in arrays", () => {
    const body = { result: { list: [{ x: [bigB64(JPEG_MAGIC)] }] } }
    const r = extractMedia(body, { action: "eval" })
    expect(r.attachments).toHaveLength(1)
    expect(r.attachments[0]!.mimeType).toBe("image/jpeg")
    expect(r.attachments[0]!.label).toBe("result.list[0].x[0]")
    const leaf = (r.body as { result: { list: Array<{ x: string[] }> } }).result.list[0]!.x[0]
    expect(leaf).toStartWith("attachment 1 (image/jpeg,")
  })

  test("long base64 that is not media stays as is", () => {
    const text = bigB64([1, 2, 3, 4])
    const body = { result: text }
    const r = extractMedia(body, { action: "eval" })
    expect(r.attachments).toEqual([])
    expect((r.body as { result: string }).result).toBe(text)
  })

  test("long base64 with a bad header stays as is", () => {
    // Text that is valid base64 and starts with `/9j/` (FF D8 FF) but has
    // no JPEG marker byte after it, and a PNG signature with no IHDR.
    const fakeJpeg = `/9j/${"A".repeat(MIN_GENERIC_CHARS + 4)}`
    const fakePng = bigB64(PNG_MAGIC)
    const body = { result: [fakeJpeg, fakePng, `data:image/png;base64,${fakePng}`] }
    const r = extractMedia(body, { action: "eval" })
    expect(r.attachments).toEqual([])
    expect(r.body).toBe(body)
  })

  test("a known field keeps the loose magic check", () => {
    // A screenshot with only the PNG signature (no IHDR) is still taken.
    const body = { result: { data: b64(bytesOf(PNG_MAGIC, 40)) } }
    const r = extractMedia(body, { action: "send", method: "Page.captureScreenshot" })
    expect(r.attachments[0]!.mimeType).toBe("image/png")
  })

  test("short base64 with magic stays (under the generic limit)", () => {
    const text = b64(bytesOf(PNG_MAGIC, 40))
    const r = extractMedia({ result: text }, { action: "eval" })
    expect(r.attachments).toEqual([])
  })
})

describe("extractMedia cap and purity", () => {
  test("events: the newest frames stay, older frames are dropped", () => {
    const n = MAX_ATTACHMENTS + 3
    const events = Array.from({ length: n }, (_, i) => ({
      seq: i + 1,
      method: "Page.screencastFrame",
      params: { data: b64(bytesOf(JPEG_MAGIC, 2048 + i)), sessionId: 1 },
    }))
    const body = { count: n, events }
    const r = extractMedia(body, { action: "events" })
    expect(r.attachments).toHaveLength(MAX_ATTACHMENTS)
    // The first kept frame is frame 4 (2048 + 3 bytes).
    expect(r.attachments[0]!.bytes.length).toBe(2051)
    expect(r.attachments.at(-1)!.bytes.length).toBe(2048 + n - 1)
    const out = (r.body as { events: Array<{ params: { data: string } }> }).events
    expect(out[0]!.params.data).toBe("frame dropped (2.0 KB)")
    expect(out[2]!.params.data).toStartWith("frame dropped (")
    expect(out[3]!.params.data).toStartWith("attachment 1 (image/jpeg,")
    expect(out[n - 1]!.params.data).toStartWith(`attachment ${MAX_ATTACHMENTS} (image/jpeg,`)
  })

  test("the input is not changed", () => {
    const data = b64(bytesOf(PNG_MAGIC, 40))
    const body = { result: { data }, list: [bigB64(PDF_MAGIC)] }
    const before = JSON.stringify(body)
    const r = extractMedia(body, { action: "send", method: "Page.captureScreenshot" })
    expect(r.attachments).toHaveLength(2)
    expect(JSON.stringify(body)).toBe(before)
    expect(r.body).not.toBe(body)
  })

  test("a body with no media is given back as the same object", () => {
    const body = [{ id: "t1", title: "x" }]
    const r = extractMedia(body, { action: "targets" })
    expect(r.body).toBe(body)
    expect(r.attachments).toEqual([])
  })
})
