/**
 * Tool-input validation for `CompactContext`.
 *
 * Reuses core `parseCompactArgs` (agent/context-compact) semantics,
 * adapted from `/compact` argv strings to tool JSON input:
 *
 * - `mode`: one of tail|local|remote|fork (case-insensitive, like the
 *   positional `mode=<engine>` argv form). Absent: the host applies its
 *   default (`local`).
 * - `tail`: trailing messages kept verbatim. Must be an integer \>= 0
 *   (same rule as `tail=N` / `keep-tail=N`). Absent: host default.
 * - `focus`: hint kept verbatim in the checkpoint (same as `focus="..."`).
 *   Blank strings are dropped.
 * - `reason`: manual (the user asked) or auto (the model decided).
 *   Default `auto`, since the tool caller is the model.
 *
 * Pure functions, unit-tested through the handler tests.
 *
 * @module compact/lib/args
 */

import type { CompactMode, CompactTriggerReason } from "./host-types.ts"

/** Engines core `parseCompactArgs` accepts (positional or `mode=`). */
export const COMPACT_MODES: readonly CompactMode[] = ["remote", "tail", "local", "fork"]

/** Trigger reasons the tool accepts (subset of core `CompactReason`). */
export const COMPACT_REASONS: readonly CompactTriggerReason[] = ["manual", "auto"]

/** Mirror of core `DEFAULT_KEEP_TAIL`, for display when `tail` is unset. */
export const DEFAULT_KEEP_TAIL = 6

/** Validated tool input. `reason` always resolves (default `auto`). */
export interface CompactArgs {
  mode?: CompactMode
  keepTail?: number
  focus?: string
  reason: CompactTriggerReason
}

export type ArgsValidation = { ok: true; value: CompactArgs } | { ok: false; error: string }

/** Validate raw tool input into {@link CompactArgs}. */
export function validateCompactInput(raw: Record<string, unknown>): ArgsValidation {
  let mode: CompactMode | undefined
  if (raw.mode !== undefined) {
    if (typeof raw.mode !== "string" || !isCompactMode(raw.mode)) {
      return { ok: false, error: "`mode` must be one of: remote, tail, local, fork" }
    }
    mode = raw.mode.toLowerCase() as CompactMode
  }

  let keepTail: number | undefined
  if (raw.tail !== undefined) {
    if (typeof raw.tail !== "number" || !Number.isInteger(raw.tail) || raw.tail < 0) {
      return { ok: false, error: "`tail` must be an integer >= 0" }
    }
    keepTail = raw.tail
  }

  let focus: string | undefined
  if (raw.focus !== undefined) {
    if (typeof raw.focus !== "string") {
      return { ok: false, error: "`focus` must be a string" }
    }
    if (raw.focus.trim().length > 0) focus = raw.focus
  }

  let reason: CompactTriggerReason = "auto"
  if (raw.reason !== undefined) {
    if (typeof raw.reason !== "string" || !isCompactReason(raw.reason)) {
      return { ok: false, error: "`reason` must be one of: manual, auto" }
    }
    reason = raw.reason as CompactTriggerReason
  }

  const value: CompactArgs = { reason }
  if (mode !== undefined) value.mode = mode
  if (keepTail !== undefined) value.keepTail = keepTail
  if (focus !== undefined) value.focus = focus
  return { ok: true, value }
}

function isCompactMode(s: string): boolean {
  return (COMPACT_MODES as readonly string[]).includes(s.toLowerCase())
}

function isCompactReason(s: string): boolean {
  return (COMPACT_REASONS as readonly string[]).includes(s)
}
