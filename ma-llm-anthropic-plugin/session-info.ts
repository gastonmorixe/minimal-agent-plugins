/**
 * Anthropic session metadata (quota windows + context window + label).
 *
 * Implements TWO seams on `ProviderPlugin`:
 *
 *   - {@link fetchAnthropicSessionInfo} → `ProviderPlugin.fetchSessionInfo`.
 *     **Cache-only.** Read the in-process `quota-cache` (populated by every
 *     successful Anthropic response and by {@link primeAnthropicSessionInfo})
 *     and return neutral metadata. No network I/O, no `await getAuth()`,
 *     no blocking. The status-bar slot calls this on every tick + every
 *     `quota.headersReceived` event, so it MUST stay synchronous-ish to
 *     fit inside the scheduler's per-slot `timeoutMs`.
 *
 *   - {@link primeAnthropicSessionInfo} → `ProviderPlugin.primeSessionInfo`.
 *     **Cold-start cache warmup.** A bounded probe through the canonical
 *     plugin-owned `probeQuota`. Called fire-and-forget by the agent boot
 *     for the selected provider so the slot's first tick already finds a
 *     fresh cache. Self-deduplicates: a second prime while the first is in
 *     flight joins the same promise (no double probe).
 *
 * The split matters because, before, `fetchSessionInfo` itself ran the cold
 * probe inline. The slot's 8s `timeoutMs` (designed to detect *stuck*
 * handlers, not to bound network) repeatedly tripped on a cold-start
 * checkQuota POST and the footer never populated until the user typed their
 * first prompt — at which point the chat path's broadcast filled the cache
 * via `quota.headersReceived` and the slot caught up. Splitting prime from
 * fetch matches OpenAI / OpenRouter (already cache-only) and keeps the slot
 * non-blocking.
 *
 * The Anthropic `anthropic-ratelimit-unified-*` header shape is parsed HERE
 * (the provider owns its wire format); the renderer only ever sees neutral
 * {@link QuotaWindow}s.
 *
 * @module llm/providers/anthropic/session-info
 */

import type {
  ProviderSessionContext,
  ProviderSessionInfo,
  QuotaWindow,
} from "./lib/provider-plugin.ts"
import { findModel } from "./lib/registry.ts"

// ---------------------------------------------------------------------------
// Plugin-local rate-limit cache + host announce seam
// ---------------------------------------------------------------------------

/**
 * Optional host hook fired after this provider caches a fresh rate-limit
 * snapshot, so the `quota-status` footer can repaint THIS turn instead of
 * waiting for its heartbeat. The host (which owns the quota event bus) wires
 * this at load via {@link setQuotaRefreshHook}; a moved provider running
 * standalone (or in tests) leaves it unset and the announce is a harmless
 * no-op. This replaces the former `broadcastResponseRateLimits` +
 * `getLastRateLimits` imports from core `src/quota/*`, which a repo-separated
 * plugin cannot reach (mirrors the openai plugin's own local cache + hook).
 */
let quotaRefreshHook: ((rl: ReadonlyMap<string, string>) => void) | undefined

/** Host seam: wire the quota-refresh announce callback (or clear it). */
export function setQuotaRefreshHook(
  hook: ((rl: ReadonlyMap<string, string>) => void) | undefined,
): void {
  quotaRefreshHook = hook
}

/** One cache entry: the captured `anthropic-ratelimit-*` map + capture time. */
export interface CachedAnthropicRateLimits {
  rateLimits: ReadonlyMap<string, string>
  at: number
}

let cache: { rateLimits: Map<string, string>; at: number } | null = null

/**
 * Copy the `anthropic-ratelimit-*` (and the `overage-status`) headers from a
 * successful response into the module cache, stamped with `Date.now()`, and
 * announce a refresh so the footer repaints this turn. Non-throwing: a parse
 * failure on the hot request path must never break the stream. Returns the
 * captured map (for parity with the old broadcast return).
 */
export function setAnthropicRateLimits(headers: Headers): Map<string, string> {
  const copy = new Map<string, string>()
  try {
    headers.forEach((value, key) => {
      const lk = key.toLowerCase()
      if (lk.includes("ratelimit")) copy.set(lk, value)
    })
    if (copy.size === 0) return copy
    cache = { rateLimits: copy, at: Date.now() }
    quotaRefreshHook?.(copy)
  } catch {
    // Best-effort capture; never throw on the request path.
  }
  return copy
}

/** Read the latest snapshot, or `null` if nothing has been cached this session. */
export function getAnthropicRateLimits(): CachedAnthropicRateLimits | null {
  return cache
}

/** Reset the cache. Tests call this between cases so fixtures don't leak. */
export function clearAnthropicRateLimits(): void {
  cache = null
}

/**
 * Parse Anthropic's `anthropic-ratelimit-unified-<window>-<field>` headers into
 * neutral {@link QuotaWindow}s. Drops the synthetic `fallback`/`representative`
 * entries and `overage` (a power-user-only readout). The windowless AGGREGATE
 * form (`anthropic-ratelimit-unified-<field>`) becomes `id:"overall"` so the
 * startup banner can show the account-level line the raw headers used to feed.
 * Sorted 5h, 7d, other named windows, `overall` last. Windows without a
 * utilization value are dropped.
 */
export function parseAnthropicQuotaWindows(rl: ReadonlyMap<string, string>): QuotaWindow[] {
  const wins = new Map<string, { id: string; utilization?: number; resetAtMs?: number }>()
  const FIELDS = new Set(["utilization", "reset", "status", "remaining", "limit"])
  for (const [k, v] of rl) {
    let name: string
    let field: string
    const mw = k.match(/^anthropic-ratelimit-unified-([\w]+)-(\w+)$/)
    if (mw && !FIELDS.has(mw[1]!)) {
      name = mw[1]!
      field = mw[2]!
    } else {
      // Aggregate (windowless) form: anthropic-ratelimit-unified-<field>.
      const ma = k.match(/^anthropic-ratelimit-unified-(\w+)$/)
      if (!ma || !FIELDS.has(ma[1]!)) continue
      name = "overall"
      field = ma[1]!
    }
    if (name === "fallback" || name === "representative" || name === "overage") continue
    if (!wins.has(name)) wins.set(name, { id: name })
    const w = wins.get(name)!
    if (field === "utilization") w.utilization = Number(v)
    else if (field === "reset") w.resetAtMs = Number(v) * 1000
  }
  const order = (n: string) => (n === "5h" ? 0 : n === "7d" ? 1 : n === "overall" ? 3 : 2)
  return [...wins.values()]
    .filter((w) => w.utilization != null)
    .sort((a, b) => order(a.id) - order(b.id) || a.id.localeCompare(b.id))
    .map((w) => ({ id: w.id, utilization: w.utilization as number, resetAtMs: w.resetAtMs }))
}

/**
 * Parse Anthropic's `anthropic-ratelimit-unified-overage-status` header into
 * the neutral overage DTO. Values seen: `"off"` → `{ active: false }`,
 * `"allowed"` → `{ active: true }`. Returns `undefined` when the header is
 * absent (no overage concept reported this tick). Unlike the quota windows,
 * overage carries no utilization, so it never becomes a {@link QuotaWindow}.
 */
export function parseAnthropicOverage(
  rl: ReadonlyMap<string, string>,
): { active: boolean } | undefined {
  const ov = rl.get("anthropic-ratelimit-unified-overage-status")
  if (ov == null) return undefined
  return { active: ov === "allowed" }
}

function contextWindowFor(modelId: string): number | undefined {
  return findModel(modelId)?.capabilities.contextWindow
}

/**
 * Read Anthropic session metadata from the in-process cache. **Non-blocking:**
 * no `await` on network — the only side effect is a fire-and-forget re-probe
 * when the cache has aged out (see below). Returns at least context + label so
 * the footer keeps the model identity even when the cache is cold.
 *
 * Cache freshness policy:
 *
 *   - **Fresh** (`< FRESHNESS_MS`): render the cached windows directly.
 *   - **Stale** (`>= FRESHNESS_MS`, but populated at least once this session):
 *     STILL render the last-known windows AND kick a bounded background
 *     re-probe ({@link primeAnthropicSessionInfo}, fire-and-forget). The
 *     probe broadcasts `quota.headersReceived` on success, which refires
 *     this slot with fresh data within ~1s. Rendering stale-but-present
 *     beats blanking: the bars degrade gracefully (absolute reset
 *     timestamps keep counting down or simply drop) instead of the whole
 *     quota group vanishing off the footer.
 *   - **Cold** (never populated): no windows — the footer degrades to a
 *     context-only view until the first prime/turn lands.
 *
 * This fixes the "quota disappears after a few idle minutes" bug: once the
 * cold-start prime probe's headers aged past `FRESHNESS_MS`, the next
 * heartbeat / resize tick used to read `null` and drop the 5h/7d windows
 * with nothing to refresh them until the user's next API turn.
 */
export async function fetchAnthropicSessionInfo(
  ctx: ProviderSessionContext,
): Promise<ProviderSessionInfo | null> {
  const contextWindow = contextWindowFor(ctx.modelId)

  // Cache-only read (matches the openai plugin). The cache fills from real
  // response headers via {@link setAnthropicRateLimits} on the adapter's run
  // path; there is no separate auth-driven cold probe in the moved plugin.
  const cached = getAnthropicRateLimits()
  const rl = cached ? cached.rateLimits : null

  const windows = rl ? parseAnthropicQuotaWindows(rl) : []
  const overage = rl ? parseAnthropicOverage(rl) : undefined
  // Surface a quota snapshot when there's anything to report — windows OR an
  // overage readout (overage can be present even when no window crossed a
  // threshold). Both absent ⇒ no quota concept this tick (context-only footer).
  const quota = windows.length > 0 || overage ? { windows, overage } : undefined
  // modelLabel is intentionally omitted: the host backfills it from the model
  // registry (see core src/llm/provider-session.ts contextOnly) so the plugin
  // needs no `src/llm/model-label` import.
  return {
    contextWindow,
    quota,
  }
}

// ---------------------------------------------------------------------------
// Prime (cold-start cache warmup)
// ---------------------------------------------------------------------------

/**
 * Single in-flight prime promise. A concurrent {@link primeAnthropicSessionInfo}
 * call joins this rather than starting a second probe. Reset to `null` once the
 * probe settles, so a later cold tick (e.g. after the agent has been idle past
 * the freshness window) can prime again.
 */
let inFlightPrime: Promise<void> | null = null

/** Reset the in-flight latch. Tests only. */
export function _resetAnthropicPrimeInFlight(): void {
  inFlightPrime = null
}

/**
 * Cache-first quota warmup. As a repo-separated plugin, this no longer issues a
 * standalone auth-driven probe (that required `getAuth`/`readCredentials` from
 * core `src/auth`, which a moved plugin cannot reach). The quota cache instead
 * fills from real response headers on the adapter's run path (see
 * {@link setAnthropicRateLimits}), exactly like the openai plugin. This hook is
 * kept for API compatibility with the `ProviderPlugin.primeSessionInfo` seam and
 * simply resolves — the footer degrades to a context-only view until the first
 * real turn lands, then populates.
 *
 * Never throws. Self-deduplicates a concurrent caller via {@link inFlightPrime}.
 */
export function primeAnthropicSessionInfo(_ctx: ProviderSessionContext): Promise<void> {
  if (inFlightPrime) return inFlightPrime
  const work = Promise.resolve()
  inFlightPrime = work
  void work.finally(() => {
    if (inFlightPrime === work) inFlightPrime = null
  })
  return work
}
