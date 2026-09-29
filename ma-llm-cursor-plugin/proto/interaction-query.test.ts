import { describe, expect, test } from "bun:test"

import { decodeInteractionQuery, encodeInteractionRejection } from "./interaction-query.ts"
import {
  decodeFields,
  encMsg,
  encVarintField,
  fieldBytes,
  fieldString,
  fieldVarint,
} from "./wire.ts"

/** AgentServerMessage.interaction_query (#7) with id and one query oneof member. */
function serverQuery(id: number, queryField: number, body = new Uint8Array(0)): Uint8Array {
  const inner = new Uint8Array([...encVarintField(1, id), ...encMsg(queryField, body)])
  return encMsg(7, inner)
}

describe("decodeInteractionQuery", () => {
  test("returns undefined for a payload without interaction_query", () => {
    expect(decodeInteractionQuery(encMsg(1, new Uint8Array(0)))).toBeUndefined()
  })

  test("reads id and the query oneof member", () => {
    expect(decodeInteractionQuery(serverQuery(5, 2))).toEqual({ id: 5, queryField: 2 })
    expect(decodeInteractionQuery(serverQuery(9, 7))).toEqual({ id: 9, queryField: 7 })
  })

  test("unknown oneof member yields queryField 0 but keeps the id", () => {
    expect(decodeInteractionQuery(serverQuery(3, 99))).toEqual({ id: 3, queryField: 0 })
  })
})

describe("encodeInteractionRejection", () => {
  function parse(bytes: Uint8Array) {
    const outer = decodeFields(bytes)
    expect(outer).toHaveLength(1)
    expect(outer[0]?.no).toBe(6) // AgentClientMessage.interaction_response
    const resp = decodeFields(fieldBytes(outer[0]!)!)
    return resp
  }

  test("web_search (2) gets rejected { reason } under the same field number, id echoed", () => {
    const resp = parse(encodeInteractionRejection({ id: 5, queryField: 2 }, "no"))
    expect(fieldVarint(resp.find((f) => f.no === 1)!)).toBe(5)
    const result = decodeFields(fieldBytes(resp.find((f) => f.no === 2)!)!)
    const rejected = decodeFields(fieldBytes(result.find((f) => f.no === 2)!)!)
    expect(fieldString(rejected.find((f) => f.no === 1)!)).toBe("no")
  })

  test("switch_mode (4) also gets rejected { reason }", () => {
    const resp = parse(encodeInteractionRejection({ id: 1, queryField: 4 }, "x"))
    const result = decodeFields(fieldBytes(resp.find((f) => f.no === 4)!)!)
    expect(result.find((f) => f.no === 2)).toBeTruthy()
  })

  test("other kinds get an empty result on the matching oneof number", () => {
    const resp = parse(encodeInteractionRejection({ id: 2, queryField: 9 }))
    const field = resp.find((f) => f.no === 9)
    expect(field).toBeTruthy()
    expect(fieldBytes(field!)?.length).toBe(0)
  })

  test("unknown kind still echoes the id so the server can correlate", () => {
    const resp = parse(encodeInteractionRejection({ id: 8, queryField: 0 }))
    expect(fieldVarint(resp.find((f) => f.no === 1)!)).toBe(8)
    expect(resp).toHaveLength(1)
  })

  test("id 0 still carries the result oneof (proto3 omits the zero id)", () => {
    const resp = parse(encodeInteractionRejection({ id: 0, queryField: 2 }))
    expect(resp.find((f) => f.no === 1)).toBeUndefined()
    expect(resp.find((f) => f.no === 2)).toBeTruthy()
  })
})
