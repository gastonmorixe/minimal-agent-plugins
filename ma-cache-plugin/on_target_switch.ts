/**
 * Event handler for the host's `target.didSwitch` channel.
 *
 * The host sends it after each change of the live target (credential,
 * provider, model or effort), in a process with one session (TUI, ACP). A new
 * target starts a cold cache, so its first turn reads 0. That is correct, so
 * this handler resets the detectors, and that turn makes no warning.
 *
 * CONTRACT: the loader calls `fn(ctx)` with the event context. The payload
 * (`{from, to}`) is not read: each switch resets.
 *
 * @module cache/on_target_switch
 */

import { resetAllDetectors } from "./start.ts"

/** Reset all cache detectors. */
export default function handle(_ctx: unknown): void {
  resetAllDetectors()
}
