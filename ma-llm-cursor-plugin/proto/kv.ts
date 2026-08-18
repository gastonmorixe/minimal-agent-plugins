/**
 * agent.v1.KvServerMessage / KvClientMessage (blob get/set on AgentService/Run).
 *
 * Official Cursor Agent CLI answers these on the keep-open stream. Ignoring
 * them leaves the server waiting for get/set results, so it never sends
 * `turn_ended` and the TUI stays on "Receiving stream".
 *
 * @module llm/providers/cursor/proto/kv
 */

import {
  concat,
  decodeFields,
  encBytes,
  encMsg,
  encString,
  encVarintField,
  fieldBytes,
  fieldVarint,
} from "./wire.ts"

/** In-memory blob store keyed by hex(blob_id). */
export type CursorBlobStore = Map<string, Uint8Array>

export type DecodedKvGet = {
  kind: "get"
  id: number
  blobId: Uint8Array
}

export type DecodedKvSet = {
  kind: "set"
  id: number
  blobId: Uint8Array
  blobData: Uint8Array
}

export type DecodedKvServerMessage = DecodedKvGet | DecodedKvSet

function blobKey(blobId: Uint8Array): string {
  return Buffer.from(blobId).toString("hex")
}

/** Decode AgentServerMessage.kv_server_message (field 4), if present. */
export function decodeKvServerMessage(payload: Uint8Array): DecodedKvServerMessage | undefined {
  for (const f of decodeFields(payload)) {
    if (f.no !== 4 || f.wire !== 2) continue
    const body = fieldBytes(f)
    if (!body) return undefined
    return decodeKvServerMessageBody(body)
  }
  return undefined
}

/** Decode the KvServerMessage body (id + get/set oneof). */
export function decodeKvServerMessageBody(body: Uint8Array): DecodedKvServerMessage | undefined {
  let id = 0
  let getBlobId: Uint8Array | undefined
  let setBlobId: Uint8Array | undefined
  let setBlobData: Uint8Array | undefined
  for (const f of decodeFields(body)) {
    if (f.no === 1) {
      const v = fieldVarint(f)
      if (v != null) id = v
    } else if (f.no === 2 && f.wire === 2) {
      const args = fieldBytes(f)
      if (args) {
        for (const a of decodeFields(args)) {
          if (a.no === 1) getBlobId = fieldBytes(a) ?? undefined
        }
      }
    } else if (f.no === 3 && f.wire === 2) {
      const args = fieldBytes(f)
      if (args) {
        for (const a of decodeFields(args)) {
          if (a.no === 1) setBlobId = fieldBytes(a) ?? undefined
          if (a.no === 2) setBlobData = fieldBytes(a) ?? undefined
        }
      }
    }
  }
  if (getBlobId) return { kind: "get", id, blobId: getBlobId }
  if (setBlobId) {
    return { kind: "set", id, blobId: setBlobId, blobData: setBlobData ?? new Uint8Array(0) }
  }
  return undefined
}

/**
 * Apply a KV request to the local store and encode AgentClientMessage.kv_client_message (field 3).
 */
export function encodeAgentClientMessageKvReply(
  msg: DecodedKvServerMessage,
  store: CursorBlobStore,
): Uint8Array {
  const key = blobKey(msg.blobId)
  const idField = encVarintField(1, msg.id)
  if (msg.kind === "set") {
    store.set(key, msg.blobData)
    // SetBlobResult with no error = success.
    return encMsg(3, concat(idField, encMsg(3, new Uint8Array(0))))
  }
  const data = store.get(key)
  const getResult = data ? encBytes(1, data) : encMsg(2, encString(1, "blob not found"))
  return encMsg(3, concat(idField, encMsg(2, getResult)))
}
