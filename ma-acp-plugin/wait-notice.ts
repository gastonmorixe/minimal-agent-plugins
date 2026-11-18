/**
 * Core wait status → ACP notice.
 *
 * While the loop waits (a retry after an error, or a provider quota that is
 * full), core sends a `status` event with the phase, the attempt number, the
 * wait time and the cause. ACP has no status update for this, so without a
 * notice the client shows nothing: the user cannot know that the session
 * waits, or that a change of the provider or the model continues it at once
 * (`session/set_config_option`, see core `sdk/target-change.ts`).
 *
 * Rules:
 * - Only the phases `retrying` and `waiting_for_quota` give a notice. A wait
 *   shorter than {@link WAIT_NOTICE_MIN_MS} gives none, so quick retries do
 *   not fill the editor.
 * - `waiting_for_quota`: one notice for each wait.
 * - `retrying`: one notice for the first wait of a prompt, then one for each
 *   wait of {@link LONG_WAIT_MS} or more. A retry wait that long is a
 *   warning (a provider that answers "retry after one hour"); a shorter one
 *   is info.
 * - The same wait (same phase and attempt) gives one notice, also when core
 *   reports it two times.
 *
 * The notice is a normal ACP notice (`notices.ts`): no new method and no
 * `_meta` key. Pure. No I/O, no clock.
 *
 * @module wait-notice
 */

import type { StatusFields } from "@minimal-agent/core/sdk/events"

import type { AcpNotice } from "./notices.ts"

/** A wait shorter than this gives no notice. */
export const WAIT_NOTICE_MIN_MS = 10_000
/**
 * A long retry wait. It is a warning, not info. After the first `retrying`
 * notice of a prompt, only a wait this long gives one more notice.
 */
export const LONG_WAIT_MS = 60_000

/** A wait time as plain text: seconds under a minute, then minutes, then hours and minutes. */
export function formatWait(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const rest = minutes % 60
  return rest === 0 ? `${minutes / 60} h` : `${Math.floor(minutes / 60)} h ${rest} min`
}

/** An epoch time as UTC text with no milliseconds, or `undefined` when it is not a valid time. */
function utcText(epochMs: number): string | undefined {
  const date = new Date(epochMs)
  return Number.isNaN(date.getTime()) ? undefined : `${date.toISOString().slice(0, 19)}Z`
}

const HOW_TO_CONTINUE = "To continue now, change the provider or the model."

/**
 * The notice for one wait status, with no rule about how often. `undefined`
 * for a phase that is not a wait, or a status with no wait time.
 *
 * The description has the same facts as the TUI status row for the same wait
 * (cli `startup/host-ports.ts`): the cause code and the number of the next
 * try. The wait time is a duration, not a count of seconds: a wait can be
 * hours. The words are plain ones that the STE gate of this repository
 * accepts (it reads each `description:` literal), so they are not the words
 * of the TUI row.
 */
export function waitNoticeFor(status: StatusFields): AcpNotice | undefined {
  const { phase, nextDelayMs, resetAt } = status
  if (phase !== "retrying" && phase !== "waiting_for_quota") return undefined
  if (nextDelayMs === undefined || !(nextDelayMs > 0)) return undefined
  const cause = status.cause ?? "error"
  const number = status.attempt === undefined ? "" : ` (try ${status.attempt})`
  const wait = formatWait(nextDelayMs)
  if (phase === "waiting_for_quota") {
    const at = resetAt === undefined ? undefined : utcText(resetAt)
    const when = at ? `${wait}, at ${at}` : wait
    return {
      severity: "warning",
      title: "Waiting for the provider quota",
      description: `[wait] The provider quota is full (${cause}). The session tries again in ${when}${number}. ${HOW_TO_CONTINUE}`,
    }
  }
  return {
    severity: nextDelayMs >= LONG_WAIT_MS ? "warning" : "info",
    title: "Waiting to retry",
    description: `[wait] The request had an error (${cause}). The session tries again in ${wait}${number}. ${HOW_TO_CONTINUE}`,
  }
}

/** Decides which wait statuses of one session become a notice. */
export interface WaitNoticer {
  /** The notice for a status, or `undefined` when the rules give none. */
  notice(status: StatusFields): AcpNotice | undefined
  /** A prompt ended: the next prompt starts with no wait reported. */
  reset(): void
}

/** Create the wait notice state for one ACP session. See the module doc for the rules. */
export function createWaitNoticer(): WaitNoticer {
  let lastKey: string | undefined
  let retryReported = false
  return {
    notice(status) {
      const built = waitNoticeFor(status)
      if (!built || (status.nextDelayMs ?? 0) < WAIT_NOTICE_MIN_MS) return undefined
      const key = `${status.phase}\u0000${status.attempt ?? ""}`
      if (key === lastKey) return undefined
      if (status.phase === "retrying") {
        if (retryReported && (status.nextDelayMs ?? 0) < LONG_WAIT_MS) return undefined
        retryReported = true
      }
      lastKey = key
      return built
    },
    reset() {
      lastKey = undefined
      retryReported = false
    },
  }
}
