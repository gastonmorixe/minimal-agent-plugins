/**
 * Lazy Files API upload for inline media in an outgoing Messages call.
 *
 * Before the adapter encodes a request, {@link prepareMediaUploads} finds each
 * base64 image or document whose decoded size is at least the threshold
 * (10 bytes by default, env `MINIMAL_AGENT_FILES_API_THRESHOLD_BYTES`),
 * uploads it once through the Files API, and swaps the source to
 * `{kind:"file_id"}` in a COPY of the request. The canonical messages (and so
 * the transcript) keep the base64, so a file id is never persisted.
 *
 * Cache: a process-wide map keyed by credential identity plus the sha256 of
 * the bytes. The value is the upload promise, so concurrent sends of the same
 * bytes share one upload. Any upload error keeps the inline base64.
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

import type {
  CanonicalBlock,
  CanonicalMessage,
} from "@minimal-agent/core/plugin-api/llm/canonical-messages"
import type { CanonicalRequest } from "@minimal-agent/core/plugin-api/llm/canonical-request"
import type { ProviderAuth, RunContext } from "@minimal-agent/core/plugin-api/llm/provider-auth"
import type { NetworkClient } from "@minimal-agent/core/plugin-api/net/types"

import { AnthropicFilesError, clampExpiresInSeconds, uploadAnthropicFile } from "./files-api.ts"

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

/** Image MIME types the Files API serves to an `image` block (R1 §3). */
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])

/** Upload statuses that will not change on a retry: the item stays inline for good. */
const STICKY_INLINE_STATUSES = new Set([400, 413, 415])

/** Cache value: the uploaded file id, or null when the upload failed for good. */
type CacheEntry = Promise<string | null>

/** Upload cache: key is the credential identity, a colon, and the sha256 hex. Value: the upload promise. */
const uploadCache = new Map<string, CacheEntry>()

/** Credential identities for which the Files API refused auth or is absent. */
const disabledCredentials = new Set<string>()

/** Max entries of the sha memo. Each entry holds a reference to one base64 string. */
const SHA_MEMO_CAP = 32

/** Memo: base64 data string to the sha256 hex of its decoded bytes (small LRU). */
const shaMemo = new Map<string, string>()

/** Test seam: drop every cached upload, every disabled credential, and the sha memo. */
export function _resetMediaUploadCacheForTest(): void {
  uploadCache.clear()
  disabledCredentials.clear()
  shaMemo.clear()
}

/** Hex sha256 of a string or bytes. */
function sha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex")
}

/** Decoded bytes of a base64 string. A Buffer is a Uint8Array, so no copy is made. */
function decodeBase64(data: string): Uint8Array {
  return Buffer.from(data, "base64")
}

/**
 * The sha256 of the decoded bytes of `data`, from the memo when possible.
 * On a memo miss, the decoded bytes are returned too so the caller does not
 * decode again.
 */
function shaOf(data: string): { sha: string; bytes?: Uint8Array } {
  const hit = shaMemo.get(data)
  if (hit !== undefined) {
    // Refresh the LRU position.
    shaMemo.delete(data)
    shaMemo.set(data, hit)
    return { sha: hit }
  }
  const bytes = decodeBase64(data)
  const sha = sha256(bytes)
  shaMemo.set(data, sha)
  if (shaMemo.size > SHA_MEMO_CAP) {
    const oldest = shaMemo.keys().next().value
    if (oldest !== undefined) shaMemo.delete(oldest)
  }
  return { sha, bytes }
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

/** Decoded byte count of a base64 string, without decoding it. */
function base64DecodedSize(data: string): number {
  const len = data.length
  if (len === 0) return 0
  const pad = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0
  return Math.floor((len * 3) / 4) - pad
}

/** File extension for a generated upload filename. */
function extensionFor(mime: string): string {
  const sub = mime.split("/")[1] ?? "bin"
  if (sub === "jpeg") return "jpg"
  if (sub === "plain") return "txt"
  return sub.replace(/[^a-z0-9]/gi, "") || "bin"
}

/** One inline media item that qualifies for upload. */
interface Candidate {
  data: string
  mimeType: string
  filename?: string
}

/** The upload MIME type for a block, or undefined when the block does not qualify. */
function uploadMime(block: CanonicalBlock): Candidate | undefined {
  if (block.type === "image" && block.source.kind === "base64") {
    const mime = block.source.mediaType.toLowerCase()
    return IMAGE_TYPES.has(mime) ? { data: block.source.data, mimeType: mime } : undefined
  }
  if (block.type === "file" && block.source.kind === "base64") {
    const mime = block.source.mediaType.toLowerCase()
    const filename = block.source.filename
    if (mime === "application/pdf") return { data: block.source.data, mimeType: mime, filename }
    if (mime.startsWith("text/"))
      return { data: block.source.data, mimeType: "text/plain", filename }
  }
  return undefined
}

/** Options of {@link prepareMediaUploads}. */
export interface MediaUploadOptions {
  /** Decoded-size threshold in bytes. Defaults to {@link resolveUploadThresholdBytes}. */
  thresholdBytes?: number
  /** Upload expiry. Defaults to {@link ANTHROPIC_UPLOAD_EXPIRES_IN_SECONDS}, clamped to 3600..7776000. */
  expiresInSeconds?: number
}

/** A file id that the wire request uses: its cache key and the cache entry that made it. */
export interface UsedFile {
  key: string
  entry: CacheEntry
}

/** The wire copy of the request plus the cache keys of every file id it uses. */
export interface PreparedUploads {
  req: CanonicalRequest
  /** Map from file id to its cache key and entry, for eviction after a Messages 404. */
  used: Map<string, UsedFile>
}

/** True when an error (or its cause) is an abort. */
function isAbortError(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e instanceof Error && i < 4; e = e.cause, i++) {
    if (e.name === "AbortError") return true
  }
  return false
}

/** The error to rethrow for an abort: the inner AbortError when there is one. */
function abortErrorOf(err: unknown): unknown {
  for (let e: unknown = err, i = 0; e instanceof Error && i < 4; e = e.cause, i++) {
    if (e.name === "AbortError") return e
  }
  return err
}

/** Delete a cache entry only when it is still the given promise. */
function deleteIfSame(key: string, entry: CacheEntry): void {
  if (uploadCache.get(key) === entry) uploadCache.delete(key)
}

/** One upload job: the item, its sha, and its bytes when they are already decoded. */
interface UploadJob {
  key: string
  cand: Candidate
  sha: string
  bytes: Uint8Array | undefined
}

/** Shared per-call state of {@link uploadOnce}. */
interface UploadCallState {
  ident: string
  ctx: RunContext
  networkClient: NetworkClient
  signal: AbortSignal | undefined
  expiresInSeconds: number
}

/**
 * Upload one item (or join an in-flight upload) and return the cache entry.
 * The entry resolves to the file id, or null for a failure (inline fallback).
 * It rejects only for an abort, and an aborted entry is never left in the cache.
 */
function uploadOnce(job: UploadJob, st: UploadCallState): CacheEntry {
  const cached = uploadCache.get(job.key)
  if (cached) return cached
  const { cand, sha } = job
  const filename = cand.filename ?? `ma-${sha.slice(0, 16)}.${extensionFor(cand.mimeType)}`
  const bytes = job.bytes ?? decodeBase64(cand.data)
  const p: CacheEntry = uploadAnthropicFile(
    { bytes, filename, mimeType: cand.mimeType, expiresInSeconds: st.expiresInSeconds },
    {
      auth: st.ctx.auth,
      networkClient: st.networkClient,
      sessionId: st.ctx.sessionId,
      signal: st.signal,
    },
  ).then(
    (meta) => meta.id,
    (err: unknown) => {
      if (isAborted(st.signal) || isAbortError(err)) {
        deleteIfSame(job.key, p)
        throw abortErrorOf(err)
      }
      const status = err instanceof AnthropicFilesError ? err.status : 0
      st.ctx.debug?.kv("files.upload.error", err instanceof Error ? err.message : String(err))
      // Auth or endpoint refused: stop trying for this credential. 400, 413,
      // 415: this item stays inline for good. Network / 5xx: retry on a later turn.
      if (status === 401 || status === 403 || status === 404) disabledCredentials.add(st.ident)
      if (!STICKY_INLINE_STATUSES.has(status)) deleteIfSame(job.key, p)
      return null
    },
  )
  uploadCache.set(job.key, p)
  return p
}

/**
 * Wait for one job. An abort of THIS call rethrows. An abort that came from
 * another caller that owned the shared upload starts one fresh upload.
 */
async function settle(
  job: UploadJob,
  entry: CacheEntry,
  st: UploadCallState,
): Promise<string | null> {
  try {
    return await entry
  } catch (err) {
    if (isAborted(st.signal)) throw err
    try {
      return await uploadOnce(job, st)
    } catch (again) {
      if (isAborted(st.signal)) throw again
      return null
    }
  }
}

/** True when the signal is present and aborted (read fresh on each call). */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/**
 * Upload qualifying inline media and return a wire copy of the request with
 * `file_id` sources. The input request is never changed. Never throws for an
 * upload failure: the item stays inline. Throws only when `req.signal` aborts.
 *
 * @param req - The canonical request (not mutated).
 * @param ctx - The run context (auth, session id, debug sink).
 * @param networkClient - The host network client.
 * @param opts - Threshold and expiry overrides.
 * @returns The wire request and the file ids it uses.
 */
export async function prepareMediaUploads(
  req: CanonicalRequest,
  ctx: RunContext,
  networkClient: NetworkClient,
  opts: MediaUploadOptions = {},
): Promise<PreparedUploads> {
  const used = new Map<string, UsedFile>()
  const threshold = opts.thresholdBytes ?? resolveUploadThresholdBytes()
  const ident = credentialIdentity(ctx.auth)
  if (disabledCredentials.has(ident)) return { req, used }
  const st: UploadCallState = {
    ident,
    ctx,
    networkClient,
    signal: req.signal,
    expiresInSeconds: clampExpiresInSeconds(
      opts.expiresInSeconds ?? ANTHROPIC_UPLOAD_EXPIRES_IN_SECONDS,
    ),
  }

  const jobs = new Map<string, { job: UploadJob; entry: CacheEntry }>()
  const keyOf = (block: CanonicalBlock): string | undefined => {
    const cand = uploadMime(block)
    if (!cand || base64DecodedSize(cand.data) < threshold) return undefined
    const { sha, bytes } = shaOf(cand.data)
    const key = `${ident}:${sha}`
    if (!jobs.has(key)) {
      const job: UploadJob = { key, cand, sha, bytes }
      jobs.set(key, { job, entry: uploadOnce(job, st) })
    }
    return key
  }
  // Pass 1: start every upload (deduped by key). Pass 2: swap sources.
  const keys = new Map<CanonicalBlock, string>()
  for (const msg of req.messages) {
    for (const block of msg.content) {
      const k = keyOf(block)
      if (k) keys.set(block, k)
      if (block.type === "tool_result") {
        for (const inner of block.content) {
          const ik = keyOf(inner)
          if (ik) keys.set(inner, ik)
        }
      }
    }
  }
  if (keys.size === 0) return { req, used }
  const ids = new Map<string, string | null>()
  const settled = await Promise.allSettled(
    [...jobs].map(async ([key, { job, entry }]) => {
      ids.set(key, await settle(job, entry, st))
    }),
  )
  for (const r of settled) if (r.status === "rejected") throw r.reason

  const swap = <B extends CanonicalBlock>(block: B): B => {
    const key = keys.get(block)
    const id = key ? ids.get(key) : undefined
    if (!key || !id) return block
    const entry = uploadCache.get(key)
    if (entry) used.set(id, { key, entry })
    return { ...block, source: { kind: "file_id", fileId: id } } as B
  }
  const messages: CanonicalMessage[] = req.messages.map((msg) => ({
    ...msg,
    content: msg.content.map((block) =>
      block.type === "tool_result" ? { ...block, content: block.content.map(swap) } : swap(block),
    ),
  }))
  if (used.size === 0) return { req, used }
  return { req: { ...req, messages }, used }
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
 * Drop the cache entries of file ids named in a 404 body. When the body names
 * none of them, drop every entry the request used. An entry is dropped only
 * when the cache still holds the same promise (a newer upload is kept).
 *
 * @param used - The used files, from {@link prepareMediaUploads}.
 * @param body - The 404 response body.
 * @returns The evicted file ids.
 */
export function evictMissingFiles(used: Map<string, UsedFile>, body: string): Set<string> {
  const named = [...used].filter(([id]) => body.includes(id))
  const evicted = named.length > 0 ? named : [...used]
  for (const [, { key, entry }] of evicted) deleteIfSame(key, entry)
  return new Set(evicted.map(([id]) => id))
}

/**
 * The retry request after a missing-file 404: the wire request with only the
 * evicted file ids put back to their inline base64. Other file ids stay.
 *
 * @param original - The canonical request (base64 sources).
 * @param wire - The wire request from {@link prepareMediaUploads}.
 * @param evicted - The evicted file ids, from {@link evictMissingFiles}.
 * @returns The retry request.
 */
export function restoreInline(
  original: CanonicalRequest,
  wire: CanonicalRequest,
  evicted: Set<string>,
): CanonicalRequest {
  const pick = <B extends CanonicalBlock>(w: B, o: B | undefined): B => {
    if (o === undefined) return w
    if ((w.type === "image" || w.type === "file") && w.source.kind === "file_id") {
      return evicted.has(w.source.fileId) ? o : w
    }
    return w
  }
  const messages = wire.messages.map((msg, mi) => {
    const omsg = original.messages[mi]
    return {
      ...msg,
      content: msg.content.map((block, bi) => {
        const ob = omsg?.content[bi]
        if (block.type === "tool_result" && ob?.type === "tool_result") {
          return {
            ...block,
            content: block.content.map((inner, ii) => pick(inner, ob.content[ii])),
          }
        }
        return pick(block, ob)
      }),
    }
  })
  return { ...wire, messages }
}
