/**
 * Per-turn `<ma::agent::tasks>` attachment producer.
 *
 * The agent's task list is stored at `~/.minimal-agent/sessions/<sid>.tasks.jsonl`
 * (one task per line, see `lib/parse.ts`). To make the live state reliably
 * present in the model's context every turn — without busting the
 * system-prompt cache — we prepend a `<ma::agent::tasks>…</ma::agent::tasks>`
 * attachment to the FIRST user message of each `Agent.run` call.
 *
 * Same mechanism as the memory plugin's `ShortTermSnapshot` (see
 * `plugins/memory/lib/short-term-snapshot.ts`). The attachment sits
 * behind the rolling-tail cache breakpoint (which is invalidated every
 * turn anyway by the new user message), so the snapshot costs zero
 * extra cache invalidation.
 *
 * # The `<ma::agent::*>` namespace
 *
 * Every model-facing tag is `<ma::OWNER::leaf>`, partitioned by who
 * produces it:
 *
 * - `<ma::sys::*>`   — composed into the system prompt (the model reads it).
 * - `<ma::agent::*>` — emitted by the AGENT runtime as a per-turn signal the
 *   model reads. `<ma::agent::tasks>` is one of these: live task state
 *   prepended to the user message here.
 * - `<ma::emit::*>`  — emitted by the MODEL and scanned out of assistant
 *   output by `src/plugins/scanner.ts` to fire an inline handler.
 *
 * The output scanner only watches for `<ma::emit::*>`, so an
 * `<ma::agent::tasks>` attachment is unambiguously "data the model reads",
 * never "a trigger the model fired".
 *
 * # When the attachment is omitted
 *
 * - Zero tasks in the session file (or file missing entirely). The model
 *   sees nothing — no token cost when tasks aren't in play.
 * - No session id available (rare; defensive fallback).
 *
 * # Loop-seam vs initial-seam
 *
 * Initial-seam only. The model already saw the snapshot at the start of
 * the turn; re-emitting on every tool round would balloon context with
 * stale repeats. Tool calls update the file synchronously; the model
 * sees the post-update state via the tool's `tool_result.content`
 * (which is rendered through the same columnar task view).
 *
 * @module tasks/lib/attachment
 */

import { renderTasksColumnar } from "./model-render.ts"
import type { Task } from "./parse.ts"
import { type StoreDeps, TaskStore } from "./store.ts"

/**
 * LOCAL structural slice of the host's `ContentBlock` union — the text block
 * this producer emits. The host's turn-attachment registry expects
 * `toAttachment(): ContentBlock | null`; a text block satisfies that union
 * structurally, so the real host accepts it without the plugin importing host
 * code (the decoupling contract). Source of truth: `src/client/types.ts`
 * (`TextBlock`).
 */
interface AttachmentTextBlock {
  type: "text"
  text: string
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render the task list as the body of the per-turn `<ma::agent::tasks>`
 * attachment; empty string when there are no tasks (zero token cost).
 */
export function renderAttachmentBody(tasks: readonly Task[]): string {
  return tasks.length === 0 ? "" : renderTasksColumnar(tasks)
}

/**
 * Compute summary counts. Same shape as {@link Stats} from `store.ts`
 * but locally re-derived so this module doesn't depend on the full
 * store at render time.
 */
function summary(tasks: readonly Task[]): {
  total: number
  done: number
  doing: number
  todo: number
  canceled: number
} {
  const s = { total: tasks.length, done: 0, doing: 0, todo: 0, canceled: 0 }
  for (const t of tasks) s[t.status] += 1
  return s
}

// ---------------------------------------------------------------------------
// Producer
// ---------------------------------------------------------------------------

/**
 * Per-session attachment producer.
 *
 * Construct one per agent. Holds the session id and reads the tasks
 * file on every {@link toAttachment} call. When the session id is
 * `null` (no session plumbed through), every call returns `null`.
 */
export class TasksAttachment {
  constructor(
    public readonly sid: string | null,
    private readonly deps: StoreDeps = {},
  ) {}

  /**
   * Render the current attachment, or `null` if there are no tasks (so
   * the agent can append unconditionally).
   *
   * Output shape:
   *
   * ```
   *     <ma::agent::tasks total="5" done="2" doing="1" todo="1" canceled="1">
   *     1   #a7b3c4   done      Add contextSize to SessionTokens  12s
   *     2   #f8e21a   doing     Update src/session-tokens.test.ts
   *     2a  #f8e21aa  done      Zero-state includes contextSize
   *     3   #c9d4e5   canceled  Drop legacy column (user pivoted)
   *     ...
   *     </ma::agent::tasks>
   * ```
   */
  toAttachment(): AttachmentTextBlock | null {
    if (this.sid === null || this.sid.trim().length === 0) return null

    const store = new TaskStore(this.sid, this.deps)
    const tasks = store.list()
    if (tasks.length === 0) return null

    const s = summary(tasks)
    const body = renderAttachmentBody(tasks)
    return {
      type: "text",
      text: `<ma::agent::tasks total="${s.total}" done="${s.done}" doing="${s.doing}" todo="${s.todo}" canceled="${s.canceled}">\n${body}\n</ma::agent::tasks>`,
    }
  }

  /**
   * Convenience: returns just the rendered text (or `null`). Used by
   * tests that want to assert on string shape without unwrapping the
   * ContentBlock.
   */
  toText(): string | null {
    const a = this.toAttachment()
    return a?.type === "text" ? a.text : null
  }
}
