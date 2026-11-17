/**
 * Lazy Files API upload for inline media in an outgoing Messages call.
 *
 * Anthropic is the first implementation of the core provider-neutral
 * `ProviderFileStore` contract (`@minimal-agent/core/plugin-api/llm/file-uploads`).
 * {@link createAnthropicFileStore} wraps the Files API client
 * (`files-api.ts`). The shared core pass `prepareFileUploads` does the rest:
 * it finds each base64 image or document whose decoded size is at least the
 * threshold (10 bytes by default, env `MINIMAL_AGENT_FILES_API_THRESHOLD_BYTES`),
 * uploads it once, and swaps the source to `{kind:"file_id"}` in a COPY of the
 * request. Images inside a `tool_result` are uploaded too. The canonical
 * messages (and so the transcript) keep the base64, so a file id is never
 * persisted.
 *
 * Accepted types: the formats that the model accepts (its resolved
 * `inputMimeTypes`) and that the Files API can serve to a Messages block:
 * jpeg/png/gif/webp images, PDF, and text-like documents (txt, md, csv, json,
 * code). A text-like document uploads as `text/plain`.
 *
 * Cache (core): keyed by store id, credential identity (see
 * {@link credentialIdentity}) and the sha256 of the bytes. The value is the
 * upload promise, so concurrent sends of the same bytes share one upload. Any
 * upload error keeps the inline base64. A 400, 413 or 415 is sticky (the item
 * stays inline for good). A 401, 403 or 404 disables uploads for the
 * credential. This plugin holds its own cache instance.
 *
 * Expiry: each upload sends `expires_in_seconds`
 * ({@link ANTHROPIC_UPLOAD_EXPIRES_IN_SECONDS}, 24 h by default), so user
 * media does not stay in the workspace for good
 * (https://docs.claude.com/en/api/files/upload).
 *
 * Prompt-cache trade-off (accepted, not fixed): the choice between inline
 * base64 and `file_id` is not sticky per session. A transient upload failure
 * sends one turn inline and a later turn with a `file_id`. A process restart
 * uploads again and gets a new id. A 404 retry sends the evicted items inline.
 * Each such flip changes the request prefix, so the prompt cache misses from
 * that block on. The negative cache of 400, 413 and 415 removes the most
 * frequent flip. A sticky choice needs session state in core (deferred).
 *
 * @module llm-anthropic/media-upload
 */

import { createHash } from "node:crypto"

import type { CanonicalRequest } from "@minimal-agent/core/plugin-api/llm/canonical-request"
import {
  createFileUploadCache,
  type PreparedFileUploads,
  type ProviderFileStore,
  prepareFileUploads,
  retryAfterMissingFile,
  type UploadedFile,
} from "@minimal-agent/core/plugin-api/llm/file-uploads"
import { isTextLikeMime } from "@minimal-agent/core/plugin-api/llm/modality-check"
import type { ProviderAuth, RunContext } from "@minimal-agent/core/plugin-api/llm/provider-auth"
import type { NetworkClient } from "@minimal-agent/core/plugin-api/net/types"

import {
  AnthropicFilesError,
  clampExpiresInSeconds,
  deleteAnthropicFile,
  type FilesApiDeps,
  getAnthropicFile,
  uploadAnthropicFile,
} from "./files-api.ts"
import type { ModelEntry } from "./lib/host-types.ts"
import { ANTHROPIC_IMAGE_MIME_TYPES, anthropicInputMimeTypes } from "./media-limits.ts"

/**
 * Default upload threshold: inline media of 10 bytes or more (decoded) is
 * uploaded, so in practice every image and document goes through the Files
 * API. Override with {@link ANTHROPIC_UPLOAD_THRESHOLD_ENV}.
 */
export const ANTHROPIC_UPLOAD_THRESHOLD_BYTES = 10

/**
 * Env var that overrides the upload threshold, in decoded bytes. `0` uploads
 * every item. A very large value (for example `1048576`) keeps small media
 * inline. A value that is not a non-negative integer is ignored.
 */
export const ANTHROPIC_UPLOAD_THRESHOLD_ENV = "MINIMAL_AGENT_FILES_API_THRESHOLD_BYTES"

/**
 * The upload threshold to use: the env override when it is a non-negative
 * integer, else {@link ANTHROPIC_UPLOAD_THRESHOLD_BYTES}. Read on each call,
 * so a change to the env takes effect on the next request.
 */
export function resolveUploadThresholdBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ANTHROPIC_UPLOAD_THRESHOLD_ENV]?.trim()
  if (raw && /^\d+$/.test(raw)) {
    const n = Number(raw)
    if (Number.isSafeInteger(n)) return n
  }
  return ANTHROPIC_UPLOAD_THRESHOLD_BYTES
}

/** Default `expires_in_seconds` of an upload: 24 h (the upload cache is per process). */
export const ANTHROPIC_UPLOAD_EXPIRES_IN_SECONDS = 86_400

/** Store id: the cache namespace of this plugin's uploads. */
export const ANTHROPIC_FILE_STORE_ID = "anthropic"

/** The upload cache of this plugin (one per process). */
const uploadCache = createFileUploadCache()

/** Test seam: drop every cached upload and every disabled credential. */
export function _resetMediaUploadCacheForTest(): void {
  uploadCache.uploads.clear()
  uploadCache.disabled.clear()
}

/** Hex sha256 of a string. */
function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

/**
 * A stable identity for the credential that is not the secret: the auth kind
 * plus a hash of the key or token (and the org/project for an api key).
 *
 * OAuth: `ProviderAuth` carries no account or organization id (only the
 * access token), so the identity hashes the token. A token refresh then
 * starts a fresh cache: the same bytes upload once more. The 24 h expiry
 * bounds the cost of the orphaned file.
 *
 * @param auth - The provider auth of this call.
 * @returns The identity string.
 */
export function credentialIdentity(auth: ProviderAuth): string {
  switch (auth.kind) {
    case "api-key":
      return `api-key:${sha256(`${auth.key}\n${auth.organization ?? ""}\n${auth.project ?? ""}`)}`
    case "oauth":
      return `oauth:${sha256(auth.token)}`
    case "custom": {
      const entries = Object.entries(auth.headers).sort(([a], [b]) => a.localeCompare(b))
      return `custom:${sha256(JSON.stringify(entries))}`
    }
    default:
      throw new Error(`unhandled auth kind: ${String(auth satisfies never)}`)
  }
}

/**
 * True when a Messages error body is a `not_found_error` about a file. The
 * API says "File `file_...` not found." for a deleted or unknown id (R1 §7).
 * The body must name one of `usedIds`, or hold a token that starts with
 * `file_`. A plain word such as "profile" does not match.
 *
 * @param status - The HTTP status.
 * @param body - The response body.
 * @param usedIds - The file ids that the request used.
 * @returns True for a missing-file 404.
 */
export function isMissingFileError(
  status: number,
  body: string,
  usedIds: Iterable<string> = [],
): boolean {
  if (status !== 404 || !/not_found_error/.test(body)) return false
  for (const id of usedIds) if (body.includes(id)) return true
  return /(?<![A-Za-z0-9_])file_[A-Za-z0-9]/.test(body)
}

/**
 * True when the Files API can serve `mime` to a Messages block: an `image`
 * block (jpeg, png, gif, webp) or a `document` block (PDF, or a text-like
 * type sent as `text/plain`). Office files are not served (no
 * `container_upload` in v1).
 */
function filesApiServes(mime: string): boolean {
  const m = mime.toLowerCase()
  return ANTHROPIC_IMAGE_MIME_TYPES.has(m) || m === "application/pdf" || isTextLikeMime(m)
}

/** Parse an ISO `expires_at` to epoch ms, or undefined. */
function expiresAtMs(iso: string | null | undefined): number | undefined {
  if (!iso) return undefined
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : undefined
}

/**
 * The Anthropic {@link ProviderFileStore}: the core contract over the Files
 * API client. `accepts` reads the bound model's resolved input MIME list (the
 * `modelId` argument is not used: the store is made per call for one model).
 * Errors are {@link AnthropicFilesError} (a numeric `status`), so the core
 * pass can classify them.
 *
 * @param model - The target model (its capabilities gate the accepted types).
 * @param deps - Auth, network client and session id. The core pass gives the signal.
 * @returns The store.
 */
export function createAnthropicFileStore(
  model: Pick<ModelEntry, "capabilities">,
  deps: Omit<FilesApiDeps, "signal">,
): ProviderFileStore {
  const accepted = new Set(anthropicInputMimeTypes(model.capabilities))
  return {
    id: ANTHROPIC_FILE_STORE_ID,
    accepts(mime: string): boolean {
      const m = mime.toLowerCase()
      return accepted.has(m) && filesApiServes(m)
    },
    uploadMimeType(mime: string): string {
      return isTextLikeMime(mime) ? "text/plain" : mime
    },
    async upload(input): Promise<UploadedFile> {
      const meta = await uploadAnthropicFile(
        {
          bytes: input.bytes,
          filename: input.filename,
          mimeType: input.mimeType,
          expiresInSeconds: clampExpiresInSeconds(input.expiresInSeconds),
        },
        { ...deps, signal: input.signal },
      )
      const expiresAt = expiresAtMs(meta.expires_at)
      return expiresAt === undefined ? { id: meta.id } : { id: meta.id, expiresAt }
    },
    async metadata(id: string, signal?: AbortSignal): Promise<UploadedFile | null> {
      try {
        const meta = await getAnthropicFile(id, { ...deps, signal })
        const expiresAt = expiresAtMs(meta.expires_at)
        return expiresAt === undefined ? { id: meta.id } : { id: meta.id, expiresAt }
      } catch (err) {
        if (err instanceof AnthropicFilesError && err.status === 404) return null
        throw err
      }
    },
    async delete(id: string, signal?: AbortSignal): Promise<void> {
      await deleteAnthropicFile(id, { ...deps, signal })
    },
    isMissingFileError,
  }
}

/** Options of {@link prepareMediaUploads}. */
export interface MediaUploadOptions {
  /** Decoded-size threshold in bytes. Defaults to {@link resolveUploadThresholdBytes}. */
  thresholdBytes?: number
  /** Upload expiry. Defaults to {@link ANTHROPIC_UPLOAD_EXPIRES_IN_SECONDS}, clamped to 3600..7776000. */
  expiresInSeconds?: number
}

/** The wire copy of the request, the file ids it uses, and the store that made them. */
export interface PreparedUploads extends PreparedFileUploads {
  store: ProviderFileStore
}

/**
 * Upload qualifying inline media and return a wire copy of the request with
 * `file_id` sources. The input request is never changed. Never throws for an
 * upload failure: the item stays inline. Throws only when `req.signal` aborts.
 *
 * @param req - The canonical request (not mutated).
 * @param model - The target model (its input MIME list gates the uploads).
 * @param ctx - The run context (auth, session id, debug sink).
 * @param networkClient - The host network client.
 * @param opts - Threshold and expiry overrides.
 * @returns The wire request, the file ids it uses, and the store.
 */
export async function prepareMediaUploads(
  req: CanonicalRequest,
  model: Pick<ModelEntry, "id" | "capabilities">,
  ctx: RunContext,
  networkClient: NetworkClient,
  opts: MediaUploadOptions = {},
): Promise<PreparedUploads> {
  const store = createAnthropicFileStore(model, {
    auth: ctx.auth,
    networkClient,
    sessionId: ctx.sessionId,
  })
  const prepared = await prepareFileUploads(req, store, {
    credential: credentialIdentity(ctx.auth),
    thresholdBytes: opts.thresholdBytes ?? resolveUploadThresholdBytes(),
    expiresInSeconds: clampExpiresInSeconds(
      opts.expiresInSeconds ?? ANTHROPIC_UPLOAD_EXPIRES_IN_SECONDS,
    ),
    modelId: model.id,
    cache: uploadCache,
    onError: (err) =>
      ctx.debug?.kv("files.upload.error", err instanceof Error ? err.message : String(err)),
  })
  return { ...prepared, store }
}

/**
 * One step of 404 evict-and-retry: when a Messages error is a missing-file
 * 404 for a file id of the request, evict those ids from the upload cache
 * and return the retry request (only the evicted items go back inline).
 * Else null.
 *
 * @param original - The canonical request (base64 sources).
 * @param prepared - The result of {@link prepareMediaUploads}.
 * @param status - The HTTP status of the Messages call.
 * @param body - The error response body.
 * @returns The retry request, or null.
 */
export function retryInlineAfterMissingFile(
  original: CanonicalRequest,
  prepared: PreparedUploads,
  status: number,
  body: string,
): CanonicalRequest | null {
  return retryAfterMissingFile(original, prepared, prepared.store, status, body)
}
