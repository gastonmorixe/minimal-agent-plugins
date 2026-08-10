import type { CommandContext } from "../lib/host-types.ts"
import { openPicker, paintEditing, paintPicker } from "../lib/runtime.ts"
import {
  getState,
  type PromptRow,
  setCachedRows,
  setState,
  takePendingDraft,
} from "../lib/state.ts"

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

  const stage = action.match(/^stage\s+(\S+)\s+(\d+)$/)
  if (stage) {
    const [, stageId, tokenText] = stage
    const token = Number(tokenText)
    const staging = getState()
    if (
      staging.kind !== "staging" ||
      staging.token !== token ||
      staging.target.userId !== stageId ||
      !ctx.host.sessionsWrite
    ) {
      return { kind: "error", message: "history edit selection expired" }
    }
    const begun = await ctx.host.sessionsWrite.beginHistoryEdit({
      targetUserId: staging.target.userId,
    })
    const current = getState()
    if (current.kind !== "staging" || current.token !== token) return { kind: "none" }
    if (!begun.ok) {
      const picking = {
        kind: "picking" as const,
        draft: current.draft,
        rows: current.rows,
        selected: current.selected,
      }
      setState(picking)
      paintPicker(ctx.emit, picking)
      return { kind: "error", message: begun.message }
    }
    paintEditing(
      ctx.emit,
      staging.draft,
      staging.target,
      begun.userPromptOrdinal,
      begun.totalUserPrompts,
      begun.backupSid,
    )
    return { kind: "none" }
  }

  // A completed turn regularly spans several records. A five-record tail can
  // therefore contain no user records even when the session has many prompts.
  // Page backwards until the session is exhausted, keeping the newest rows first.
  const rows: PromptRow[] = []
  let offset = 0
  while (true) {
    const window = await ctx.host.sessions.window(sid, { anchor: "end", offset, limit: 100 })
    if (!window) return { kind: "error", message: "current session history is unavailable" }
    rows.push(
      ...[...window.items]
        .reverse()
        .flatMap((item): PromptRow[] =>
          item.kind === "user" && item.userId !== null
            ? [{ userId: item.userId, text: item.preview }]
            : [],
        ),
    )
    offset += window.items.length
    if (window.items.length === 0 || offset >= window.total) break
  }
  if (rows.length === 0) return { kind: "error", message: "no earlier prompts in this session" }
  setCachedRows(rows)
  openPicker(ctx.emit, takePendingDraft(), rows)
  return { kind: "none" }
}
