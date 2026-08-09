import { describe, expect, it } from "bun:test"

import { getState, setState } from "../lib/state.ts"

import onExpanded from "./on_expanded.ts"

describe("history.edit.expanded", () => {
  it("clears rewind UI only after expanded replacement enqueue", () => {
    setState({
      kind: "editing",
      draft: "d",
      target: { userId: "u", text: "old" },
      ordinal: 1,
      total: 1,
      backupSid: "b",
      replacement: "new",
    })
    const calls: Array<[string, unknown]> = []
    onExpanded({ emit: (channel, payload) => calls.push([channel, payload]) })
    expect(calls).toEqual([
      ["editor.prompt.clear", { owner: "history-edit" }],
      ["editor.footer.set", { owner: "history-edit", lines: [] }],
    ])
    expect(getState()).toEqual({ kind: "closed" })
  })
})
