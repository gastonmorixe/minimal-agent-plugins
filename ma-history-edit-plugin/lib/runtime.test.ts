import { describe, expect, it } from "bun:test"

import { close, openPicker, paintEditing } from "./runtime.ts"
import { getState, setState } from "./state.ts"

function recorder(): {
  emit: (channel: string, payload?: unknown) => void
  calls: Array<[string, unknown]>
} {
  const calls: Array<[string, unknown]> = []
  return { calls, emit: (channel, payload) => calls.push([channel, payload]) }
}

describe("history-edit runtime", () => {
  it("opens a host-owned picker with stable row ids", () => {
    const r = recorder()
    openPicker(r.emit, "draft", [
      { userId: "u1", text: "older" },
      { userId: "u2", text: "newer" },
    ])
    expect(getState()).toMatchObject({ kind: "picking", draft: "draft", selected: 0 })
    expect(r.calls).toEqual([
      ["editor.overlay.open", { owner: "history-edit" }],
      [
        "editor.picker.set",
        expect.objectContaining({ owner: "history-edit", selected: 0, rows: expect.any(Array) }),
      ],
    ])
  })

  it("releases overlay then stages the selected prompt in the shared buffer", () => {
    const r = recorder()
    paintEditing(r.emit, "saved draft", { userId: "u1", text: "old prompt" }, 2, 4, "backup-01")
    expect(getState()).toMatchObject({
      kind: "editing",
      draft: "saved draft",
      target: { userId: "u1" },
    })
    expect(r.calls.map(([channel]) => channel)).toEqual([
      "editor.prompt.set",
      "editor.picker.clear",
      "editor.overlay.close",
      "editor.footer.set",
      "editor.buffer.set",
    ])
  })

  it("Escape cancellation restores the original draft", () => {
    const r = recorder()
    setState({
      kind: "editing",
      draft: "before",
      target: { userId: "u1", text: "edited" },
      ordinal: 1,
      total: 1,
      backupSid: "b",
    })
    close(r.emit, "before")
    expect(getState()).toEqual({ kind: "closed" })
    expect(r.calls).toContainEqual(["editor.buffer.set", { text: "before" }])
  })
})
