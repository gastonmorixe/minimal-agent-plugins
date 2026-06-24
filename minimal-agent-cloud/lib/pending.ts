/**
 * Phase D — the CLI-side drain of the submitPrompt write-path.
 *
 * The teleport WRITE half: a web/mobile client calls `submitPrompt(sid, content)`,
 * which persists a PENDING prompt server-side and hands the submitter a
 * `pendingId`. An ATTACHED CLI (this plugin) drains those pending prompts, CLAIMS
 * each under an optimistic lock (so two attached CLIs never double-run the same
 * prompt), injects the claimed prompt into its turn loop, and the resulting
 * `user`+`assistant` records flow back UP through the C2 uploader → recordAppended
 * → the original submitter sees the response. The `pendingId` is threaded onto the
 * injected prompt's user record so web/mobile can reconcile their optimistic entry
 * to the confirmed real record (contract v3, additive — coordinated with Mike+Tom).
 *
 * ## Decoupling + testability
 *
 * The GraphQL ops (`pendingPrompts` query, `claimPendingPrompt` mutation,
 * `pendingPromptAdded` subscription) are reached through an injected
 * {@link PendingGateway} port, so this module is pure orchestration: testable with
 * a fake gateway, and bound to Mike's real schema in ONE place (the gateway impl).
 * Result-typed throughout — the drain never throws into the turn loop.
 *
 * NOTE: the exact server field names/types are being firmed up with Mike. This
 * port reflects the proposed contract; only the gateway IMPL changes if a field
 * name shifts.
 *
 * @module lib/pending
 */

/** One pending prompt awaiting an attached CLI to run it. */
export interface PendingPrompt {
  readonly pendingId: string
  /** The prompt content the submitter sent (JSON scalar; usually a string or rich block). */
  readonly content: unknown
  readonly createdAt?: string
  readonly status?: string
}

/** Outcome of claiming a pending prompt under the server's optimistic lock. */
export type ClaimResult =
  | { readonly claimed: true; readonly pendingId: string; readonly content: unknown }
  | { readonly claimed: false; readonly pendingId: string; readonly reason: string }

/** A Result so callers never catch. */
export type PendingResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string }

/**
 * The server port: the three pending ops. The real impl (a thin GraphQL/WS client
 * sending the B4 Bearer) binds to Mike's schema; tests pass a fake.
 */
export interface PendingGateway {
  /** Drain the currently-pending prompts for a session (owner-gated by the token). */
  listPending(sid: string): Promise<PendingResult<PendingPrompt[]>>
  /** Claim one prompt under the optimistic lock. `claimed:false` = another CLI won. */
  claim(pendingId: string): Promise<PendingResult<ClaimResult>>
}

/**
 * What the drain hands back for each successfully-claimed prompt: the content to
 * inject into the turn loop, tagged with its `pendingId` so the resulting user
 * record can carry it (Tom's reconciliation key).
 */
export interface ClaimedPrompt {
  readonly pendingId: string
  readonly content: unknown
}

/** The injector the host gives us to enqueue a prompt into the CLI turn loop. */
export type PromptInjector = (prompt: ClaimedPrompt) => void

/**
 * Drain + claim all pending prompts for a session, injecting each claimed one.
 *
 * For each pending prompt: claim it; if WE won the lock, inject it (the resulting
 * records flow back up via C2). If another CLI won (`claimed:false`), skip it —
 * exactly-once across multiple attached CLIs. Network/gateway failures are
 * collected, never thrown: a flaky drain just retries next attach/tick.
 *
 * Returns the list of prompts WE claimed + injected (for diagnostics/tests).
 */
export async function drainAndClaim(
  sid: string,
  gateway: PendingGateway,
  inject: PromptInjector,
): Promise<PendingResult<ClaimedPrompt[]>> {
  const listed = await gateway.listPending(sid)
  if (!listed.ok) return { ok: false, reason: `listPending failed: ${listed.reason}` }

  const claimed: ClaimedPrompt[] = []
  for (const p of listed.value) {
    const res = await gateway.claim(p.pendingId)
    if (!res.ok) {
      // Transient claim failure: leave it pending, it'll be re-drained. Don't
      // abort the whole batch for one bad claim.
      continue
    }
    if (!res.value.claimed) {
      // Another CLI won the optimistic lock — skip (exactly-once).
      continue
    }
    const prompt: ClaimedPrompt = { pendingId: res.value.pendingId, content: res.value.content }
    try {
      inject(prompt)
      claimed.push(prompt)
    } catch {
      // Injection failed (host bus hiccup): the prompt is claimed server-side but
      // not run. It will be visible as claimed; recovery is a re-attach. We don't
      // throw into the caller.
    }
  }
  return { ok: true, value: claimed }
}
