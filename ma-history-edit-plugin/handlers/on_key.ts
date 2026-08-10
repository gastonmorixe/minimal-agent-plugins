import type { EditorKeyPayload, HookContext } from "../lib/host-types.ts"
import { close, paintPicker } from "../lib/runtime.ts"
import { getState, setPendingDraft, setState, takeStageToken } from "../lib/state.ts"

function payload(v: unknown): v is EditorKeyPayload {
  return !!v && typeof v === "object" && typeof (v as EditorKeyPayload).key === "string"
}

/** Synchronous key hook. Async work is dispatched through `command.run`. */
export default function onKey(raw: unknown, ctx: HookContext): void {
  if (!payload(raw)) return
  const state = getState()

  if (state.kind === "closed") {
    if (raw.key !== "EscapeEscape") return
    raw.result.halt = true
    setPendingDraft(raw.buffer)
    ctx.emit("command.run", { line: "/history-edit" })
    return
  }

  if (state.kind === "staging") {
    raw.result.halt = true
    if (raw.key === "Escape") close(ctx.emit, state.draft)
    return
  }

  if (state.kind === "editing") {
    // The selected prompt is now in the ordinary editor buffer. Keep normal
    // text editing available and only claim Escape or the asynchronous commit.
    if (raw.key === "Escape") {
      raw.result.halt = true
      close(ctx.emit, state.draft)
    } else if (raw.key === "Enter") {
      raw.result.halt = true
      setState({ ...state, replacement: raw.buffer })
      ctx.emit("command.run", { line: "/history-edit commit" })
    }
    return
  }

  raw.result.halt = true
  if (raw.key === "Escape") {
    close(ctx.emit, state.draft)
    return
  }
  const delta = raw.key === "ArrowUp" ? -1 : raw.key === "ArrowDown" ? 1 : 0
  if (delta !== 0) {
    const selected = Math.max(0, Math.min(state.rows.length - 1, state.selected + delta))
    const next = { ...state, selected }
    setState(next)
    paintPicker(ctx.emit, next)
    return
  }
  if (raw.key !== "Enter") return
  const target = state.rows[state.selected]
  if (!target) return
  // Claim synchronously before the command bridge begins its async transaction.
  // This dedupes Enter and lets Escape invalidate the request before it returns.
  const token = takeStageToken()
  setState({
    kind: "staging",
    draft: state.draft,
    rows: state.rows,
    selected: state.selected,
    target,
    token,
  })
  ctx.emit("command.run", { line: `/history-edit stage ${target.userId} ${token}` })
}
