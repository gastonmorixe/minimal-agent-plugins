/**
 * The pending-prompt RUNNER — ties the four CLI-drain pieces together into the
 * lifecycle Steve's spec describes: on attach, drain the backlog + open the live
 * subscription; on each live signal, drain again; claim+inject every prompt;
 * stamp pendingId on the resulting user record (via the uploader).
 *
 * ## Lifecycle (design-submitprompt-relay.md §5)
 *
 *   start():
 *     1. drain pendingPrompts(sid)  → claim+inject the backlog (catch-up).
 *     2. subscribe pendingPromptAdded(sid) → on each `next`, drain again (a new
 *        web/mobile submit while attached). The subscription is the LIVE
 *        fast-path; the re-drain (query) is the source-of-truth that also covers
 *        anything the push missed.
 *   stop(): unsubscribe.
 *
 * The actual claim+inject is delegated to {@link drainAndClaim} (exactly-once via
 * the optimistic lock) with the {@link PendingInjector} (prompt.inject + pendingId
 * queue). The uploader's `stampRecord` (wired to the SAME injector) tags the user
 * record on its way out, so the whole correlation stays in-plugin.
 *
 * Best-effort + never-throws: a failed drain/claim/subscribe logs via the
 * provided sink and is retried on the next signal/tick; nothing blocks the turn
 * loop. Gated by the caller (logged-in + cloudEnabled).
 *
 * Pure-ish: the gateway, subscriber, injector, and clock are injected, so the
 * whole runner is unit-testable without a network or the host.
 *
 * @module lib/pending-runner
 */

import { drainAndClaim, type PendingGateway } from "./pending.ts"
import type { PendingInjector } from "./pending-inject.ts"
import {
  PENDING_ADDED_SUBSCRIPTION,
  type Subscription,
  subscribePendingPrompts,
} from "./pending-subscribe.ts"

/** A subscribe fn matching {@link subscribePendingPrompts}, injected for tests. */
export type SubscribeFn = typeof subscribePendingPrompts

/** Inputs for {@link PendingRunner}. */
export interface PendingRunnerDeps {
  readonly sid: string
  /** ws:// graphql endpoint for the subscription. */
  readonly wsUrl: string
  /** Bearer for the subscription connection_init. */
  readonly bearer: string
  readonly gateway: PendingGateway
  readonly injector: PendingInjector
  /** Subscribe impl. Defaults to the real {@link subscribePendingPrompts}. */
  readonly subscribe?: SubscribeFn
  /** Diagnostic sink (best-effort). Defaults to a no-op. */
  readonly log?: (msg: string) => void
}

/**
 * Drives the pending-prompt drain for one session: backlog on start, then live
 * via the subscription. One instance per attached session; `stop()` on detach.
 */
export class PendingRunner {
  private sub: Subscription | null = null
  private started = false
  private draining = false

  constructor(private readonly deps: PendingRunnerDeps) {}

  /** Drain the backlog and open the live subscription. Idempotent. */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    await this.drainOnce()
    this.openSubscription()
  }

  /** Stop the live subscription. Idempotent. */
  stop(): void {
    this.started = false
    if (this.sub) {
      try {
        this.sub.unsubscribe()
      } catch {
        // best-effort
      }
      this.sub = null
    }
  }

  /**
   * Drain pending prompts once: claim+inject every prompt WE win. Coalesced —
   * if a drain is already running, the call is a no-op (the in-flight one will
   * pick up anything new; the next signal re-drains anyway).
   */
  async drainOnce(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      const res = await drainAndClaim(this.deps.sid, this.deps.gateway, this.deps.injector.inject)
      if (!res.ok) this.deps.log?.(`pending drain failed: ${res.reason}`)
      else if (res.value.length > 0)
        this.deps.log?.(`claimed + injected ${res.value.length} prompt(s)`)
    } finally {
      this.draining = false
    }
  }

  /** Open the pendingPromptAdded subscription; each event triggers a re-drain. */
  private openSubscription(): void {
    const subscribe = this.deps.subscribe ?? subscribePendingPrompts
    this.sub = subscribe<{ pendingPromptAdded?: { pendingId?: string } }>({
      url: this.deps.wsUrl,
      bearer: this.deps.bearer,
      query: PENDING_ADDED_SUBSCRIPTION,
      variables: { sid: this.deps.sid },
      // On any new pending prompt, re-drain via the query (source of truth). We
      // don't claim straight off the push payload — the query path already
      // claims under the optimistic lock, so re-draining is the one code path.
      onNext: () => {
        void this.drainOnce()
      },
      onError: (reason) => {
        this.deps.log?.(`pending subscription error: ${reason}`)
        // Drop the dead sub; the caller's periodic tick (or next attach) restarts
        // it and re-drains, so a transient WS drop self-heals.
        this.sub = null
      },
      onComplete: () => {
        this.sub = null
      },
    })
  }

  /** True while the live subscription is open (diagnostics/tests). */
  get subscribed(): boolean {
    return this.sub !== null
  }
}
