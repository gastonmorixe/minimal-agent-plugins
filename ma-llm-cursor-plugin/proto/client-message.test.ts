/**
 * Unit tests for MCP exec result protobuf encoding.
 */

import { describe, expect, test } from "bun:test"

import {
  encodeAgentClientMessageExecMcpResult,
  encodeAgentClientMessageHeartbeat,
  encodeShellStreamExecFrames,
} from "./client-message.ts"
import { decodeFields, fieldBytes, fieldString } from "./wire.ts"

describe("encodeAgentClientMessageExecMcpResult", () => {
  test("wraps ExecClientMessage in AgentClientMessage field 2", () => {
    const body = encodeAgentClientMessageExecMcpResult({
      id: 42,
      execId: "exec-9",
      resultText: "hello tool output",
      isError: false,
    })
    const outer = decodeFields(body)
    expect(outer.some((f) => f.no === 2 && f.wire === 2)).toBe(true)
    const exec = fieldBytes(outer.find((f) => f.no === 2)!)
    expect(exec).toBeTruthy()
    const execFields = decodeFields(exec!)
    expect(Number(execFields.find((f) => f.no === 1)!.value)).toBe(42)
    expect(fieldString(execFields.find((f) => f.no === 15)!)).toBe("exec-9")
    expect(execFields.some((f) => f.no === 11)).toBe(true)
  })
})

describe("native GrepSuccess encoding", () => {
  test("preserves resultText inside workspace_results content match", () => {
    const body = encodeAgentClientMessageExecMcpResult({
      id: 11,
      execId: "grep-1",
      resultText: "src/foo.ts:12: hello",
      isError: false,
      nativeExecFieldNo: 5,
    })
    const outer = decodeFields(body)
    const exec = fieldBytes(outer.find((f) => f.no === 2)!)!
    const execFields = decodeFields(exec)
    expect(Number(execFields.find((f) => f.no === 1)!.value)).toBe(11)
    const grepResult = fieldBytes(execFields.find((f) => f.no === 5)!)!
    const grepFields = decodeFields(grepResult)
    // GrepResult.success (field 1)
    const success = fieldBytes(grepFields.find((f) => f.no === 1)!)!
    const successFields = decodeFields(success)
    expect(fieldString(successFields.find((f) => f.no === 3)!)).toBe("content")
    // workspace_results map entry (field 4)
    const mapEntry = fieldBytes(successFields.find((f) => f.no === 4)!)!
    const mapFields = decodeFields(mapEntry)
    expect(fieldString(mapFields.find((f) => f.no === 1)!)).toBe(".")
    const union = fieldBytes(mapFields.find((f) => f.no === 2)!)!
    const unionFields = decodeFields(union)
    // GrepUnionResult.content (field 3)
    const content = fieldBytes(unionFields.find((f) => f.no === 3)!)!
    const contentFields = decodeFields(content)
    const fileMatch = fieldBytes(contentFields.find((f) => f.no === 1)!)!
    const fileFields = decodeFields(fileMatch)
    const match = fieldBytes(fileFields.find((f) => f.no === 2)!)!
    const matchFields = decodeFields(match)
    expect(fieldString(matchFields.find((f) => f.no === 2)!)).toBe("src/foo.ts:12: hello")
  })
})

describe("encodeShellStreamExecFrames", () => {
  test("emits start, stdout, exit ShellStream events for success", () => {
    const frames = encodeShellStreamExecFrames({
      id: 7,
      execId: "",
      resultText: "546 README.md\n",
      isError: false,
      nativeExecFieldNo: 14,
    })
    expect(frames).toHaveLength(3)
    const eventFields: number[] = []
    for (const frame of frames) {
      const outer = decodeFields(frame)
      const exec = fieldBytes(outer.find((f) => f.no === 2)!)!
      const execFields = decodeFields(exec)
      expect(Number(execFields.find((f) => f.no === 1)!.value)).toBe(7)
      const stream = fieldBytes(execFields.find((f) => f.no === 14)!)!
      const streamFields = decodeFields(stream)
      expect(streamFields).toHaveLength(1)
      eventFields.push(streamFields[0]!.no)
    }
    expect(eventFields).toEqual([4, 1, 3]) // start, stdout, exit
  })

  test("emits rejected ShellStream event for errors", () => {
    const frames = encodeShellStreamExecFrames({
      id: 3,
      execId: "",
      resultText: "blocked",
      isError: true,
      nativeExecFieldNo: 14,
    })
    expect(frames).toHaveLength(1)
    const exec = fieldBytes(decodeFields(frames[0]!).find((f) => f.no === 2)!)!
    const stream = fieldBytes(decodeFields(exec).find((f) => f.no === 14)!)!
    expect(decodeFields(stream)[0]!.no).toBe(5) // rejected
  })
})

describe("encodeAgentClientMessageHeartbeat", () => {
  test("wraps empty ClientHeartbeat in AgentClientMessage field 7", () => {
    const body = encodeAgentClientMessageHeartbeat()
    const outer = decodeFields(body)
    expect(outer).toHaveLength(1)
    expect(outer[0]!.no).toBe(7)
    expect(outer[0]!.wire).toBe(2)
    expect(fieldBytes(outer[0]!)?.byteLength ?? 0).toBe(0)
  })
})
