/**
 * Merge and dedup rules (SPEC.md "Source discovery, precedence and merge").
 *
 * Results merge in source order. Deny wins over ask, ask over allow. Only a
 * rewrite from a result with the winning decision applies, and the first such
 * rewrite in source order is kept, so native wins ties. A deny never
 * rewrites. Context is concatenated in source order.
 *
 * @module engine/merge
 */

import type { CanonicalHook, CanonicalResult } from "./types.ts"

/** Merged result for one channel emit. */
export interface MergedResult {
  decision: CanonicalResult["decision"]
  reasons: string[]
  payload?: unknown
  context: string[]
  stopTurn?: { reason?: string }
  userMessages: string[]
}

const RANK: Record<CanonicalResult["decision"], number> = { none: 0, allow: 1, ask: 2, deny: 3 }

/** Merge decoded results that are already in source order. */
export function mergeResults(results: readonly CanonicalResult[]): MergedResult {
  const out: MergedResult = { decision: "none", reasons: [], context: [], userMessages: [] }
  for (const r of results) {
    if (RANK[r.decision] > RANK[out.decision]) out.decision = r.decision
    out.context.push(...r.context)
    if (r.userMessage) out.userMessages.push(r.userMessage)
    if (r.stopTurn && !out.stopTurn) out.stopTurn = r.stopTurn
  }
  // Reasons and the payload rewrite of the winning decision only, in source
  // order. A lower-rank rewrite never applies (review B3 MAJOR 2).
  for (const r of results) {
    if (r.decision !== out.decision) continue
    if (r.reason) out.reasons.push(r.reason)
    if (out.payload === undefined && r.payload !== undefined && r.decision !== "deny") {
      out.payload = r.payload
    }
  }
  return out
}

/** Entries of a string map, sorted by key, for a stable dedup key. */
function sortedEntries(m: Readonly<Record<string, string>> | undefined): Array<[string, string]> {
  return Object.entries(m ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

/** The normalized handler identity used by dedup. */
export function dedupKey(h: CanonicalHook): string {
  const handler =
    h.handler.type === "command"
      ? {
          t: "command",
          c: h.handler.command,
          a: h.handler.args ?? [],
          s: h.handler.shell ?? "",
          e: sortedEntries(h.handler.env),
        }
      : {
          t: "http",
          u: h.handler.url,
          hd: sortedEntries(h.handler.headers),
          v: [...(h.handler.allowedEnvVars ?? [])].sort(),
        }
  return JSON.stringify({
    handler,
    timeout: h.timeoutMs,
    ch: h.channel,
    m: h.matcher ?? "",
    x: h.dedupScope ?? "",
    fc: h.failClosed,
    as: h.async,
  })
}

/** Dedup rank of a scope: lower wins. User beats project. */
const SCOPE_RANK: Record<string, number> = { user: 0, project: 1 }

/**
 * Drop extra copies of an identical handler. Call it only on hooks that
 * already passed the trust, enabled and disable filters, so an untrusted
 * copy can never shadow a runnable one (review B3 BLOCKER).
 *
 * A user-scope copy always wins over a project-scope copy. Within one scope
 * the earliest source wins, so native beats any adapter. Plugin copies stay
 * separate. The kept hooks stay in source order.
 */
export function dedupHooks(hooks: readonly CanonicalHook[]): {
  kept: CanonicalHook[]
  dropped: CanonicalHook[]
} {
  const best = new Map<string, CanonicalHook>()
  for (const h of hooks) {
    if (h.source.scope === "plugin") continue
    const k = dedupKey(h)
    const cur = best.get(k)
    if (!cur || (SCOPE_RANK[h.source.scope] ?? 1) < (SCOPE_RANK[cur.source.scope] ?? 1)) {
      best.set(k, h)
    }
  }
  const kept: CanonicalHook[] = []
  const dropped: CanonicalHook[] = []
  for (const h of hooks) {
    if (h.source.scope === "plugin" || best.get(dedupKey(h)) === h) kept.push(h)
    else dropped.push(h)
  }
  return { kept, dropped }
}
