/**
 * The real {@link PendingGateway} impl — binds the CLI-drain orchestration to
 * Mike's locked Phase-D (contract v3) GraphQL ops, over plain `fetch` with the
 * B4 Bearer. The subscription half (`pendingPromptAdded`) is graphql-ws and lives
 * in `lib/pending-subscribe.ts`; this module is the request/reply pair the drain
 * needs (`pendingPrompts` query + `claimPendingPrompt` mutation).
 *
 * Locked contract (Mike, 2026-06-24):
 *   - `pendingPrompts(sid: ID!): [PendingPrompt!]!`  (owner-gated by Bearer);
 *     a PendingPrompt has pendingId, sid, content, status, createdAt.
 *   - `claimPendingPrompt(pendingId: ID!): ClaimResult!`; a ClaimResult has
 *     claimed, pendingId, content, reason (optimistic UPDATE ... WHERE
 *     status='pending' RETURNING; claimed:false + reason "already-claimed" when
 *     another CLI won).
 *
 * Result-typed, never throws: a network/GraphQL failure degrades to `ok:false`
 * and the drain leaves the prompt pending for the next attach/tick.
 *
 * @module lib/pending-gateway
 */

import type { ClaimResult, PendingGateway, PendingPrompt, PendingResult } from "./pending.ts"
import { loadAuth } from "./token-store.ts"

const PENDING_QUERY =
  "query($sid:ID!){pendingPrompts(sid:$sid){pendingId sid content status createdAt}}"
const CLAIM_MUTATION =
  "mutation($pendingId:ID!){claimPendingPrompt(pendingId:$pendingId){claimed pendingId content reason}}"

/** Inputs for {@link createPendingGateway}. */
export interface PendingGatewayDeps {
  /** GraphQL endpoint (origin-root /graphql). */
  readonly graphqlUrl: string
  /** Env for token resolution. Defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv
  /** fetch impl (injectable for tests). */
  readonly fetch?: typeof fetch
}

/** A small typed POST to the GraphQL endpoint with the Bearer. */
async function gql<T>(
  deps: Required<Pick<PendingGatewayDeps, "graphqlUrl" | "env" | "fetch">>,
  query: string,
  variables: Record<string, unknown>,
  pick: (data: Record<string, unknown>) => T | undefined,
): Promise<PendingResult<T>> {
  const auth = loadAuth(deps.env)
  if (!auth) return { ok: false, reason: "not logged in" }
  let res: Response
  try {
    res = await deps.fetch(deps.graphqlUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${auth.accessToken}` },
      body: JSON.stringify({ query, variables }),
    })
  } catch (e) {
    return { ok: false, reason: `request failed: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
  let body: { data?: Record<string, unknown>; errors?: { message?: string }[] }
  try {
    body = await res.json()
  } catch (e) {
    return { ok: false, reason: `bad JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (body.errors && body.errors.length > 0) {
    return { ok: false, reason: `GraphQL error: ${body.errors[0]?.message ?? "unknown"}` }
  }
  const value = body.data ? pick(body.data) : undefined
  if (value === undefined) return { ok: false, reason: "response missing expected field" }
  return { ok: true, value }
}

/** Coerce one raw pending-prompt object into the typed shape. */
function coercePending(o: unknown): PendingPrompt | null {
  if (o === null || typeof o !== "object") return null
  const r = o as Record<string, unknown>
  if (typeof r.pendingId !== "string") return null
  return {
    pendingId: r.pendingId,
    content: r.content,
    ...(typeof r.createdAt === "string" ? { createdAt: r.createdAt } : {}),
    ...(typeof r.status === "string" ? { status: r.status } : {}),
  }
}

/** Build the real gateway bound to the locked contract. */
export function createPendingGateway(deps: PendingGatewayDeps): PendingGateway {
  const full = {
    graphqlUrl: deps.graphqlUrl,
    env: deps.env ?? process.env,
    fetch: deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a)),
  }
  return {
    async listPending(sid): Promise<PendingResult<PendingPrompt[]>> {
      return gql(full, PENDING_QUERY, { sid }, (data) => {
        const raw = data.pendingPrompts
        if (!Array.isArray(raw)) return undefined
        const out: PendingPrompt[] = []
        for (const item of raw) {
          const p = coercePending(item)
          if (p) out.push(p)
        }
        return out
      })
    },
    async claim(pendingId): Promise<PendingResult<ClaimResult>> {
      return gql(full, CLAIM_MUTATION, { pendingId }, (data) => {
        const r = data.claimPendingPrompt as Record<string, unknown> | undefined
        if (!r || typeof r.claimed !== "boolean") return undefined
        if (r.claimed) {
          return { claimed: true, pendingId: String(r.pendingId ?? pendingId), content: r.content }
        }
        return {
          claimed: false,
          pendingId: String(r.pendingId ?? pendingId),
          reason: typeof r.reason === "string" ? r.reason : "not-claimed",
        }
      })
    },
  }
}
