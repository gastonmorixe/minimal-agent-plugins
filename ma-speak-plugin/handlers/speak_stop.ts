/**
 * Tool-call handler for `SpeakStop`.
 *
 * With an `id`, stops that one job. Without an `id`, stops every job that is
 * currently speaking (the "be quiet now" button). Stopping a job that already
 * reached a terminal state is a no-op and reported as such.
 *
 * Shares the module-singleton registry with the other two handlers, so the
 * stop reaches the process the `Speak` handler spawned in an earlier call.
 *
 * @module handlers/speak_stop
 */

import { getRegistry, type SpeechRegistry } from "../lib/registry.ts"
import { dim, red, renderJobLine, yellow } from "../lib/render.ts"
import type { TUIContext, TUIResult } from "../lib/types.ts"

/** Default export: the tool handler the loader invokes. */
const handler = async (ctx: TUIContext): Promise<TUIResult> => {
  if (ctx.trigger.type !== "tool") {
    return { kind: "tool_result", content: "SpeakStop: wrong trigger type", is_error: true }
  }
  const raw = ctx.trigger.input
  let id: string | undefined
  if (raw.id !== undefined) {
    if (typeof raw.id !== "string") {
      return { kind: "tool_result", content: "SpeakStop: `id` must be a string", is_error: true }
    }
    const trimmed = raw.id.trim()
    if (trimmed.length > 0) id = trimmed
  }
  return runStop(getRegistry(), id, Date.now())
}

/** Test-injectable core. Reads + mutates the registry. */
export function runStop(registry: SpeechRegistry, id: string | undefined, now: number): TUIResult {
  if (id === undefined) {
    return stopAll(registry, now)
  }

  const existing = registry.get(id)
  if (!existing) {
    return {
      kind: "tool_result",
      content: `SpeakStop: no speech job with handle "${id}" in this session.`,
      is_error: true,
      displayHeader: red("unknown job"),
      display: dim(`no job "${id}"`),
    }
  }

  // Already terminal → no-op, report the existing state.
  if (existing.state !== "speaking") {
    return {
      kind: "tool_result",
      content: `Speech job ${id} was already ${existing.state}; nothing to stop.`,
      displayHeader: id,
      display: renderJobLine(existing, now),
    }
  }

  const stopped = registry.stop(id) ?? existing
  return {
    kind: "tool_result",
    content: `Stopped speech job ${id}.`,
    displayHeader: yellow(`■ stopped ${id}`),
    display: renderJobLine(stopped, now),
  }
}

/** Stop every active job. */
function stopAll(registry: SpeechRegistry, now: number): TUIResult {
  const active = registry.active()
  if (active.length === 0) {
    return {
      kind: "tool_result",
      content: "No speech is playing; nothing to stop.",
      displayHeader: "nothing playing",
      display: dim("(no active speech)"),
    }
  }
  const stopped = registry.stopAll()
  const ids = stopped.map((j) => j.id)
  return {
    kind: "tool_result",
    content: `Stopped ${stopped.length} speech job(s): ${ids.join(", ")}.`,
    displayHeader: yellow(`■ stopped ${stopped.length}`),
    display: stopped.map((j) => renderJobLine(j, now)).join("\n"),
  }
}

export default handler
