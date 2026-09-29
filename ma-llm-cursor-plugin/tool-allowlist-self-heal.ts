/**
 * Self-heal for the Cursor tool allowlist.
 *
 * With `x-cursor-agent-allowed-tools`, the server kills a Run when it needs a
 * tool we did not allow ("Required tool X not found in allTools"). Before any
 * content reaches the host, learn X and retry the Run once with X allowed.
 *
 * Framing events (`message_start`) carry no content, so they are held back and
 * do not block the retry. They are dropped when the Run is retried, and
 * flushed before the first content event otherwise.
 *
 * @module llm/providers/cursor/tool-allowlist-self-heal
 */

import { learnCursorRequiredTool, requiredToolFromCursorError } from "./cursor-tool-policy.ts"
import type { CanonicalEvent } from "./lib/canonical-events.ts"

/** Events that carry no content and may be held back before a retry. */
const FRAMING_EVENTS: ReadonlySet<CanonicalEvent["type"]> = new Set(["message_start"])

/**
 * Run once. On a server "Required tool" error that arrives before any content,
 * learn the tool and run once more (`retry`), then stop.
 *
 * @param first - the first Run attempt
 * @param retry - builds the second attempt (headers are rebuilt, so the learned
 *   tool is in the allowlist)
 * @param onLearned - optional hook, for example debug logging
 */
export async function* withToolAllowlistSelfHeal(
  first: AsyncIterable<CanonicalEvent>,
  retry: () => AsyncIterable<CanonicalEvent>,
  onLearned?: (protoName: string) => void,
): AsyncGenerator<CanonicalEvent> {
  const held: CanonicalEvent[] = []
  let emitted = false
  for await (const event of first) {
    if (!emitted && FRAMING_EVENTS.has(event.type)) {
      held.push(event)
      continue
    }
    const required =
      !emitted && event.type === "stream_error" && event.cause instanceof Error
        ? requiredToolFromCursorError(event.cause.message)
        : undefined
    if (required && learnCursorRequiredTool(required)) {
      onLearned?.(required)
      yield* retry()
      return
    }
    if (!emitted) {
      emitted = true
      yield* held
      held.length = 0
    }
    yield event
  }
  // Stream ended with only framing events: pass them on unchanged.
  yield* held
}
