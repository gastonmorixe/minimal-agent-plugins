export interface PromptRow {
  userId: string
  text: string
}

export type State =
  | { kind: "closed" }
  | { kind: "picking"; draft: string; rows: readonly PromptRow[]; selected: number; error?: string }
  | {
      kind: "staging"
      draft: string
      rows: readonly PromptRow[]
      selected: number
      target: PromptRow
      token: number
    }
  | {
      kind: "editing"
      draft: string
      target: PromptRow
      ordinal: number
      total: number
      backupSid: string
      replacement?: string
    }

let state: State = { kind: "closed" }
let cachedRows: readonly PromptRow[] = []
let pendingDraft = ""
let nextStageToken = 1
/** Return the active history-edit UI state. */
export function getState(): State {
  return state
}
/** Replace the active history-edit UI state. */
export function setState(next: State): void {
  state = next
}
/** Allocate a monotonic token that identifies one asynchronous stage request. */
export function takeStageToken(): number {
  return nextStageToken++
}
/** Return cached picker rows retained between command transitions. */
export function getCachedRows(): readonly PromptRow[] {
  return cachedRows
}
/** Replace cached picker rows. */
export function setCachedRows(rows: readonly PromptRow[]): void {
  cachedRows = rows
}
/** Preserve the normal editor draft while async picker opening begins. */
export function setPendingDraft(draft: string): void {
  pendingDraft = draft
}
/** Consume and clear the pending editor draft. */
export function takePendingDraft(): string {
  const draft = pendingDraft
  pendingDraft = ""
  return draft
}

/** Called only by a host post-expand acknowledgement, never on commit failure. */
export function completeCommittedEdit(): void {
  state = { kind: "closed" }
}
