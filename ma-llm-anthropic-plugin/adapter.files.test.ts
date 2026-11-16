/**
 * Lazy Files API upload inside `anthropicAdapter.run()`. No network: a fake
 * NetworkClient routes `/v1/files` and `/v1/messages` to scripted answers.
 *
 * @module llm-anthropic/adapter.files.test
 */

import { beforeEach, describe, expect, it } from "bun:test"

import type { CanonicalBlock } from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import type { CanonicalRequest } from "@minimal-agent/core/plugin-api/llm/canonical-request"
import type { ProviderAuth, RunContext } from "@minimal-agent/core/plugin-api/llm/provider-auth"
import type {
  NetworkClient,
  NetworkRequest,
  NetworkResponse,
} from "@minimal-agent/core/plugin-api/net/types"

import { _resetGzipRejectedForTest, anthropicAdapter, bootstrapAnthropic } from "./adapter.ts"
import type { ModelEntry } from "./lib/host-types.ts"
import { makeTestRegistry } from "./lib/test-registry.ts"
import {
  _resetMediaUploadCacheForTest,
  ANTHROPIC_UPLOAD_EXPIRES_IN_SECONDS,
  ANTHROPIC_UPLOAD_THRESHOLD_BYTES,
  credentialIdentity,
  evictMissingFiles,
  isMissingFileError,
  prepareMediaUploads,
} from "./media-upload.ts"

let resolveModel: (id: string) => ModelEntry
const auth: ProviderAuth = { kind: "api-key", key: "sk-test" }

beforeEach(() => {
  process.env.MINIMAL_AGENT_NO_REQUEST_GZIP = "1"
  _resetGzipRejectedForTest()
  _resetMediaUploadCacheForTest()
  const reg = makeTestRegistry()
  bootstrapAnthropic(reg.ctx)
  resolveModel = reg.resolveModel
})

/** Base64 of `n` bytes that differ by `seed`. */
function b64(n: number, seed = 1): string {
  const bytes = new Uint8Array(n)
  for (let i = 0; i < n; i++) bytes[i] = (i * 31 + seed) & 0xff
  return Buffer.from(bytes).toString("base64")
}

const BIG = b64(ANTHROPIC_UPLOAD_THRESHOLD_BYTES)
const SMALL = b64(1000)

function image(data: string): CanonicalBlock {
  return { type: "image", source: { kind: "base64", mediaType: "image/png", data } }
}

function reqWith(...blocks: CanonicalBlock[]): CanonicalRequest {
  return {
    modelId: "claude-opus-4-8",
    messages: [{ role: "user", content: [...blocks, { type: "text", text: "what is it?" }] }],
  }
}

function sse(): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(c) {
      c.enqueue(enc.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'))
      c.close()
    },
  })
}

interface Script {
  upload?: (n: number) => { status: number; body: unknown } | Error
  messages?: (n: number) => { status: number; body?: string }
}

function scripted(script: Script = {}) {
  const uploads: NetworkRequest[] = []
  const messages: NetworkRequest[] = []
  const client = {
    request: async (r: NetworkRequest): Promise<NetworkResponse> => {
      if (r.url.startsWith("https://api.anthropic.com/v1/files")) {
        uploads.push(r)
        const n = uploads.length
        // Yield so a second concurrent caller can join the in-flight upload.
        await new Promise((res) => setTimeout(res, 5))
        if (r.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError")
        const step = script.upload?.(n) ?? {
          status: 200,
          body: {
            type: "file",
            id: `file_up${n}`,
            filename: "x",
            mime_type: "image/png",
          },
        }
        if (step instanceof Error) throw step
        const text = JSON.stringify(step.body)
        return {
          ok: step.status < 300,
          status: step.status,
          headers: new Headers(),
          text: async () => text,
          json: async () => JSON.parse(text),
        } as unknown as NetworkResponse
      }
      messages.push(r)
      const step = script.messages?.(messages.length) ?? { status: 200 }
      const ok = step.status < 300
      return {
        ok,
        status: step.status,
        headers: new Headers(),
        body: ok ? sse() : null,
        text: async () => step.body ?? "",
      } as unknown as NetworkResponse
    },
  } as NetworkClient
  return { client, uploads, messages }
}

async function runWith(
  req: CanonicalRequest,
  client: NetworkClient,
  runAuth: ProviderAuth = auth,
): Promise<void> {
  const ctx: RunContext = { auth: runAuth, sessionId: "s1", networkClient: client }
  for await (const _ of anthropicAdapter.run!(req, resolveModel("claude-opus-4-8"), ctx)) {
    // drain
  }
}

const sentContent = (r: NetworkRequest): any[] => JSON.parse(r.body as string).messages[0].content

describe("adapter run(): lazy Files API upload", () => {
  it("uploads a big image once and sends a file source; the canonical request keeps base64", async () => {
    const { client, uploads, messages } = scripted()
    const req = reqWith(image(BIG))
    await runWith(req, client)
    expect(uploads.length).toBe(1)
    expect(uploads[0]!.method).toBe("POST")
    expect(sentContent(messages[0]!)[0]).toEqual({
      type: "image",
      source: { type: "file", file_id: "file_up1" },
    })
    const first = req.messages[0]!.content[0] as Extract<CanonicalBlock, { type: "image" }>
    expect(first.source.kind).toBe("base64")
  })

  it("uploads the same image once across turns and within one request", async () => {
    const { client, uploads, messages } = scripted()
    await runWith(reqWith(image(BIG), image(BIG)), client)
    await runWith(reqWith(image(BIG)), client)
    expect(uploads.length).toBe(1)
    expect(sentContent(messages[0]!)[1].source).toEqual({ type: "file", file_id: "file_up1" })
    expect(sentContent(messages[1]!)[0].source).toEqual({ type: "file", file_id: "file_up1" })
  })

  it("dedupes concurrent uploads of the same bytes", async () => {
    const { client, uploads } = scripted()
    await Promise.all([runWith(reqWith(image(BIG)), client), runWith(reqWith(image(BIG)), client)])
    expect(uploads.length).toBe(1)
  })

  it("keeps a small image inline with no upload", async () => {
    const { client, uploads, messages } = scripted()
    await runWith(reqWith(image(SMALL)), client)
    expect(uploads.length).toBe(0)
    expect(sentContent(messages[0]!)[0].source.type).toBe("base64")
  })

  it("uploads a big PDF document and sends a document file source", async () => {
    const { client, uploads, messages } = scripted()
    const pdf: CanonicalBlock = {
      type: "file",
      source: { kind: "base64", mediaType: "application/pdf", data: BIG, filename: "r.pdf" },
    }
    await runWith(reqWith(pdf), client)
    expect(uploads.length).toBe(1)
    expect(new TextDecoder().decode((uploads[0]!.body as Uint8Array).slice(0, 400))).toContain(
      'filename="r.pdf"',
    )
    expect(sentContent(messages[0]!)[0]).toEqual({
      type: "document",
      source: { type: "file", file_id: "file_up1" },
    })
  })

  it("falls back to inline base64 when the upload fails (5xx, network)", async () => {
    for (const fail of [{ status: 500, body: {} }, new Error("ECONNRESET")]) {
      _resetMediaUploadCacheForTest()
      const { client, uploads, messages } = scripted({ upload: () => fail })
      await runWith(reqWith(image(BIG)), client)
      expect(uploads.length).toBe(1)
      expect(messages.length).toBe(1)
      expect(sentContent(messages[0]!)[0].source.type).toBe("base64")
    }
  })

  it("stops trying uploads for a credential after a 403", async () => {
    const { client, uploads, messages } = scripted({ upload: () => ({ status: 403, body: {} }) })
    await runWith(reqWith(image(BIG)), client)
    await runWith(reqWith(image(b64(ANTHROPIC_UPLOAD_THRESHOLD_BYTES, 7))), client)
    expect(uploads.length).toBe(1)
    expect(sentContent(messages[1]!)[0].source.type).toBe("base64")
  })

  it("on a Messages 404 for the file: evicts it and retries once inline", async () => {
    const notFound = JSON.stringify({
      type: "error",
      error: { type: "not_found_error", message: "File `file_up1` not found." },
    })
    const { client, uploads, messages } = scripted({
      messages: (n) => (n === 1 ? { status: 404, body: notFound } : { status: 200 }),
    })
    await runWith(reqWith(image(BIG)), client)
    expect(messages.length).toBe(2)
    expect(sentContent(messages[0]!)[0].source.type).toBe("file")
    expect(sentContent(messages[1]!)[0].source.type).toBe("base64")
    // The evicted entry forces a fresh upload on the next turn.
    await runWith(reqWith(image(BIG)), client)
    expect(uploads.length).toBe(2)
    expect(sentContent(messages[2]!)[0].source).toEqual({ type: "file", file_id: "file_up2" })
  })

  it("does not retry a 404 that is not about a file", async () => {
    const other = JSON.stringify({
      type: "error",
      error: { type: "not_found_error", message: "model" },
    })
    const { client, messages } = scripted({ messages: () => ({ status: 404, body: other }) })
    const err = await runWith(reqWith(image(BIG)), client).catch((e: unknown) => e as Error)
    expect(err?.message).toContain("404")
    expect(messages.length).toBe(1)
  })
})

const fileNotFound = (id: string): string =>
  JSON.stringify({
    type: "error",
    error: { type: "not_found_error", message: `File \`${id}\` not found.` },
  })

const uploadText = (r: NetworkRequest): string => new TextDecoder().decode(r.body as Uint8Array)

describe("adapter run(): review fixes", () => {
  it("sends expires_in_seconds=86400 on the upload form", async () => {
    const { client, uploads } = scripted()
    await runWith(reqWith(image(BIG)), client)
    expect(uploadText(uploads[0]!)).toContain(
      'name="expires_in_seconds"\r\n\r\n' + String(ANTHROPIC_UPLOAD_EXPIRES_IN_SECONDS) + "\r\n",
    )
    expect(ANTHROPIC_UPLOAD_EXPIRES_IN_SECONDS).toBe(86_400)
  })

  it("passes the abort signal to the upload request", async () => {
    const { client, uploads } = scripted()
    const ac = new AbortController()
    await runWith({ ...reqWith(image(BIG)), signal: ac.signal }, client)
    expect(uploads[0]!.signal).toBe(ac.signal)
  })

  it("rethrows an abort and does not cache the aborted upload", async () => {
    const { client, uploads, messages } = scripted()
    const ac = new AbortController()
    const run = runWith({ ...reqWith(image(BIG)), signal: ac.signal }, client)
    ac.abort()
    const err = await run.catch((e: unknown) => e as Error)
    expect(err?.name).toBe("AbortError")
    expect(messages.length).toBe(0)
    await runWith(reqWith(image(BIG)), client)
    expect(uploads.length).toBe(2)
    expect(sentContent(messages[0]!)[0].source).toEqual({ type: "file", file_id: "file_up2" })
  })

  it("a concurrent caller that joins an upload aborted by another caller uploads again", async () => {
    const { client, uploads, messages } = scripted()
    const ac = new AbortController()
    const a = runWith({ ...reqWith(image(BIG)), signal: ac.signal }, client)
    const b = runWith(reqWith(image(BIG)), client)
    ac.abort()
    expect((await a.catch((e: unknown) => e as Error))?.name).toBe("AbortError")
    await b
    expect(uploads.length).toBe(2)
    expect(messages.length).toBe(1)
    expect(sentContent(messages[0]!)[0].source.type).toBe("file")
  })

  it("keeps an item inline across turns after a 400, 413 or 415 (no retry)", async () => {
    for (const status of [400, 413, 415]) {
      _resetMediaUploadCacheForTest()
      const { client, uploads, messages } = scripted({ upload: () => ({ status, body: {} }) })
      await runWith(reqWith(image(BIG)), client)
      await runWith(reqWith(image(BIG)), client)
      expect(uploads.length).toBe(1)
      expect(sentContent(messages[0]!)[0].source.type).toBe("base64")
      expect(sentContent(messages[1]!)[0].source.type).toBe("base64")
    }
  })

  it("a concurrent dedupe whose upload fails: both go inline, a later turn retries", async () => {
    const { client, uploads, messages } = scripted({
      upload: (n) => (n === 1 ? { status: 500, body: {} } : undefined)!,
    })
    await Promise.all([runWith(reqWith(image(BIG)), client), runWith(reqWith(image(BIG)), client)])
    expect(uploads.length).toBe(1)
    expect(messages.map((m) => sentContent(m)[0].source.type)).toEqual(["base64", "base64"])
    await runWith(reqWith(image(BIG)), client)
    expect(uploads.length).toBe(2)
    expect(sentContent(messages[2]!)[0].source.type).toBe("file")
  })

  it("uploads a big text/plain document as text/plain", async () => {
    const { client, uploads, messages } = scripted()
    const txt: CanonicalBlock = {
      type: "file",
      source: { kind: "base64", mediaType: "text/markdown", data: BIG },
    }
    await runWith(reqWith(txt), client)
    const head = uploadText(uploads[0]!).slice(0, 400)
    expect(head).toContain("Content-Type: text/plain")
    expect(head).toMatch(/filename="ma-[0-9a-f]{16}\.txt"/)
    expect(sentContent(messages[0]!)[0]).toEqual({
      type: "document",
      source: { type: "file", file_id: "file_up1" },
    })
  })

  it("uploads an image inside a tool_result", async () => {
    const { client, uploads, messages } = scripted()
    const tr: CanonicalBlock = {
      type: "tool_result",
      toolUseId: "toolu_1",
      content: [image(BIG)],
    } as CanonicalBlock
    await runWith(reqWith(tr), client)
    expect(uploads.length).toBe(1)
    expect(sentContent(messages[0]!)[0].content[0]).toEqual({
      type: "image",
      source: { type: "file", file_id: "file_up1" },
    })
  })

  it("a 404 that names no used id but a file_ id evicts every used entry", async () => {
    const { client, uploads, messages } = scripted({
      messages: (n) =>
        n === 1 ? { status: 404, body: fileNotFound("file_other9") } : { status: 200 },
    })
    await runWith(reqWith(image(BIG)), client)
    expect(messages.length).toBe(2)
    expect(sentContent(messages[1]!)[0].source.type).toBe("base64")
    await runWith(reqWith(image(BIG)), client)
    expect(uploads.length).toBe(2)
  })

  it("does not treat a 404 about a 'profile' as a missing file", async () => {
    const body = JSON.stringify({
      type: "error",
      error: { type: "not_found_error", message: "profile not found" },
    })
    const { client, messages } = scripted({ messages: () => ({ status: 404, body }) })
    const err = await runWith(reqWith(image(BIG)), client).catch((e: unknown) => e as Error)
    expect(err?.message).toContain("404")
    expect(messages.length).toBe(1)
  })

  it("a 404 retry that fails again throws once, with no loop", async () => {
    const { client, messages } = scripted({
      messages: () => ({ status: 404, body: fileNotFound("file_up1") }),
    })
    const err = await runWith(reqWith(image(BIG)), client).catch((e: unknown) => e as Error)
    expect(err?.message).toContain("404")
    expect(messages.length).toBe(2)
  })

  it("on a 404 retry only the evicted id goes inline", async () => {
    const { client, messages } = scripted({
      messages: (n) =>
        n === 1 ? { status: 404, body: fileNotFound("file_up1") } : { status: 200 },
    })
    const other = b64(ANTHROPIC_UPLOAD_THRESHOLD_BYTES, 9)
    await runWith(reqWith(image(BIG), image(other)), client)
    const retry = sentContent(messages[1]!)
    const types = retry.slice(0, 2).map((b: any) => b.source.type)
    expect(types.filter((t: string) => t === "base64").length).toBe(1)
    expect(types.filter((t: string) => t === "file").length).toBe(1)
  })

  it("a stale eviction does not drop a newer upload of the same bytes", async () => {
    const { client, uploads } = scripted()
    const ctx: RunContext = { auth, sessionId: "s1", networkClient: client }
    const req = reqWith(image(BIG))
    const first = await prepareMediaUploads(req, ctx, client)
    evictMissingFiles(first.used, fileNotFound("file_up1"))
    const second = await prepareMediaUploads(req, ctx, client)
    expect([...second.used.keys()]).toEqual(["file_up2"])
    evictMissingFiles(first.used, fileNotFound("file_up1"))
    const third = await prepareMediaUploads(req, ctx, client)
    expect([...third.used.keys()]).toEqual(["file_up2"])
    expect(uploads.length).toBe(2)
  })

  it("custom auth: upload sends the custom headers and no Messages beta", async () => {
    const { client, uploads } = scripted()
    const custom: ProviderAuth = { kind: "custom", headers: { "x-gateway-key": "gw-secret" } }
    await runWith(reqWith(image(BIG)), client, custom)
    const h = uploads[0]!.headers ?? {}
    expect(h["x-gateway-key"]).toBe("gw-secret")
    expect(h["anthropic-beta"]).toBeUndefined()
    expect(h["x-api-key"]).toBeUndefined()
  })
})

describe("isMissingFileError", () => {
  it("matches a used id or a file_ token, not the word file", () => {
    const nf = (msg: string) => JSON.stringify({ error: { type: "not_found_error", message: msg } })
    expect(isMissingFileError(404, nf("File `file_up1` not found."), ["file_up1"])).toBe(true)
    expect(isMissingFileError(404, nf("File `file_zz` not found."), [])).toBe(true)
    expect(isMissingFileError(404, nf("profile missing"), ["file_up1"])).toBe(false)
    expect(isMissingFileError(404, nf("a file is gone"), [])).toBe(false)
    expect(isMissingFileError(400, nf("File `file_up1` not found."), ["file_up1"])).toBe(false)
  })
})

describe("credentialIdentity", () => {
  it("custom auth: stable across header order, differs per value, hides the secret", () => {
    const a = credentialIdentity({ kind: "custom", headers: { a: "1", "x-key": "gw-secret" } })
    const b = credentialIdentity({ kind: "custom", headers: { "x-key": "gw-secret", a: "1" } })
    const c = credentialIdentity({ kind: "custom", headers: { a: "1", "x-key": "gw-other" } })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).not.toContain("gw-secret")
    expect(a.startsWith("custom:")).toBe(true)
  })

  it("never contains the raw secret and differs per credential", () => {
    const a = credentialIdentity({ kind: "api-key", key: "sk-secret-1" })
    const b = credentialIdentity({ kind: "api-key", key: "sk-secret-2" })
    const o = credentialIdentity({ kind: "oauth", token: "oat-secret" })
    expect(a).not.toContain("sk-secret")
    expect(o).not.toContain("oat-secret")
    expect(a).not.toBe(b)
    expect(o.startsWith("oauth:")).toBe(true)
  })
})
