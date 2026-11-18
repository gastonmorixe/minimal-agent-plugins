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
 * - A notice key (the code plus an optional sub-key from the diagnostic data)
 *   gives one notice for the life of the connection. So a cache anomaly that
 *   comes back each turn does not flood the editor.
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
  readonly data?: Readonly<Record<string, string | number | boolean>>
}

/** How one diagnostic code becomes a notice. */
interface DiagNoticeRule {
  /** Data field that splits the code into separate one-time notices. */
  readonly subKey?: string
  /** Build the notice. */
  readonly notice: (diag: DiagLike) => AcpNotice
}

/** Short titles for the `cache` plugin anomaly codes. Unknown codes use a generic title. */
const CACHE_TITLES: Readonly<Record<string, string>> = {
  markers_ignored_cold: "Prompt cache not used",
  below_min_block_size: "Prompt too short to cache",
  no_read_after_write: "Prompt cache not read",
  cache_evicted: "Prompt cache lost",
}

/** Diagnostic codes that become notices. */
export const DIAG_NOTICES: Readonly<Record<string, DiagNoticeRule>> = {
  // ma-cache-plugin: source `cache.anomaly`, data `{code}`.
  "cache.anomaly": {
    subKey: "code",
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
 * @returns `notice(diag)`: the notice for a diagnostic, or `undefined` when
 *   the code is not listed or its key was already sent.
 */
export function createDiagNoticer(): { notice(diag: DiagLike): AcpNotice | undefined } {
  const sent = new Set<string>()
  return {
    notice(diag) {
      const rule = DIAG_NOTICES[diag.code]
      if (!rule) return undefined
      const sub = rule.subKey ? String(diag.data?.[rule.subKey] ?? "") : ""
      const key = `${diag.code}\u0000${sub}`
      if (sent.has(key)) return undefined
      sent.add(key)
      return rule.notice(diag)
    },
  }
}
