/**
 * `turn.willStart` chain listener: give the model one context line about a
 * target switch since its last turn, then forget it. See
 * `lib/target-notes.ts`. It never changes the user's text and never halts.
 */

import { takeSwitchNote } from "../lib/target-notes.ts"

/** Return the switch line as `additionalContext`, or pass through. */
export default function handle(_payload: unknown): { additionalContext: string[] } | undefined {
  const note = takeSwitchNote()
  return note === null ? undefined : { additionalContext: [note] }
}
