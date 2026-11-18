/**
 * Session diagnostics → ACP notices.
 *
 * Core writes a diagnostic of a run to the session log as a `ch: "diag"`
 * entry. Most diagnostics are for logs, not for the user. This module lists
 * the diagnostics that the user must see, and makes an ACP notice for each.
 * `host-mode.ts` sends the notice with {@link noticeUpdate}, so a client
 * without `session.notices` gets the same text as answer text.
 *
 * Rules:
 * - Only a code in {@link DIAG_NOTICES} gives a notice. All other codes are dropped.
 * - `cache.break` (one diagnostic for each prompt-cache break, at notice
 *   level) gives a notice for EVERY break. It is not gated by severity and
 *   not limited to one per connection: the break is the fact. The notice is
 *   `warning` when the break is `actionable`, else `info` (for example
 *   `ttl_expired`, an expected miss after an idle time). The title is by
 *   `cause`.
 * - Flood control for a client without `session.notices` (the notice is sent
 *   as answer text): `cache.break` gives a notice only for an actionable
 *   break that starts a streak (`streak === 1`), or an actionable break
 *   after a break that was not actionable (the previous `cache.break` on
 *   this connection), or the first `cache.break` of the connection (it can
 *   have streak > 1, for example after a resume). The `streak` counts breaks of every cause, so an
 *   expected `ttl_expired` (streak 1) followed by a `prefix_changed`
 *   (streak 2) still sends the `prefix_changed`. The noticer keeps the
 *   last `actionable` value of each `cache.break` it sees, also the dropped
 *   ones, and also for a client with notices.
 * - `cache.anomaly` codes that are also a break (`prefix_changed`,
 *   `server_miss`, `ttl_expired`) give no notice, so one break is not two
 *   notices. The other codes (`markers_ignored_cold`,
 *   `below_min_block_size`: no cached prefix, so no break) stay.
 * - For the other rules, a diagnostic below warning severity (notice, info,
 *   debug) gives no notice, and a notice key (the code plus an optional
 *   sub-key from the diagnostic data) gives one notice for the life of the
 *   connection. So a cache anomaly that comes back each turn does not flood
 *   the editor.
 *
 * Pure. No I/O.
 *
 * @module diag-notices
 */

import type { AcpNotice } from "./notices.ts"

/** The slice of a core `DiagnosticEvent` this module reads. */
export interface DiagLike {
  readonly code: string
  readonly message: string
  /** Syslog severity (0 emergency ... 4 warning ... 7 debug). Absent: treated as a warning. */
  readonly severity?: number
  readonly data?: Readonly<Record<string, string | number | boolean>>
}

/** Options of one `notice` call of {@link createDiagNoticer}. */
export interface DiagNoticerOptions {
  /** True when the client advertised `clientCapabilities.session.notices`. Default: true. */
  readonly clientNotices?: boolean
}

/** The connection state that a {@link DiagNoticeRule.drop} reads. */
interface DiagNoticerState {
  /**
   * The `actionable` value of the previous `cache.break` on this connection.
   * Undefined: no `cache.break` yet.
   */
  readonly prevBreakActionable: boolean | undefined
}

/** How one diagnostic code becomes a notice. */
interface DiagNoticeRule {
  /** Data field that splits the code into separate one-time notices. */
  readonly subKey?: string
  /**
   * True: every diagnostic of this code gives a notice, at any severity and
   * with no one-per-connection limit. Default: false.
   */
  readonly everyTime?: boolean
  /** Drop a diagnostic before the other checks. Return true to drop it. */
  readonly drop?: (
    diag: DiagLike,
    opts: Required<DiagNoticerOptions>,
    state: DiagNoticerState,
  ) => boolean
  /** Build the notice. */
  readonly notice: (diag: DiagLike) => AcpNotice
}

/** Short titles for the `cache` plugin anomaly codes. Unknown codes use a generic title. */
const CACHE_TITLES: Readonly<Record<string, string>> = {
  markers_ignored_cold: "Prompt cache not used",
  below_min_block_size: "Prompt too short to cache",
}

/** `cache.anomaly` codes that are also a `cache.break`. The break gives the notice. */
const CACHE_BREAK_CODES: ReadonlySet<string> = new Set([
  "prefix_changed",
  "server_miss",
  "ttl_expired",
])

/** Titles of a `cache.break` notice by `cause`. Unknown causes use a generic title. */
const BREAK_TITLES: Readonly<Record<string, string>> = {
  ttl_expired: "Prompt cache expired",
  prefix_changed: "Prompt cache not read",
  server_miss: "Prompt cache missed (server)",
  thinking_lookback: "Prompt cache partly read",
  thinking_older_entry: "Prompt cache partly read",
  unknown: "Prompt cache not read",
}

/** Syslog warning severity. A larger number is less severe. */
const WARNING_SEVERITY = 4

/** Diagnostic codes that become notices. */
export const DIAG_NOTICES: Readonly<Record<string, DiagNoticeRule>> = {
  // ma-cache-plugin: source `cache.break`, data = the scalar fields of the
  // `cache.didBreak` payload (`cause`, `actionable`, `streak`, ...).
  "cache.break": {
    everyTime: true,
    // A client without notices gets an actionable break when it starts a
    // run of actionable breaks on this connection: streak 1, or the
    // previous break was not actionable, or no break came before (the first
    // break of a connection can have streak > 1, for example after a resume).
    drop: (d, o, st) =>
      !o.clientNotices &&
      !(d.data?.actionable === true && (d.data?.streak === 1 || st.prevBreakActionable !== true)),
    notice: (d) => ({
      severity: d.data?.actionable === true ? "warning" : "info",
      title: BREAK_TITLES[String(d.data?.cause ?? "")] ?? "Prompt cache not read",
      description: d.message,
    }),
  },
  // ma-cache-plugin: source `cache.anomaly`, data `{code}`.
  "cache.anomaly": {
    subKey: "code",
    drop: (d) => CACHE_BREAK_CODES.has(String(d.data?.code ?? "")),
    notice: (d) => ({
      severity: "warning",
      title: CACHE_TITLES[String(d.data?.code ?? "")] ?? "Prompt cache problem",
      description: d.message,
    }),
  },
}

/**
 * Tracks the notices already sent on one connection.
 *
 * @returns `notice(diag, opts)`: the notice for a diagnostic, or `undefined`
 *   when the code is not listed, the rule drops it, or its key was already
 *   sent. `opts.clientNotices` (default true) is the client capability, see
 *   {@link DiagNoticerOptions}.
 */
export function createDiagNoticer(): {
  notice(diag: DiagLike, opts?: DiagNoticerOptions): AcpNotice | undefined
} {
  const sent = new Set<string>()
  let prevBreakActionable: boolean | undefined
  return {
    notice(diag, opts = {}) {
      const rule = DIAG_NOTICES[diag.code]
      if (!rule) return undefined
      const state: DiagNoticerState = { prevBreakActionable }
      // Every cache.break moves the state, also a dropped one.
      if (diag.code === "cache.break") prevBreakActionable = diag.data?.actionable === true
      if (rule.drop?.(diag, { clientNotices: opts.clientNotices ?? true }, state)) return undefined
      if (rule.everyTime) return rule.notice(diag)
      if (diag.severity !== undefined && diag.severity > WARNING_SEVERITY) return undefined
      const sub = rule.subKey ? String(diag.data?.[rule.subKey] ?? "") : ""
      const key = `${diag.code}\u0000${sub}`
      if (sent.has(key)) return undefined
      sent.add(key)
      return rule.notice(diag)
    },
  }
}
