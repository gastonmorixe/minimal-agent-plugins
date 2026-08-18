import { describe, expect, test } from "bun:test"

import { decodeKvServerMessage, encodeAgentClientMessageKvReply } from "./kv.ts"
import {
  concat,
  decodeFields,
  encBytes,
  encMsg,
  encVarintField,
  fieldBytes,
  fieldString,
} from "./wire.ts"

function encKvServer(body: Uint8Array): Uint8Array {
  return encMsg(4, body)
}

describe("cursor KV blob get/set", () => {
  test("decodes set_blob_args and replies with empty SetBlobResult", () => {
    const blobId = new Uint8Array([1, 2, 3])
    const blobData = new TextEncoder().encode("checkpoint")
    const payload = encKvServer(
      concat(encVarintField(1, 9), encMsg(3, concat(encBytes(1, blobId), encBytes(2, blobData)))),
    )
    const decoded = decodeKvServerMessage(payload)
    expect(decoded).toEqual({ kind: "set", id: 9, blobId, blobData })

    const store = new Map<string, Uint8Array>()
    const reply = encodeAgentClientMessageKvReply(decoded!, store)
    expect(store.get("010203")).toEqual(blobData)

    const outer = decodeFields(reply)
    expect(outer).toHaveLength(1)
    expect(outer[0]!.no).toBe(3)
    const kv = fieldBytes(outer[0]!)!
    const kvFields = decodeFields(kv)
    expect(Number(kvFields.find((f) => f.no === 1)!.value)).toBe(9)
    expect(kvFields.some((f) => f.no === 3)).toBe(true)
  })

  test("get_blob returns stored bytes after set", () => {
    const blobId = new Uint8Array([9])
    const store = new Map<string, Uint8Array>()
    const setPayload = encKvServer(
      concat(
        encVarintField(1, 1),
        encMsg(3, concat(encBytes(1, blobId), encBytes(2, new Uint8Array([7])))),
      ),
    )
    encodeAgentClientMessageKvReply(decodeKvServerMessage(setPayload)!, store)

    const getPayload = encKvServer(concat(encVarintField(1, 2), encMsg(2, encBytes(1, blobId))))
    const reply = encodeAgentClientMessageKvReply(decodeKvServerMessage(getPayload)!, store)
    const kv = fieldBytes(decodeFields(reply)[0]!)!
    const getResult = fieldBytes(decodeFields(kv).find((f) => f.no === 2)!)!
    expect(fieldBytes(decodeFields(getResult).find((f) => f.no === 1)!)).toEqual(
      new Uint8Array([7]),
    )
  })

  test("get_blob of unknown id returns error", () => {
    const getPayload = encKvServer(
      concat(encVarintField(1, 3), encMsg(2, encBytes(1, new Uint8Array([0xff])))),
    )
    const reply = encodeAgentClientMessageKvReply(decodeKvServerMessage(getPayload)!, new Map())
    const kv = fieldBytes(decodeFields(reply)[0]!)!
    const getResult = fieldBytes(decodeFields(kv).find((f) => f.no === 2)!)!
    const err = fieldBytes(decodeFields(getResult).find((f) => f.no === 2)!)!
    expect(fieldString(decodeFields(err).find((f) => f.no === 1)!)).toBe("blob not found")
  })
})
