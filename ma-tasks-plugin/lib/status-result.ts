import { renderTasksCompactAck, renderTasksToolContent, type TaskToolMeta } from "./model-render.ts"
import type { Stats, TaskStore } from "./store.ts"

export interface StatusResultExtras {
  parentAutoDone?: string
  coerced?: readonly string[]
  reason?: string
}

/** Render a status mutation in compact or full-board mode. */
export function renderStatusResult(
  store: TaskStore,
  stats: Stats,
  meta: TaskToolMeta,
  format: "text" | "json" | undefined,
  fullResults: boolean,
  extras: StatusResultExtras,
): string {
  if (format === "json") {
    return JSON.stringify(
      {
        result: meta.result,
        id: meta.id,
        stats,
        ...(fullResults ? { tasks: store.list() } : {}),
        ...(extras.parentAutoDone ? { parent_auto_done: extras.parentAutoDone } : {}),
        ...(extras.coerced?.length ? { coerced: extras.coerced } : {}),
        ...(extras.reason ? { reason: extras.reason } : {}),
      },
      null,
      2,
    )
  }
  return fullResults
    ? renderTasksToolContent(store.list(), stats, meta)
    : renderTasksCompactAck(stats, meta)
}
