import { describe, expect, it } from "bun:test"

import { setState } from "../lib/state.ts"

import onKey from "./on_key.ts"

function key(
  key: string,
  buffer = "draft",
): { key: string; buffer: string; result: { halt?: boolean; buffer?: string } } {
  return { key, buffer, result: {} }
}

describe("history-edit editor key hook", () => {
  it("claims EscapeEscape synchronously and defers async work to command.run", () => {
    setState({ kind: "closed" })
    const events: Array<[string, unknown]> = []
    const raw = key("EscapeEscape", "saved draft")
    onKey(raw, { emit: (channel, payload) => events.push([channel, payload]) })
    expect(raw.result.halt).toBe(true)
    expect(events).toEqual([["command.run", { line: "/history-edit" }]])
  })

  it("dispatches selected picker prompt on Enter without requiring sessionsWrite in the key hook", () => {
    setState({
      kind: "picking",
      draft: "draft",
      rows: [{ userId: "u1", text: "older prompt" }],
      selected: 0,
    })
    const events: Array<[string, unknown]> = []
    const enter = key("Enter")
    onKey(enter, { emit: (channel, payload) => events.push([channel, payload]) })
    expect(enter.result.halt).toBe(true)
    expect(events).toEqual([["command.run", { line: "/history-edit stage u1" }]])
  })

  it("allows ordinary editing keys but Escape restores the original draft", () => {
    setState({
      kind: "editing",
      draft: "original",
      target: { userId: "u", text: "old" },
      ordinal: 1,
      total: 1,
      backupSid: "b",
    })
    const printable = key("x", "changed")
    onKey(printable, { emit() {} })
    expect(printable.result.halt).toBeUndefined()

    const events: Array<[string, unknown]> = []
    const escape = key("Escape", "changed")
    onKey(escape, { emit: (channel, payload) => events.push([channel, payload]) })
    expect(escape.result.halt).toBe(true)
    expect(events).toContainEqual(["editor.buffer.set", { text: "original" }])
  })
})
