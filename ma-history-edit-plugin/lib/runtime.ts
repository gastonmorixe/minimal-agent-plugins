import type { EmitFn } from "./host-types.ts"
import { type PromptRow, type State, setState } from "./state.ts"

export const OWNER = "history-edit"

/** Open the host-owned modal picker from stable prompt rows. */
export function openPicker(emit: EmitFn, draft: string, rows: readonly PromptRow[]): void {
  setState({ kind: "picking", draft, rows, selected: 0 })
  emit("editor.overlay.open", { owner: OWNER })
  paintPicker(emit, { kind: "picking", draft, rows, selected: 0 })
}

/** Render the current picker state through the host-owned picker protocol. */
export function paintPicker(emit: EmitFn, state: Extract<State, { kind: "picking" }>): void {
  emit("editor.picker.set", {
    owner: OWNER,
    title: `↶ Edit earlier prompt · ${state.rows.length}`,
    rows: state.rows.map((row, index) => ({
      id: row.userId,
      label: `${state.rows.length - index} · ${row.text}`,
    })),
    selected: state.selected,
    footer: state.error ?? "↑↓ select · PgUp/PgDn page · Enter edit · Esc cancel",
  })
}

/** Release any modal UI and optionally restore the preserved normal draft. */
export function close(emit: EmitFn, draft: string): void {
  emit("editor.picker.clear", { owner: OWNER })
  emit("editor.overlay.close", { owner: OWNER })
  emit("editor.prompt.clear", { owner: OWNER })
  emit("editor.footer.set", { owner: OWNER, lines: [] })
  setState({ kind: "closed" })
  if (draft.length > 0) emit("editor.buffer.set", { text: draft })
}

/** Move the selected prompt into the ordinary editor with REWIND decoration. */
export function paintEditing(
  emit: EmitFn,
  draft: string,
  target: PromptRow,
  ordinal: number,
  total: number,
  backupSid: string,
): void {
  // The editing state uses the ordinary editor buffer. Release the modal
  // overlay before writing it so the edited text is visible and submit-ready.
  // prompt.set must claim the still-open modal owner before removing the
  // picker and releasing the overlay.
  emit("editor.prompt.set", { owner: OWNER, prompt: "↶ REWIND ❯", continuationPrompt: "  " })
  emit("editor.picker.clear", { owner: OWNER })
  emit("editor.overlay.close", { owner: OWNER })
  emit("editor.footer.set", {
    owner: OWNER,
    lines: [
      `↶ Editing prompt ${ordinal} of ${total}. Enter replaces this prompt. Esc restores your prior draft.`,
    ],
  })
  emit("editor.buffer.set", { text: target.text })
  setState({ kind: "editing", draft, target, ordinal, total, backupSid })
}
