/**
 * Unit tests for MCP exec result protobuf encoding.
 */

import { describe, expect, test } from "bun:test"

import {
  encodeAgentClientMessageExecMcpResult,
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
