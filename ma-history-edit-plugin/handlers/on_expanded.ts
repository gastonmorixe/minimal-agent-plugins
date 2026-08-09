import { OWNER } from "../lib/runtime.ts"
import { completeCommittedEdit, getState } from "../lib/state.ts"

/** Clears REWIND UI only after the host has enqueued the expanded replacement. */
export default function onExpanded(ctx: {
  emit: (channel: string, payload?: unknown) => void
}): void {
  if (getState().kind !== "editing") return
  ctx.emit("editor.prompt.clear", { owner: OWNER })
  ctx.emit("editor.footer.set", { owner: OWNER, lines: [] })
  completeCommittedEdit()
}
