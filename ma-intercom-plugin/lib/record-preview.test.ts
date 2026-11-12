import { describe, expect, it } from "bun:test"

import { bodyFromParts } from "./record-preview.ts"

describe("bodyFromParts", () => {
  it("prefixes thinking, tool_use and message parts and joins with a newline", () => {
    expect(
      bodyFromParts([
        { kind: "thinking", text: "hmm", toolName: null },
        { kind: "tool_use", text: '{"a":1}', toolName: "Read" },
        { kind: "message", text: "hi", toolName: null, role: "user" },
      ]),
    ).toBe('[thinking] hmm\n[tool_use Read] {"a":1}\nuser: hi')
  })

  it("leaves plain text and tool_result parts unprefixed", () => {
    expect(
      bodyFromParts([
        { kind: "text", text: "hello", toolName: null },
        { kind: "tool_result", text: "ok", toolName: null },
      ]),
    ).toBe("hello\nok")
  })

  it("returns an empty string for no parts", () => {
    expect(bodyFromParts([])).toBe("")
  })
})
