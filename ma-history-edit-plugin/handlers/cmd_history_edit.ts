import type { CommandContext } from "../lib/host-types.ts"
import { openPicker, paintEditing } from "../lib/runtime.ts"
import { getState, setCachedRows, takePendingDraft } from "../lib/state.ts"

/** Open, stage, or commit the history-edit workflow through host capabilities. */
export default async function cmdHistoryEdit(
  ctx: CommandContext,
): Promise<{ kind: "none" | "error" | "expand"; message?: string; prompt?: string }> {
  const sid = ctx.agent?.sessionId
  if (!sid || !ctx.host?.sessions)
    return { kind: "error", message: "history editing requires an active session" }
  const action = ctx.argv.trim()

  if (action === "commit") {
    const editing = getState()
    if (editing.kind !== "editing" || !editing.replacement || !ctx.host.sessionsWrite) {
      return { kind: "error", message: "history edit commit is not ready" }
    }
    const committed = await ctx.host.sessionsWrite.commitHistoryEdit({
      targetUserId: editing.target.userId,
      backupSid: editing.backupSid,
    })
    if (!committed.ok) return { kind: "error", message: committed.message }
    // Host command dispatch applies the expand after the host-owned reset
    // callback. Preserve the REWIND prefix until that accepted submit paints.
    return { kind: "expand", prompt: editing.replacement }
  }

  const stageId = action.match(/^stage\s+(.+)$/)?.[1]
  if (stageId) {
    const picking = getState()
    if (picking.kind !== "picking" || !ctx.host.sessionsWrite)
      return { kind: "error", message: "history edit selection expired" }
    const target = picking.rows.find((row) => row.userId === stageId)
    if (!target) return { kind: "error", message: "selected prompt no longer exists" }
    const begun = await ctx.host.sessionsWrite.beginHistoryEdit({ targetUserId: target.userId })
    if (!begun.ok) return { kind: "error", message: begun.message }
    paintEditing(
      ctx.emit,
      picking.draft,
      target,
      begun.userPromptOrdinal,
      begun.totalUserPrompts,
      begun.backupSid,
    )
    return { kind: "none" }
  }

  const window = await ctx.host.sessions.window(sid, { anchor: "end", limit: 5 })
  if (!window) return { kind: "error", message: "current session history is unavailable" }
  const rows = window.items
    .filter(
      (item): item is typeof item & { userId: string } =>
        item.kind === "user" && item.userId !== null,
    )
    .reverse()
    .map((item) => ({ userId: item.userId, text: item.preview }))
  if (rows.length === 0) return { kind: "error", message: "no earlier prompts in this session" }
  setCachedRows(rows)
  openPicker(ctx.emit, takePendingDraft(), rows)
  return { kind: "none" }
}
