/**
 * Opt-in stderr logging for Cursor bidi tool loop (MA_CURSOR_BIDI_DEBUG=1).
 *
 * @module llm/providers/cursor/bidi-debug
 */

/** Whether bidi debug logging is enabled. */
export function cursorBidiDebugEnabled(): boolean {
  return process.env.MA_CURSOR_BIDI_DEBUG === "1"
}

/** Log one bidi step to stderr (no-op unless MA_CURSOR_BIDI_DEBUG=1). */
export function cursorBidiLog(phase: string, detail?: Record<string, unknown> | string): void {
  if (!cursorBidiDebugEnabled()) return
  const extra =
    detail === undefined ? "" : ` ${typeof detail === "string" ? detail : JSON.stringify(detail)}`
  console.error(`[cursor-bidi] ${phase}${extra}`)
}
