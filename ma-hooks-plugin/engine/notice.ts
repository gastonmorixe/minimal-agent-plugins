/**
 * The "untrusted hooks were skipped" notice (SPEC.md "Trust": "A hook that is
 * new or modified is skipped, with one notice per session").
 *
 * Pure: builds the `notification.emit` payload (`{ source, block, text }`, the
 * host contract in core `src/plugins/hooks/channels.ts:451-469`). The caller
 * decides when to emit it (once per session, see `handlers/dispatch.ts`).
 *
 * @module engine/notice
 */

import type { CanonicalHook } from "./types.ts"

/** The `source` tag of every notice this plugin emits. */
export const NOTICE_SOURCE = "hooks"

/** Max hooks listed in one notice. The rest are counted. */
export const MAX_NOTICE_HOOKS = 10

/** Max chars of a command preview. */
const PREVIEW_CHARS = 60

/** The `notification.emit` payload. */
export interface HooksNotice {
  source: typeof NOTICE_SOURCE
  block: { icon: string; title: string; info: string; color: string; body: string[] }
  text: string
}

/** One line, no control chars, at most `max` chars. */
function preview(s: string, max = PREVIEW_CHARS): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip control chars on purpose
  const flat = s.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat
}

/** A short preview of what the hook runs. */
export function handlerPreview(h: CanonicalHook): string {
  const x = h.handler
  if (x.type === "http") return preview(`POST ${x.url}`)
  return preview(x.args?.length ? [x.command, ...x.args].join(" ") : x.command)
}

/** One notice line for one hook. */
function hookLine(h: CanonicalHook): string {
  return `${h.trustKey} (${h.dialect} ${h.channel} ${h.source.path}): ${handlerPreview(h)}`
}

/** Max sessions remembered by {@link SessionNotices}. The oldest is dropped first. */
export const MAX_NOTICE_SESSIONS = 64

/**
 * Remembers, per session id, which untrusted hooks were already named in a
 * notice. A session gets one notice. It gets a new one only when a hook
 * appears (or changes) that its earlier notice did not name.
 */
export class SessionNotices {
  private readonly seen = new Map<string, Set<string>>()

  /**
   * The hooks in `hooks` that `sid` was not told about yet. Marks them as told.
   *
   * @param sid - Session id (`""` when unknown).
   * @param hooks - The untrusted hooks now.
   */
  take(sid: string, hooks: readonly CanonicalHook[]): CanonicalHook[] {
    let set = this.seen.get(sid)
    if (set) {
      this.seen.delete(sid)
    } else {
      set = new Set()
    }
    this.seen.set(sid, set)
    while (this.seen.size > MAX_NOTICE_SESSIONS) {
      const oldest = this.seen.keys().next().value
      if (oldest === undefined) break
      this.seen.delete(oldest)
    }
    const out: CanonicalHook[] = []
    for (const h of hooks) {
      const key = `${h.trustKey}\u0000${h.contentHash}`
      if (set.has(key)) continue
      set.add(key)
      out.push(h)
    }
    return out
  }

  /** Forget every session (tests). */
  clear(): void {
    this.seen.clear()
  }
}

/**
 * Build the notice for a list of skipped hooks, or undefined when the list is
 * empty.
 *
 * @param hooks - The untrusted hooks.
 */
export function untrustedNotice(hooks: readonly CanonicalHook[]): HooksNotice | undefined {
  if (hooks.length === 0) return undefined
  const lines = hooks.slice(0, MAX_NOTICE_HOOKS).map(hookLine)
  const more = hooks.length - lines.length
  if (more > 0) lines.push(`and ${more} more`)
  const how =
    "Review them with /hooks. Trust one with /hooks trust <key>, or a file with /hooks trust-all <file>."
  const later = "To trust all hooks for one run, start with --trust-hooks or MA_TRUST_HOOKS=1."
  const n = hooks.length
  const head = `${n} untrusted hook${n === 1 ? "" : "s"} skipped`
  return {
    source: NOTICE_SOURCE,
    block: {
      icon: "!",
      title: "Hooks",
      info: head,
      color: "gold",
      body: [...lines, how, later],
    },
    text: [`[hooks] ${head}:`, ...lines.map((l) => `  ${l}`), how, later].join("\n"),
  }
}
