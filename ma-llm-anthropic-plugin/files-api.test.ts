/**
 * Files API client: multipart bytes, request shape, headers, response parse,
 * and error mapping. No network: a fake NetworkClient records each request.
 *
 * @module llm-anthropic/files-api.test
 */

import { describe, expect, it } from "bun:test"

import type { ProviderAuth } from "@minimal-agent/core/plugin-api/llm/provider-auth"
import type {
  NetworkClient,
  NetworkRequest,
  NetworkResponse,
} from "@minimal-agent/core/plugin-api/net/types"

import {
  AnthropicFilesError,
  buildFilesHeaders,
  buildMultipartBody,
  clampExpiresInSeconds,
  deleteAnthropicFile,
  FILES_URL,
  getAnthropicFile,
  MAX_EXPIRES_IN_SECONDS,
  MIN_EXPIRES_IN_SECONDS,
  uploadAnthropicFile,
} from "./files-api.ts"

const META = {
  type: "file",
  id: "file_01NH1FTPocfsQgV4me2FPXhE",
  size_bytes: 15,
  created_at: "2026-11-15T16:16:45.495088Z",
  expires_at: null,
  filename: "ma-r1-hello.txt",
  mime_type: "text/plain",
  downloadable: true,
}

/** A fake client that answers every request with one status + body, or throws. */
function fake(status: number, body: unknown, fail?: Error) {
  const seen: NetworkRequest[] = []
  const client = {
    request: async (r: NetworkRequest): Promise<NetworkResponse> => {
      seen.push(r)
      if (fail) throw fail
      const text = typeof body === "string" ? body : JSON.stringify(body)
      return {
        ok: status < 300,
        status,
        headers: new Headers(),
        text: async () => text,
        json: async () => JSON.parse(text),
      } as unknown as NetworkResponse
    },
  } as NetworkClient
  return { client, seen }
}

const apiKey: ProviderAuth = { kind: "api-key", key: "sk-test" }
const oauth: ProviderAuth = { kind: "oauth", token: "oat-test" }
const input = {
  bytes: new TextEncoder().encode("hello"),
  filename: "a.txt",
  mimeType: "text/plain",
}

describe("buildMultipartBody", () => {
  it("builds the exact RFC 7578 bytes for one part named file", () => {
    const mp = buildMultipartBody(input, "BOUNDARY")
    expect(mp.boundary).toBe("BOUNDARY")
    expect(mp.contentType).toBe("multipart/form-data; boundary=BOUNDARY")
    expect(new TextDecoder().decode(mp.body)).toBe(
      "--BOUNDARY\r\n" +
        'Content-Disposition: form-data; name="file"; filename="a.txt"\r\n' +
        "Content-Type: text/plain\r\n\r\n" +
        "hello\r\n--BOUNDARY--\r\n",
    )
  })

  it("keeps binary bytes unchanged and escapes the filename", () => {
    const bytes = new Uint8Array([0, 255, 13, 10, 45, 45])
    const mp = buildMultipartBody({ bytes, filename: 'a"b\r\n.png', mimeType: "image/png" }, "X")
    const text = new TextDecoder("latin1").decode(mp.body)
    expect(text).toContain('filename="a%22b%0D%0A.png"')
    const start = mp.body.length - "\r\n--X--\r\n".length - bytes.length
    expect(Array.from(mp.body.slice(start, start + bytes.length))).toEqual(Array.from(bytes))
  })

  it("makes a random boundary when none is given", () => {
    const a = buildMultipartBody(input)
    const b = buildMultipartBody(input)
    expect(a.boundary).not.toBe(b.boundary)
    expect(a.boundary).toMatch(/^----minimal-agent-[0-9a-f]{24}$/)
  })

  it("parses back with the platform multipart reader", async () => {
    const mp = buildMultipartBody(input, "PARSEME")
    const form = await new Response(mp.body as Uint8Array<ArrayBuffer>, {
      headers: { "content-type": mp.contentType },
    }).formData()
    const file = form.get("file") as File
    expect(file.name).toBe("a.txt")
    expect(file.type.startsWith("text/plain")).toBe(true)
    expect(await file.text()).toBe("hello")
  })
})

describe("uploadAnthropicFile", () => {
  it("POSTs multipart to /v1/files with x-api-key and no beta header", async () => {
    const { client, seen } = fake(200, META)
    const meta = await uploadAnthropicFile(input, {
      auth: apiKey,
      networkClient: client,
      sessionId: "s1",
    })
    expect(meta).toEqual(META as typeof meta)
    const r = seen[0]!
    expect(r.method).toBe("POST")
    expect(r.url).toBe("https://api.anthropic.com/v1/files")
    expect(r.headers?.["x-api-key"]).toBe("sk-test")
    expect(r.headers?.["anthropic-beta"]).toBeUndefined()
    expect(r.headers?.["authorization"]).toBeUndefined()
    expect(r.headers?.["content-encoding"]).toBeUndefined()
    const ct = r.headers?.["content-type"] ?? ""
    expect(ct).toMatch(/^multipart\/form-data; boundary=/)
    const boundary = ct.split("boundary=")[1]!
    expect(new TextDecoder().decode(r.body as Uint8Array)).toContain(`--${boundary}--\r\n`)
  })

  it("sends only the oauth beta for OAuth, never the files beta", async () => {
    const { client, seen } = fake(200, META)
    await uploadAnthropicFile(input, { auth: oauth, networkClient: client, sessionId: "s1" })
    const h = seen[0]!.headers ?? {}
    expect(h["authorization"]).toBe("Bearer oat-test")
    expect(h["anthropic-beta"]).toBe("oauth-2025-04-20")
    expect(JSON.stringify(h)).not.toContain("files-api")
    expect(h["x-api-key"]).toBeUndefined()
  })

  it("maps a non-2xx answer to AnthropicFilesError with status and type", async () => {
    const body = { type: "error", error: { type: "request_too_large", message: "too big" } }
    const { client } = fake(413, body)
    const err = await uploadAnthropicFile(input, {
      auth: apiKey,
      networkClient: client,
      sessionId: "s1",
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AnthropicFilesError)
    expect((err as AnthropicFilesError).status).toBe(413)
    expect((err as AnthropicFilesError).errorType).toBe("request_too_large")
    expect((err as Error).message).toContain("too big")
  })

  it("maps a transport failure to status 0", async () => {
    const { client } = fake(200, META, new Error("ECONNRESET"))
    const err = (await uploadAnthropicFile(input, {
      auth: apiKey,
      networkClient: client,
      sessionId: "s1",
    }).catch((e: unknown) => e)) as AnthropicFilesError
    expect(err.status).toBe(0)
    expect(err.message).toContain("ECONNRESET")
  })

  it("rejects a 200 answer with no file id", async () => {
    const { client } = fake(200, { type: "file" })
    const err = (await uploadAnthropicFile(input, {
      auth: apiKey,
      networkClient: client,
      sessionId: "s1",
    }).catch((e: unknown) => e)) as AnthropicFilesError
    expect(err.status).toBe(0)
  })
})

describe("getAnthropicFile / deleteAnthropicFile", () => {
  it("GETs metadata by id", async () => {
    const { client, seen } = fake(200, META)
    const meta = await getAnthropicFile(META.id, {
      auth: oauth,
      networkClient: client,
      sessionId: "s",
    })
    expect(seen[0]!.method).toBe("GET")
    expect(seen[0]!.url).toBe(`${FILES_URL}/${META.id}`)
    expect(seen[0]!.body).toBeUndefined()
    expect(meta.expires_at).toBeNull()
  })

  it("DELETEs by id and parses file_deleted", async () => {
    const { client, seen } = fake(200, { id: META.id, type: "file_deleted" })
    const out = await deleteAnthropicFile(META.id, {
      auth: apiKey,
      networkClient: client,
      sessionId: "s",
    })
    expect(seen[0]!.method).toBe("DELETE")
    expect(seen[0]!.url).toBe(`${FILES_URL}/${META.id}`)
    expect(seen[0]!.headers?.["content-type"]).toBeUndefined()
    expect(out).toEqual({ id: META.id, type: "file_deleted" })
  })

  it("maps a 404 not_found_error", async () => {
    const body = { type: "error", error: { type: "not_found_error", message: "File not found." } }
    const { client } = fake(404, body)
    const err = (await deleteAnthropicFile("file_x", {
      auth: apiKey,
      networkClient: client,
      sessionId: "s",
    }).catch((e: unknown) => e)) as AnthropicFilesError
    expect(err.status).toBe(404)
    expect(err.errorType).toBe("not_found_error")
  })

  it("DELETE with OAuth sends only the oauth beta and the bearer", async () => {
    const { client, seen } = fake(200, { id: META.id, type: "file_deleted" })
    await deleteAnthropicFile(META.id, { auth: oauth, networkClient: client, sessionId: "s" })
    const h = seen[0]!.headers ?? {}
    expect(h["anthropic-beta"]).toBe("oauth-2025-04-20")
    expect(h["authorization"]).toBe("Bearer oat-test")
    expect(JSON.stringify(h)).not.toContain("files-api")
  })
})

describe("expires_in_seconds form field", () => {
  it("adds a clamped expires_in_seconds part before the file part", async () => {
    const mp = buildMultipartBody({ ...input, expiresInSeconds: 86_400 }, "B")
    const text = new TextDecoder().decode(mp.body)
    expect(
      text.startsWith(
        '--B\r\nContent-Disposition: form-data; name="expires_in_seconds"\r\n\r\n86400\r\n',
      ),
    ).toBe(true)
    const form = await new Response(mp.body as Uint8Array<ArrayBuffer>, {
      headers: { "content-type": mp.contentType },
    }).formData()
    expect(form.get("expires_in_seconds")).toBe("86400")
    expect(await (form.get("file") as File).text()).toBe("hello")
  })

  it("clamps to 3600..7776000 and omits the field when absent", () => {
    expect(clampExpiresInSeconds(10)).toBe(MIN_EXPIRES_IN_SECONDS)
    expect(clampExpiresInSeconds(1e12)).toBe(MAX_EXPIRES_IN_SECONDS)
    expect(clampExpiresInSeconds(7200.4)).toBe(7200)
    expect(new TextDecoder().decode(buildMultipartBody(input, "B").body)).not.toContain(
      "expires_in_seconds",
    )
  })
})

describe("buildFilesHeaders: custom auth", () => {
  it("drops content-type and anthropic-beta in any case, keeps custom beta flags", () => {
    const h = buildFilesHeaders({
      auth: {
        kind: "custom",
        headers: { "Content-Type": "text/x", "X-Gateway-Key": "g1", "Anthropic-Beta": "gw-beta-1" },
      },
      networkClient: {} as NetworkClient,
      sessionId: "s",
    })
    const lower = Object.keys(h).map((k) => k.toLowerCase())
    expect(lower.filter((k) => k === "content-type")).toEqual([])
    expect(lower.filter((k) => k === "anthropic-beta")).toEqual(["anthropic-beta"])
    expect(h["Anthropic-Beta"]).toBe("gw-beta-1")
    expect(h["X-Gateway-Key"]).toBe("g1")
  })
})
