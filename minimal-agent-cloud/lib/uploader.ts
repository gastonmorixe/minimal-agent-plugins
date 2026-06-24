/**
 * The C2 uploader — ship a local session's new records to the cloud teleport
 * store via `ingestRecords`, resumably and without ever blocking the CLI.
 *
 * ## Invariants (Steve's spec + Mike's C1)
 *
 *   - SOURCE OF TRUTH is the local JSONL. The uploader is a best-effort mirror:
 *     if the backend is unreachable it logs nothing fatal and the CLI keeps
 *     writing locally; the next flush catches up. The turn loop NEVER waits on it.
 *   - GATED on `cloudEnabled` + a logged-in token. No token / cloud off ⇒ no-op.
 *   - IDEMPOTENT + RESUMABLE. We send `(records, fromClientLine)`; the backend
 *     dedupes by `(sid, clientLine)` and returns `acceptedThroughClientLine`,
 *     which we persist as our cursor. A crash mid-flush re-sends an overlapping
 *     range safely.
 *
 * The GraphQL `ingestRecords(sid, records:[JSON!]!, fromClientLine)` mutation
 * returns `{ acceptedThroughClientLine, headSeq }`.
 *
 * @module lib/uploader
 */

import { currentFlags, isEnabled } from "./feature-flags.ts"
import { readNewRecords } from "./jsonl-tail.ts"
import { loadAuth } from "./token-store.ts"
import { advanceCursor, readCursor } from "./upload-cursor.ts"

/**
 * The ingestRecords mutation (contract v1+). `sid` is `ID!` (not String!) per the
 * live schema; `records` is `[JSON!]!` (parsed line objects); `fromClientLine` is
 * the 0-based index of the first record in the batch.
 */
const INGEST_MUTATION =
  "mutation($sid:ID!,$records:[JSON!]!,$fromClientLine:Int!){ingestRecords(sid:$sid,records:$records,fromClientLine:$fromClientLine){acceptedThroughClientLine headSeq}}"

/** Outcome of a flush. A Result so the caller never has to catch. */
export type FlushOutcome =
  | {
      readonly ok: true
      readonly status: "uploaded"
      readonly sent: number
      readonly acceptedThroughClientLine: number
      readonly headSeq?: number
    }
  | { readonly ok: true; readonly status: "nothing-new" }
  | { readonly ok: true; readonly status: "skipped"; readonly reason: string }
  | { readonly ok: false; readonly reason: string }

/** Injected IO + config for a flush, so it's fully testable without disk/network. */
export interface FlushDeps {
  /** GraphQL endpoint (origin-root /graphql). */
  readonly graphqlUrl: string
  /** Read the session JSONL text. Caller wires this to fs; tests pass a fake. */
  readonly readSessionText: (sid: string) => string | null
  /** fetch impl (injectable). */
  readonly fetch: typeof fetch
  /** Env for cursor/token/flags resolution. Defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv
  /** Max records per ingest call (batch cap). Default 500. */
  readonly batchSize?: number
}

/**
 * Flush one session's new records to the cloud. Returns a {@link FlushOutcome};
 * never throws. Safe to call on every turn boundary.
 */
export async function flushSession(sid: string, deps: FlushDeps): Promise<FlushOutcome> {
  const env = deps.env ?? process.env

  // GATE 1: must be logged in + cloud enabled. This is where the feature flag
  // actually gates behavior.
  const auth = loadAuth(env)
  if (!auth) return { ok: true, status: "skipped", reason: "not logged in" }
  if (!isEnabled(currentFlags(env), "cloudEnabled")) {
    return { ok: true, status: "skipped", reason: "cloud disabled" }
  }
  if (!isEnabled(currentFlags(env), "teleportEnabled")) {
    return { ok: true, status: "skipped", reason: "teleport disabled" }
  }

  // Read the local JSONL (source of truth) + our cursor.
  const text = deps.readSessionText(sid)
  if (text === null) return { ok: true, status: "skipped", reason: "no local session file" }
  const cursor = readCursor(sid, env)
  const tail = readNewRecords(text, cursor.acceptedThroughClientLine)
  if (tail.records.length === 0) return { ok: true, status: "nothing-new" }

  // Batch (cap the payload). One batch per flush keeps it simple + bounded; the
  // next flush ships the rest. fromClientLine is the FIRST record's line index.
  const batchSize = deps.batchSize ?? 500
  const batch = tail.records.slice(0, batchSize)
  const fromClientLine = batch[0]?.clientLine ?? 0
  const records = batch.map((r) => r.record)

  // Send. Any failure ⇒ ok:false (the CLI keeps its local truth; we retry next
  // flush). We deliberately do NOT throw.
  let res: Response
  try {
    res = await deps.fetch(deps.graphqlUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${auth.accessToken}` },
      body: JSON.stringify({
        query: INGEST_MUTATION,
        variables: { sid, records, fromClientLine },
      }),
    })
  } catch (e) {
    return {
      ok: false,
      reason: `ingest request failed: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
  if (!res.ok) return { ok: false, reason: `ingest returned HTTP ${res.status}` }

  let body: {
    data?: { ingestRecords?: { acceptedThroughClientLine?: number; headSeq?: number } }
    errors?: { message?: string }[]
  }
  try {
    body = await res.json()
  } catch (e) {
    return { ok: false, reason: `ingest bad JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (body.errors && body.errors.length > 0) {
    return { ok: false, reason: `ingest GraphQL error: ${body.errors[0]?.message ?? "unknown"}` }
  }
  const ack = body.data?.ingestRecords
  if (!ack || typeof ack.acceptedThroughClientLine !== "number") {
    return { ok: false, reason: "ingest response missing acceptedThroughClientLine" }
  }

  // Persist the resumable cursor (monotonic).
  advanceCursor(sid, ack.acceptedThroughClientLine, ack.headSeq, env)
  return {
    ok: true,
    status: "uploaded",
    sent: records.length,
    acceptedThroughClientLine: ack.acceptedThroughClientLine,
    ...(typeof ack.headSeq === "number" ? { headSeq: ack.headSeq } : {}),
  }
}
