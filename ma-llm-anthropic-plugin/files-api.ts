/**
 * Anthropic Files API client (GA): upload, metadata, and delete.
 *
 * - Upload: `POST /v1/files`, multipart/form-data with one part named `file`.
 * - Metadata: `GET /v1/files/{file_id}`.
 * - Delete: `DELETE /v1/files/{file_id}`.
 *
 * The API is GA, so no `files-api-2025-04-14` beta header is sent
 * (https://docs.claude.com/en/release-notes/overview, 2026-08-19 entry). OAuth
 * still needs `anthropic-beta: oauth-2025-04-20`. Requests go through the
 * host `NetworkClient`, and the multipart body is built by hand because
 * `NetworkRequest.body` is `string | Uint8Array`.
 *
 * Docs: https://docs.claude.com/en/docs/build-with-claude/files and
 * https://docs.claude.com/en/api/files/upload.
 *
 * @module llm-anthropic/files-api
 */

import { randomBytes } from "node:crypto"

import type { CanonicalRequest } from "@minimal-agent/core/plugin-api/llm/canonical-request"
import type { ProviderAuth } from "@minimal-agent/core/plugin-api/llm/provider-auth"
import type { NetworkClient } from "@minimal-agent/core/plugin-api/net/types"

import { ANTHROPIC_BETA_FLAGS } from "./beta-flags.ts"
import { buildAnthropicHeaders } from "./headers.ts"
import type { ModelEntry } from "./lib/host-types.ts"

/** Files API base URL (first-party API only). */
export const FILES_URL = "https://api.anthropic.com/v1/files"

/** GA file metadata, as `POST /v1/files` and `GET /v1/files/{id}` return it. */
export interface AnthropicFileMetadata {
  id: string
  type: "file"
  filename: string
  mime_type: string
  size_bytes: number
  created_at: string
  downloadable?: boolean
  expires_at?: string | null
}

/** Dependencies of a Files API call. */
export interface FilesApiDeps {
  auth: ProviderAuth
  networkClient: NetworkClient
  sessionId: string
  signal?: AbortSignal
}

/** One file to upload. */
export interface FileUploadInput {
  bytes: Uint8Array
  filename: string
  mimeType: string
  /**
   * Optional `expires_in_seconds` form field. Clamped to
   * {@link MIN_EXPIRES_IN_SECONDS}..{@link MAX_EXPIRES_IN_SECONDS}
   * (https://docs.claude.com/en/api/files/upload).
   */
  expiresInSeconds?: number
}

/** Lowest `expires_in_seconds` the API accepts (one hour). */
export const MIN_EXPIRES_IN_SECONDS = 3600
/** Highest `expires_in_seconds` the API accepts (ninety days). */
export const MAX_EXPIRES_IN_SECONDS = 7_776_000

/**
 * Clamp an expiry to the accepted range and round it to whole seconds.
 *
 * @param seconds - The wanted expiry in seconds.
 * @returns The clamped integer value.
 */
export function clampExpiresInSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return MAX_EXPIRES_IN_SECONDS
  return Math.min(MAX_EXPIRES_IN_SECONDS, Math.max(MIN_EXPIRES_IN_SECONDS, Math.round(seconds)))
}

/** A non-2xx Files API answer, or a transport failure (`status` 0). */
export class AnthropicFilesError extends Error {
  /** HTTP status, or 0 for a network failure or a bad response body. */
  readonly status: number
  /** Upstream `error.type` (for example `not_found_error`), when present. */
  readonly errorType: string | undefined

  /**
   * Make a Files API error.
   *
   * @param status - HTTP status, or 0 for a transport failure.
   * @param errorType - Upstream `error.type`, when the body has one.
   * @param message - Error message.
   * @param options - Standard error options (cause).
   */
  constructor(
    status: number,
    errorType: string | undefined,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "AnthropicFilesError"
    this.status = status
    this.errorType = errorType
  }
}

// ---------------------------------------------------------------------------
// Multipart
// ---------------------------------------------------------------------------

/** The multipart body plus the matching `content-type` header value. */
export interface MultipartBody {
  body: Uint8Array
  boundary: string
  contentType: string
}

/**
 * Escape a filename for a `Content-Disposition` quoted string, the way the
 * WHATWG multipart encoder does: `"` to `%22`, CR to `%0D`, LF to `%0A`.
 */
function escapeFilename(name: string): string {
  return name.replace(/"/g, "%22").replace(/\r/g, "%0D").replace(/\n/g, "%0A")
}

/**
 * Build a multipart/form-data body with ONE part named `file` (RFC 7578).
 * Pure: the same input and boundary give the same bytes.
 *
 * @param input - The file bytes, filename, and MIME type of the part.
 * @param boundary - The boundary token. A random one is made when absent.
 * @returns The body bytes, the boundary, and the `content-type` header value.
 */
export function buildMultipartBody(input: FileUploadInput, boundary?: string): MultipartBody {
  const b = boundary ?? `----minimal-agent-${randomBytes(12).toString("hex")}`
  const enc = new TextEncoder()
  const expiry =
    input.expiresInSeconds === undefined
      ? ""
      : `--${b}\r\nContent-Disposition: form-data; name="expires_in_seconds"\r\n\r\n` +
        `${clampExpiresInSeconds(input.expiresInSeconds)}\r\n`
  const head = enc.encode(
    expiry +
      `--${b}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${escapeFilename(input.filename)}"\r\n` +
      `Content-Type: ${input.mimeType}\r\n\r\n`,
  )
  const tail = enc.encode(`\r\n--${b}--\r\n`)
  const body = new Uint8Array(head.length + input.bytes.length + tail.length)
  body.set(head, 0)
  body.set(input.bytes, head.length)
  body.set(tail, head.length + input.bytes.length)
  return { body, boundary: b, contentType: `multipart/form-data; boundary=${b}` }
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

/**
 * Neutral model stub for the header builder. The probe-shaped request below
 * classifies as `quota`, so the builder reads only `id` (no capabilities).
 */
const STUB_MODEL = {
  id: "claude-files",
  providerId: "anthropic",
  surfaceId: "anthropic-messages",
  displayName: "Files API",
} as unknown as ModelEntry

/**
 * Headers for a Files API call: the Messages header set minus the Messages
 * beta flags. OAuth keeps only `oauth-2025-04-20` (live verified, R1 call 1).
 */
export function buildFilesHeaders(deps: FilesApiDeps): Record<string, string> {
  const req: CanonicalRequest = {
    modelId: STUB_MODEL.id,
    messages: [{ role: "user", content: [{ type: "text", text: "" }] }],
    generation: { maxOutputTokens: 1 },
  }
  const { headers } = buildAnthropicHeaders({
    req,
    model: STUB_MODEL,
    auth: deps.auth,
    sessionId: deps.sessionId,
  })
  deleteHeader(headers, "content-type")
  deleteHeader(headers, "anthropic-beta")
  if (deps.auth.kind === "oauth") headers["anthropic-beta"] = ANTHROPIC_BETA_FLAGS.OAUTH
  else if (deps.auth.kind === "custom") {
    // Keep the beta flags the custom auth itself sets (a gateway may need them).
    for (const [k, v] of Object.entries(deps.auth.headers)) {
      if (k.toLowerCase() === "anthropic-beta") headers[k] = v
    }
  }
  return headers
}

/** Remove every key of `headers` that equals `name` without regard to case. */
function deleteHeader(headers: Record<string, string>, name: string): void {
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === name) delete headers[k]
  }
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/** Read `error.type` and `error.message` from an Anthropic error body. */
function parseErrorBody(text: string): { type?: string; message?: string } {
  try {
    const parsed = JSON.parse(text) as { error?: { type?: unknown; message?: unknown } }
    const type = typeof parsed?.error?.type === "string" ? parsed.error.type : undefined
    const message = typeof parsed?.error?.message === "string" ? parsed.error.message : undefined
    return { type, message }
  } catch {
    return {}
  }
}

/** Send one request and return the parsed JSON, or throw {@link AnthropicFilesError}. */
async function callFiles<T>(
  deps: FilesApiDeps,
  label: string,
  method: "GET" | "POST" | "DELETE",
  url: string,
  extra?: { body: Uint8Array; contentType: string },
): Promise<T> {
  const headers = buildFilesHeaders(deps)
  if (extra) headers["content-type"] = extra.contentType
  let response: Awaited<ReturnType<NetworkClient["request"]>>
  try {
    response = await deps.networkClient.request({
      label,
      method,
      url,
      headers,
      ...(extra ? { body: extra.body } : {}),
      signal: deps.signal,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new AnthropicFilesError(0, undefined, `Anthropic Files API request failed: ${msg}`, {
      cause: err,
    })
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    const parsed = parseErrorBody(text)
    const detail = parsed.message ?? text.slice(0, 200)
    throw new AnthropicFilesError(
      response.status,
      parsed.type,
      `Anthropic Files API ${response.status}${parsed.type ? ` ${parsed.type}` : ""}: ${detail}`,
    )
  }
  try {
    return (await response.json()) as T
  } catch (err) {
    throw new AnthropicFilesError(0, undefined, "Anthropic Files API: response is not JSON", {
      cause: err,
    })
  }
}

/**
 * Check that a parsed upload or metadata answer has the GA shape.
 *
 * @param raw - Parsed JSON from the API.
 * @returns The metadata.
 */
function toMetadata(raw: unknown): AnthropicFileMetadata {
  const m = raw as Partial<AnthropicFileMetadata> | null
  if (!m || typeof m.id !== "string" || m.id.length === 0) {
    throw new AnthropicFilesError(0, undefined, "Anthropic Files API: response has no file id")
  }
  return {
    id: m.id,
    type: "file",
    filename: typeof m.filename === "string" ? m.filename : "",
    mime_type: typeof m.mime_type === "string" ? m.mime_type : "",
    size_bytes: typeof m.size_bytes === "number" ? m.size_bytes : 0,
    created_at: typeof m.created_at === "string" ? m.created_at : "",
    ...(typeof m.downloadable === "boolean" ? { downloadable: m.downloadable } : {}),
    ...(m.expires_at !== undefined ? { expires_at: m.expires_at } : {}),
  }
}

/**
 * Upload one file. `POST /v1/files` with a multipart body.
 *
 * @param input - The file bytes, filename, and MIME type.
 * @param deps - Auth, network client, session id, and an optional signal.
 * @returns The GA file metadata.
 */
export async function uploadAnthropicFile(
  input: FileUploadInput,
  deps: FilesApiDeps,
): Promise<AnthropicFileMetadata> {
  const mp = buildMultipartBody(input)
  const raw = await callFiles<unknown>(deps, "files.upload", "POST", FILES_URL, {
    body: mp.body,
    contentType: mp.contentType,
  })
  return toMetadata(raw)
}

/**
 * Read the metadata of one file. `GET /v1/files/{file_id}`.
 *
 * @param id - The file id.
 * @param deps - Auth, network client, and session id.
 * @returns The GA file metadata.
 */
export async function getAnthropicFile(
  id: string,
  deps: FilesApiDeps,
): Promise<AnthropicFileMetadata> {
  const url = `${FILES_URL}/${encodeURIComponent(id)}`
  return toMetadata(await callFiles<unknown>(deps, "files.get", "GET", url))
}

/**
 * Delete one file. `DELETE /v1/files/{file_id}`.
 *
 * @param id - The file id.
 * @param deps - Auth, network client, and session id.
 * @returns The deleted id and `type: "file_deleted"`.
 */
export async function deleteAnthropicFile(
  id: string,
  deps: FilesApiDeps,
): Promise<{ id: string; type: string }> {
  const url = `${FILES_URL}/${encodeURIComponent(id)}`
  const raw = await callFiles<{ id?: unknown; type?: unknown }>(deps, "files.delete", "DELETE", url)
  return {
    id: typeof raw?.id === "string" ? raw.id : id,
    type: typeof raw?.type === "string" ? raw.type : "file_deleted",
  }
}
