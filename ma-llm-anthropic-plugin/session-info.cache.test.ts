/**
 * Anthropic `fetchAnthropicSessionInfo` cache-only contract +
 * `primeAnthropicSessionInfo` in-flight dedupe.
 *
 * As a repo-separated plugin, the quota cache fills from REAL response headers
 * on the adapter's run path (see {@link setAnthropicRateLimits}) rather than a
 * standalone auth-driven cold probe (that needed `getAuth`/`readCredentials`
 * from core `src/auth`, which a moved plugin cannot reach — same design as the
 * openai plugin). `fetch` is cache-only + non-blocking; `prime` is a deduped
 * no-op kept for `ProviderPlugin.primeSessionInfo` API compatibility.
 *
 * @module llm/providers/anthropic/session-info.cache.test
 */

import { afterEach, describe, expect, it } from "bun:test"

import {
  _resetAnthropicPrimeInFlight,
  clearAnthropicRateLimits,
  fetchAnthropicSessionInfo,
  primeAnthropicSessionInfo,
  setAnthropicRateLimits,
} from "./session-info.ts"

/** Build a Headers carrying the given anthropic-ratelimit-* entries. */
function rlHeaders(entries: Record<string, string>): Headers {
  return new Headers(entries)
}

afterEach(() => {
  clearAnthropicRateLimits()
  _resetAnthropicPrimeInFlight()
})

// ---------------------------------------------------------------------------
// fetchAnthropicSessionInfo : cache-only
// ---------------------------------------------------------------------------

describe("fetchAnthropicSessionInfo (cache-only)", () => {
  it("returns no quota when the cache is cold", async () => {
    const info = await fetchAnthropicSessionInfo({ modelId: "claude-opus-4-8" })
    expect(info).not.toBeNull()
    // modelLabel is host-backfilled now, so the plugin omits it here.
    expect(info!.quota).toBeUndefined()
  })

  it("returns parsed quota windows when the cache has fresh headers", async () => {
    setAnthropicRateLimits(
      rlHeaders({
        "anthropic-ratelimit-unified-5h-utilization": "0.21",
        "anthropic-ratelimit-unified-7d-utilization": "0.08",
      }),
    )
    const info = await fetchAnthropicSessionInfo({ modelId: "claude-opus-4-8" })
    expect(info!.quota?.windows.map((w) => w.id)).toEqual(["5h", "7d"])
    expect(info!.quota?.windows[0]?.utilization).toBeCloseTo(0.21)
  })

  it("surfaces overage even when no quota windows are present", async () => {
    setAnthropicRateLimits(rlHeaders({ "anthropic-ratelimit-unified-overage-status": "allowed" }))
    const info = await fetchAnthropicSessionInfo({ modelId: "claude-opus-4-8" })
    expect(info!.quota?.overage).toEqual({ active: true })
    expect(info!.quota?.windows).toEqual([])
  })

  it("does NOT block on an aborted signal — cache-only, no I/O to cancel", async () => {
    const ac = new AbortController()
    ac.abort()
    const info = await fetchAnthropicSessionInfo({
      modelId: "claude-opus-4-8",
      signal: ac.signal,
    })
    expect(info).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// primeAnthropicSessionInfo : dedupe + no-op
// ---------------------------------------------------------------------------

describe("primeAnthropicSessionInfo", () => {
  it("resolves without touching the network (cache fills from real turns)", async () => {
    await expect(primeAnthropicSessionInfo({ modelId: "claude-opus-4-8" })).resolves.toBeUndefined()
  })

  it("dedupes concurrent calls into a single in-flight promise", async () => {
    const a = primeAnthropicSessionInfo({ modelId: "claude-opus-4-8" })
    const b = primeAnthropicSessionInfo({ modelId: "claude-opus-4-8" })
    // Reference identity is the dedupe contract. An `async`-wrapped
    // implementation would mint a fresh wrapper per call and break this.
    expect(a).toBe(b)
    await Promise.all([a, b])
    // After settle, the latch resets so a later prime is a NEW attempt.
    const c = primeAnthropicSessionInfo({ modelId: "claude-opus-4-8" })
    expect(c).not.toBe(a)
    await c
  })
})
