import { describe, expect, it } from "bun:test"

import { getState, setState } from "../lib/state.ts"

import cmdHistoryEdit from "./cmd_history_edit.ts"
import onKey from "./on_key.ts"

const noop = () => {}

describe("/history-edit commit", () => {
  it("returns expand only after a successful host-owned commit", async () => {
    setState({
      kind: "editing",
      draft: "draft",
      target: { userId: "u1", text: "original" },
      ordinal: 1,
      total: 2,
      backupSid: "backup-01",
      replacement: "revised",
    })
    const result = await cmdHistoryEdit({
      argv: "commit",
      emit: noop,
      agent: { sessionId: "active" },
      host: {
        sessions: {
          async window() {
            return null
          },
        },
        sessionsWrite: {
          async beginHistoryEdit() {
            throw new Error("not used")
          },
          async commitHistoryEdit(input) {
            expect(input).toEqual({ targetUserId: "u1", backupSid: "backup-01" })
            return { ok: true, droppedRecordCount: 2 }
          },
        },
      },
    })
    expect(result).toEqual({ kind: "expand", prompt: "revised" })
  })

  it("retains the editing state and reports commit failures", async () => {
    const editing = {
      kind: "editing" as const,
      draft: "draft",
      target: { userId: "u1", text: "original" },
      ordinal: 1,
      total: 2,
      backupSid: "backup-01",
      replacement: "revised",
    }
    setState(editing)
    const result = await cmdHistoryEdit({
      argv: "commit",
      emit: noop,
      agent: { sessionId: "active" },
      host: {
        sessions: {
          async window() {
            return null
          },
        },
        sessionsWrite: {
          async beginHistoryEdit() {
            throw new Error("not used")
          },
          async commitHistoryEdit() {
            return {
              ok: false as const,
              code: "commit_preflight_failed",
              message: "reload unavailable",
            }
          },
        },
      },
    })
    expect(result).toEqual({ kind: "error", message: "reload unavailable" })
  })
})

describe("/history-edit staging", () => {
  it("restores the picker when a stage transaction fails", async () => {
    setState({
      kind: "staging",
      draft: "draft",
      rows: [{ userId: "u1", text: "prompt" }],
      selected: 0,
      target: { userId: "u1", text: "prompt" },
      token: 7,
    })
    const events: Array<[string, unknown]> = []
    const result = await cmdHistoryEdit({
      argv: "stage u1 7",
      emit: (channel, payload) => events.push([channel, payload]),
      agent: { sessionId: "active" },
      host: {
        sessions: {
          async window() {
            return null
          },
        },
        sessionsWrite: {
          async beginHistoryEdit() {
            return { ok: false as const, code: "commit_preflight_failed", message: "blocked" }
          },
          async commitHistoryEdit() {
            throw new Error("not used")
          },
        },
      },
    })
    expect(result).toEqual({ kind: "error", message: "blocked" })
    expect(getState()).toMatchObject({ kind: "picking", selected: 0 })
    expect(events.some(([channel]) => channel === "editor.picker.set")).toBe(true)
  })
})

describe("/history-edit staging cancellation", () => {
  it("does not reopen editing after Escape invalidates an in-flight stage", async () => {
    setState({
      kind: "staging",
      draft: "draft",
      rows: [{ userId: "u1", text: "prompt" }],
      selected: 0,
      target: { userId: "u1", text: "prompt" },
      token: 8,
    })
    type BeginResult = {
      ok: true
      selectedText: string
      userPromptOrdinal: number
      totalUserPrompts: number
      backupSid: string
    }
    let resolveBegin: ((value: BeginResult) => void) | undefined
    const begin = new Promise<BeginResult>((resolve) => {
      resolveBegin = resolve
    })
    const events: Array<[string, unknown]> = []
    const pending = cmdHistoryEdit({
      argv: "stage u1 8",
      emit: (channel, payload) => events.push([channel, payload]),
      agent: { sessionId: "active" },
      host: {
        sessions: {
          async window() {
            return null
          },
        },
        sessionsWrite: {
          async beginHistoryEdit() {
            return begin
          },
          async commitHistoryEdit() {
            throw new Error("not used")
          },
        },
      },
    })
    await Promise.resolve()
    const escape = { key: "Escape", buffer: "", result: {} as { halt?: boolean } }
    onKey(escape, { emit: (channel, payload) => events.push([channel, payload]) })
    expect(escape.result.halt).toBe(true)
    expect(events.some(([channel]) => channel === "editor.overlay.close")).toBe(true)
    resolveBegin?.({
      ok: true,
      selectedText: "prompt",
      userPromptOrdinal: 1,
      totalUserPrompts: 1,
      backupSid: "backup",
    })
    expect(await pending).toEqual({ kind: "none" })
    expect(getState()).toEqual({ kind: "closed" })
    expect(events).toContainEqual(["editor.buffer.set", { text: "draft" }])
    expect(events).not.toContainEqual(["editor.buffer.set", { text: "prompt" }])
    expect(events.some(([channel]) => channel === "editor.prompt.set")).toBe(false)
  })
})

describe("/history-edit prompt discovery", () => {
  it("pages beyond a tail without user records to find earlier prompts", async () => {
    setState({ kind: "closed" })
    const calls: Array<{ offset?: number; limit?: number }> = []
    const result = await cmdHistoryEdit({
      argv: "",
      emit: noop,
      agent: { sessionId: "active" },
      host: {
        sessions: {
          async window(_sid, opts) {
            calls.push({ offset: opts.offset, limit: opts.limit })
            if (opts.offset === 0) {
              return {
                items: [
                  { index: 5, kind: "assistant", userId: null, preview: "reply" },
                  { index: 6, kind: "tool_result", userId: null, preview: "tool" },
                ],
                total: 3,
              }
            }
            return {
              items: [{ index: 4, kind: "user", userId: "u1", preview: "earlier prompt" }],
              total: 3,
            }
          },
        },
      },
    })
    expect(result).toEqual({ kind: "none" })
    expect(calls).toEqual([
      { offset: 0, limit: 100 },
      { offset: 2, limit: 100 },
    ])
  })
})
