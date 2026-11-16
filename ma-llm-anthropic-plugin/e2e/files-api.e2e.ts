/**
 * LIVE e2e for the Anthropic Files API path: the client (`files-api.ts`), the
 * lazy upload + cache (`media-upload.ts`), and the adapter wiring + 404 inline
 * retry (`adapter.ts`), against the real API.
 *
 * NOT RUN BY DEFAULT. The `.e2e.ts` suffix keeps it out of a plain `bun test`.
 * Opt in, from minimal-agent-plugins:
 *
 * ```sh
 * MA_E2E_LIVE=1 MA_E2E_CREDENTIAL_NAME=anthropic-plan-oauth-2 MA_E2E_MODEL=claude-haiku-5-5 bun test ./ma-llm-anthropic-plugin/e2e/files-api.e2e.ts --timeout 120000
 * ```
 *
 * The `./` prefix is required: without it bun treats the name as a filter.
 *
 * SAFETY
 * - The credential is read through `AuthStore.getSecrets`. The token is never
 *   printed. No token refresh is done: a 401 fails the case and stops there.
 * - Every file this suite uploads is recorded by a spy and deleted in
 *   `afterAll`. A final list of `/v1/files` checks that none is left.
 * - Cost: 5 Messages calls with max_tokens 30 on the cheapest model.
 *
 * @module llm-anthropic/e2e/files-api.e2e
 */

import { randomBytes } from "node:crypto"
import { deflateSync } from "node:zlib"

import { afterAll, describe, expect, it } from "bun:test"

import { AuthStore } from "@minimal-agent/core/host/auth-store"
import { createDefaultNetworkClient } from "@minimal-agent/core/host/network"
import type { CanonicalBlock } from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import type { CanonicalRequest } from "@minimal-agent/core/plugin-api/llm/canonical-request"
import type { ProviderAuth, RunContext } from "@minimal-agent/core/plugin-api/llm/provider-auth"
import type {
  NetworkClient,
  NetworkRequestInput,
  NetworkResponse,
} from "@minimal-agent/core/plugin-api/net/types"

import { anthropicAdapter, bootstrapAnthropic } from "../adapter.ts"
import {
  AnthropicFilesError,
  buildFilesHeaders,
  deleteAnthropicFile,
  FILES_URL,
  getAnthropicFile,
  uploadAnthropicFile,
} from "../files-api.ts"
import { makeTestRegistry } from "../lib/test-registry.ts"
import {
  ANTHROPIC_UPLOAD_EXPIRES_IN_SECONDS,
  ANTHROPIC_UPLOAD_THRESHOLD_BYTES,
} from "../media-upload.ts"
import { ANTHROPIC_PLAN_OAUTH, readAnthropicOAuthAuth } from "../oauth-login.ts"
import { buildBillingHeaderText, CLAUDE_CODE_IDENTITY } from "../system-prompt.ts"

// ---------------------------------------------------------------------------
// Opt-in gate
// ---------------------------------------------------------------------------

const LIVE = process.env.MA_E2E_LIVE === "1" || process.env.MA_E2E_LIVE === "true"
const CREDENTIAL_NAME = process.env.MA_E2E_CREDENTIAL_NAME ?? "anthropic-plan-oauth-2"
const MODEL_ID = process.env.MA_E2E_MODEL ?? "claude-haiku-5-5"
const MAX_TOKENS = 30

function resolveLiveAuth(): ProviderAuth | null {
  try {
    const secrets = new AuthStore().getSecrets(ANTHROPIC_PLAN_OAUTH.id, CREDENTIAL_NAME)
    if (!secrets) return null
    const expiresAt = typeof secrets.expiresAt === "number" ? secrets.expiresAt : 0
    // Never refresh: an expired token means skip, not rotate.
    if (expiresAt > 0 && expiresAt < Date.now() + 60_000) return null
    return readAnthropicOAuthAuth(secrets)
  } catch {
    return null
  }
}

const AUTH = LIVE ? resolveLiveAuth() : null
const SKIP_REASON = !LIVE
  ? "set MA_E2E_LIVE=1 to run the live Files API e2e"
  : AUTH === null
    ? `no usable stored credential "${CREDENTIAL_NAME}" under "${ANTHROPIC_PLAN_OAUTH.id}"`
    : null
if (SKIP_REASON) console.log(`[files-api.e2e] skip: ${SKIP_REASON}`)

// ---------------------------------------------------------------------------
// Fixtures: a valid PNG and valid PDFs, made in memory
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

/**
 * A red RGB PNG with random noise in G/B and the low bits of R. Stored
 * (level 0) deflate, so the file stays above 1 MiB.
 */
function makeRedNoisePng(w = 640, h = 640): Buffer {
  const noise = randomBytes(w * h * 3)
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1)
    raw[row] = 0 // filter: none
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      const o = row + 1 + x * 3
      raw[o] = 200 + (noise[i]! % 56)
      raw[o + 1] = noise[i + 1]! % 40
      raw[o + 2] = noise[i + 2]! % 40
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 0 })),
    pngChunk("IEND", new Uint8Array(0)),
  ])
}

/**
 * A one-page PDF with `text` on it. `padBytes` adds an unreferenced binary
 * stream object so the file can pass the upload threshold. The xref offsets
 * are computed, so the file is valid.
 */
function makePdf(text: string, padBytes = 0): Buffer {
  const content = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`
  const objs: Buffer[] = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
        "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    ),
    Buffer.from(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
  ]
  if (padBytes > 0) {
    const pad = randomBytes(padBytes)
    objs.push(
      Buffer.concat([
        Buffer.from(`<< /Length ${pad.length} >>\nstream\n`),
        pad,
        Buffer.from("\nendstream"),
      ]),
    )
  }
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1")]
  let offset = parts[0]!.length
  const offsets: number[] = []
  objs.forEach((body, i) => {
    offsets.push(offset)
    const obj = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from("\nendobj\n")])
    parts.push(obj)
    offset += obj.length
  })
  const xref =
    `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`
  parts.push(Buffer.from(xref))
  return Buffer.concat(parts)
}

// ---------------------------------------------------------------------------
// Spy network client
// ---------------------------------------------------------------------------

interface SeenCall {
  label: string
  method: string
  url: string
  status: number
  requestId: string
  /** Parsed JSON of a Messages request body (gunzipped when needed). */
  messagesBody?: { messages: { content: unknown[] }[] }
  /** Error body of a non-2xx answer (no secret: the API never echoes the token). */
  errorBody?: string
  /** First bytes of an upload form, as text (form fields come before the file bytes). */
  uploadHead?: string
  /** `expires_at` of an upload answer. */
  expiresAt?: string | null
}

/** Every file id this suite uploaded, for cleanup. */
const uploadedIds = new Set<string>()
/** Ids deleted with a 200 or confirmed gone with a 404. */
const deletedIds = new Set<string>()
const calls: SeenCall[] = []
const usage: { case: string; input: number; output: number; cacheRead: number }[] = []

function decodeBody(input: NetworkRequestInput): string | undefined {
  if (input.body === undefined) return undefined
  if (typeof input.body === "string") return input.body
  const gz = input.headers?.["content-encoding"] === "gzip"
  const bytes = gz ? Bun.gunzipSync(new Uint8Array(input.body)) : input.body
  return new TextDecoder().decode(bytes)
}

/** Wrap a response whose body was already read as text. */
function replay(res: NetworkResponse, text: string): NetworkResponse {
  return {
    status: res.status,
    headers: res.headers,
    transport: res.transport,
    ok: res.ok,
    body: new Response(text).body!,
    text: async () => text,
    json: async <T>() => JSON.parse(text) as T,
  }
}

function makeSpyClient(): NetworkClient {
  const real = createDefaultNetworkClient() as unknown as NetworkClient
  return {
    async request(input: NetworkRequestInput): Promise<NetworkResponse> {
      const call: SeenCall = {
        label: input.label,
        method: input.method,
        url: input.url,
        status: 0,
        requestId: "",
      }
      calls.push(call)
      if (input.url.startsWith("https://api.anthropic.com/v1/messages")) {
        const s = decodeBody(input)
        if (s) call.messagesBody = JSON.parse(s)
      }
      const isUpload = input.method === "POST" && input.url === FILES_URL
      if (isUpload && input.body instanceof Uint8Array) {
        call.uploadHead = new TextDecoder().decode(input.body.slice(0, 400))
      }
      const res = await real.request(input)
      call.status = res.status
      call.requestId = res.headers.get("request-id") ?? ""
      if (isUpload || !res.ok) {
        const text = await res.text()
        if (isUpload && res.ok) {
          const parsed = JSON.parse(text) as { id?: string; expires_at?: string | null }
          if (parsed.id) uploadedIds.add(parsed.id)
          call.expiresAt = parsed.expires_at
        }
        if (!res.ok) call.errorBody = text.slice(0, 300)
        return replay(res, text)
      }
      return res
    },
  }
}

const client = makeSpyClient()
const sessionId = `e2e-files-${Date.now()}`

// ---------------------------------------------------------------------------
// Adapter harness
// ---------------------------------------------------------------------------

const reg = makeTestRegistry()
bootstrapAnthropic(reg.ctx)

function oauthSystem(): CanonicalBlock[] {
  return [
    { type: "text", text: buildBillingHeaderText() },
    { type: "text", text: CLAUDE_CODE_IDENTITY },
  ]
}

function reqWith(block: CanonicalBlock, question: string): CanonicalRequest {
  return {
    modelId: MODEL_ID,
    system: oauthSystem(),
    messages: [{ role: "user", content: [block, { type: "text", text: question }] }],
    generation: { maxOutputTokens: MAX_TOKENS },
    thinking: { mode: "off" },
  }
}

async function runOnce(label: string, req: CanonicalRequest): Promise<string> {
  const model = reg.resolveModel(MODEL_ID)
  const ctx: RunContext = { auth: AUTH!, sessionId, networkClient: client }
  let text = ""
  const u = { case: label, input: 0, output: 0, cacheRead: 0 }
  for await (const ev of anthropicAdapter.run!(req, model, ctx)) {
    const e = ev as unknown as {
      type: string
      text?: string
      initialUsage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number }
      usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number }
    }
    if (e.type === "text_delta" && typeof e.text === "string") text += e.text
    const usg = e.usage ?? e.initialUsage
    if (usg) {
      u.input = Math.max(u.input, usg.inputTokens)
      u.output = Math.max(u.output, usg.outputTokens)
      u.cacheRead = Math.max(u.cacheRead, usg.cacheReadTokens ?? 0)
    }
  }
  usage.push(u)
  console.log(`[files-api.e2e] ${label}: answer=${JSON.stringify(text.trim())}`)
  return text
}

const messagesCalls = () => calls.filter((c) => c.url.includes("/v1/messages"))
const uploadCalls = () => calls.filter((c) => c.method === "POST" && c.url === FILES_URL)
const firstSource = (c: SeenCall) =>
  c.messagesBody?.messages[0]?.content[0] as { type: string; source: Record<string, unknown> }

const filesDeps = () => ({ auth: AUTH!, networkClient: client, sessionId })

async function deleteIfLive(id: string): Promise<void> {
  try {
    await deleteAnthropicFile(id, filesDeps())
    deletedIds.add(id)
  } catch (err) {
    if (err instanceof AnthropicFilesError && err.status === 404) deletedIds.add(id)
    else console.log(`[files-api.e2e] cleanup of ${id} failed: ${(err as Error).message}`)
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_REASON !== null)("anthropic Files API live e2e", () => {
  const T = { timeout: 120_000 }
  const png = makeRedNoisePng()
  const pngB64 = png.toString("base64")
  const bigImage: CanonicalBlock = {
    type: "image",
    source: { kind: "base64", mediaType: "image/png", data: pngB64 },
  }

  afterAll(async () => {
    for (const id of uploadedIds) if (!deletedIds.has(id)) await deleteIfLive(id)
    // Final proof: list the newest files and look for any id we uploaded.
    const headers = buildFilesHeaders(filesDeps())
    const res = await client.request({
      label: "files.list",
      method: "GET",
      url: `${FILES_URL}?limit=100`,
      headers,
    })
    const listed = res.ok ? ((await res.json()) as { data: { id: string }[] }).data : []
    const left = listed.filter((f) => uploadedIds.has(f.id)).map((f) => f.id)
    console.log(
      `[files-api.e2e] SUMMARY ${JSON.stringify({
        uploaded: [...uploadedIds],
        deleted: [...deletedIds],
        listStatus: res.status,
        listedCount: listed.length,
        leftOver: left,
        usage,
        calls: calls.map((c) => ({
          label: c.label,
          method: c.method,
          url: c.url.replace("https://api.anthropic.com", ""),
          status: c.status,
          requestId: c.requestId,
          error: c.errorBody,
        })),
      })}`,
    )
    expect(res.status).toBe(200)
    expect(left).toEqual([])
  })

  it("fixtures are above the upload threshold", () => {
    expect(png.length).toBeGreaterThanOrEqual(ANTHROPIC_UPLOAD_THRESHOLD_BYTES)
  })

  it("1. client: upload a small PDF, get metadata, delete, then 404", T, async () => {
    const pdf = makePdf("hello e2e")
    const meta = await uploadAnthropicFile(
      { bytes: pdf, filename: "ma-e2e-small.pdf", mimeType: "application/pdf" },
      filesDeps(),
    )
    expect(meta.id).toMatch(/^file_/)
    expect(uploadedIds.has(meta.id)).toBe(true)
    try {
      const got = await getAnthropicFile(meta.id, filesDeps())
      expect(got.id).toBe(meta.id)
      expect(got.mime_type).toBe("application/pdf")
      expect(got.size_bytes).toBe(pdf.length)
      expect(got.filename).toBe("ma-e2e-small.pdf")
      const del = await deleteAnthropicFile(meta.id, filesDeps())
      expect(del).toEqual({ id: meta.id, type: "file_deleted" })
      deletedIds.add(meta.id)
      const err = await getAnthropicFile(meta.id, filesDeps()).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(AnthropicFilesError)
      expect((err as AnthropicFilesError).status).toBe(404)
      expect((err as AnthropicFilesError).errorType).toBe("not_found_error")
    } finally {
      if (!deletedIds.has(meta.id)) await deleteIfLive(meta.id)
    }
  })

  it("2. adapter: a big PNG is uploaded once and sent as a file source", T, async () => {
    const before = uploadCalls().length
    const text = await runOnce(
      "case2-image-upload",
      reqWith(bigImage, "What is the main color of this image? Answer in one word."),
    )
    expect(uploadCalls().length - before).toBe(1)
    const up = uploadCalls().at(-1)!
    expect(up.status).toBe(200)
    // The adapter upload sends expires_in_seconds (default 86400), and the
    // server answers with an expires_at.
    expect(up.uploadHead ?? "").toContain(
      `name="expires_in_seconds"\r\n\r\n${ANTHROPIC_UPLOAD_EXPIRES_IN_SECONDS}\r\n`,
    )
    console.log(`[files-api.e2e] case2 upload expires_at: ${String(up.expiresAt)}`)
    expect(typeof up.expiresAt).toBe("string")
    const msg = messagesCalls().at(-1)!
    expect(msg.status).toBe(200)
    const src = firstSource(msg)
    expect(src.type).toBe("image")
    expect(src.source.type).toBe("file")
    expect(uploadedIds.has(src.source.file_id as string)).toBe(true)
    expect(text.trim().length).toBeGreaterThan(0)
  })

  it("3. adapter: the same PNG again is a cache hit (no second upload)", T, async () => {
    const before = uploadCalls().length
    const prevId = firstSource(messagesCalls().at(-1)!).source.file_id
    const text = await runOnce(
      "case3-image-cache-hit",
      reqWith(bigImage, "What is the main color of this image? Answer in one word."),
    )
    expect(uploadCalls().length).toBe(before)
    const msg = messagesCalls().at(-1)!
    expect(msg.status).toBe(200)
    expect(firstSource(msg).source).toEqual({ type: "file", file_id: prevId })
    expect(text.trim().length).toBeGreaterThan(0)
  })

  it("4. adapter: a big PDF goes up and is sent as a document file source", T, async () => {
    const pdf = makePdf("The secret word is BANANA.", ANTHROPIC_UPLOAD_THRESHOLD_BYTES + 4096)
    expect(pdf.length).toBeGreaterThan(ANTHROPIC_UPLOAD_THRESHOLD_BYTES)
    const block: CanonicalBlock = {
      type: "file",
      source: {
        kind: "base64",
        mediaType: "application/pdf",
        data: pdf.toString("base64"),
        filename: "ma-e2e-big.pdf",
      },
    }
    const before = uploadCalls().length
    const text = await runOnce(
      "case4-pdf-upload",
      reqWith(block, "What is the secret word in the document? Answer in one word."),
    )
    expect(uploadCalls().length - before).toBe(1)
    const msg = messagesCalls().at(-1)!
    expect(msg.status).toBe(200)
    const src = firstSource(msg)
    expect(src.type).toBe("document")
    expect(src.source.type).toBe("file")
    expect(text.trim().length).toBeGreaterThan(0)
    console.log(`[files-api.e2e] case4 mentions BANANA: ${/banana/i.test(text)}`)
  })

  it("5. adapter: a cached id deleted out of band gives 404, evict, inline retry", T, async () => {
    // The PNG id is still cached from case 2. Delete it behind the cache.
    const cachedId = firstSource(messagesCalls().find((c) => firstSource(c).type === "image")!)
      .source.file_id as string
    await deleteAnthropicFile(cachedId, filesDeps())
    deletedIds.add(cachedId)

    const uploadsBefore = uploadCalls().length
    const msgBefore = messagesCalls().length
    const text = await runOnce(
      "case5-404-inline-retry",
      reqWith(bigImage, "What is the main color of this image? Answer in one word."),
    )
    const sent = messagesCalls().slice(msgBefore)
    expect(sent.length).toBe(2)
    expect(sent[0]!.status).toBe(404)
    expect(firstSource(sent[0]!).source).toEqual({ type: "file", file_id: cachedId })
    expect(sent[0]!.errorBody ?? "").toContain("not_found_error")
    expect(sent[1]!.status).toBe(200)
    expect(firstSource(sent[1]!).source.type).toBe("base64")
    expect(uploadCalls().length).toBe(uploadsBefore)
    expect(text.trim().length).toBeGreaterThan(0)
  })
})
