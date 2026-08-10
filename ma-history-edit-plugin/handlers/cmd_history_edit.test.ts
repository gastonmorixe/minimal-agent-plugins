import { describe, expect, it } from "bun:test"

import { setState } from "../lib/state.ts"

import cmdHistoryEdit from "./cmd_history_edit.ts"

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
