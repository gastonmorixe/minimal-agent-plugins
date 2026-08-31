/**
 * Cursor account enrichment: GetMe identity + GetCurrentPeriodUsage quota.
 *
 * Two decoupled halves:
 *
 * 1. **Pure codecs** ({@link decodeGetMeResponse},
 *    {@link parseCursorPeriodUsageInfo}, {@link accountSecretsFromBag} /
 *    {@link accountInfoFromBag}) — no network, no Node APIs. Usable from the
 *    host `auth-status` path via the provider-neutral
 *    `AuthCredentialInfo.details` projection in oauth-login.ts.
 * 2. **Best-effort probes** ({@link fetchCursorAccountEnrichment}) — wire calls
 *    used at login/refresh time to populate the persisted secret bag.
 *
 * Wire evidence (cursor-rev-eng proto + live probes 2026-08-21):
 * - `aiserver.v1.DashboardService/GetMe` — Connect unary, `application/proto`,
 *   empty request body. Response fields:
 *     1 auth_id str · 2 user_id i32 · 3 email · 4 first_name · 5 last_name
 *     6 workos_id str · 7 team_id i32 · 8 created_at str · 9 is_enterprise_user bool
 *     10 team_name str · 11 email_domain_type str · 12 country str
 * - `aiserver.v1.DashboardService/GetCurrentPeriodUsage` — Connect JSON,
 *   `{}` body, camelCase response (see session-info.ts). Spend values are cents.
 *
 * Enrichment failures never block login or refresh; secrets never flow into
 * error strings.
 *
 * @module llm/providers/cursor/account
 */

import { buildCursorHeaders } from "./headers.ts"
import { loadClientIds } from "./ids.ts"
import type { AuthSecretValue } from "./lib/provider-plugin.ts"
import { CURSOR_API_BASE } from "./wire-constants.ts"

/** Identity fields decoded from GetMeResponse. */
export type CursorAccountInfo = {
  authId?: string
  userId?: number
  email?: string
  firstName?: string
  lastName?: string
  workosId?: string
  teamId?: number
  teamName?: string
  createdAt?: string
  isEnterpriseUser?: boolean
  emailDomainType?: string
  country?: string
}

/** Quota snapshot fields from GetCurrentPeriodUsage (cents). */
export type CursorPeriodUsageInfo = {
  billingCycleStartMs?: number
  billingCycleEndMs?: number
  totalSpendCents?: number
  includedSpendCents?: number
  bonusSpendCents?: number
  planLimitCents?: number
  totalPercentUsed?: number
  onDemandLimitCents?: number
  onDemandUsedCents?: number
  onDemandRemainingCents?: number
  displayMessage?: string
}

/** Everything the plugin persists about an account, as a flat secret bag. */
export type CursorAccountSecrets = CursorAccountInfo & CursorPeriodUsageInfo

const PROBE_TIMEOUT_MS = 15_000

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return undefined
}

function msFromWire(value: unknown): number | undefined {
  const parsed = num(value)
  // Server sends cycle timestamps as decimal-string epoch millis.
  return parsed != null && parsed > 0 ? parsed : undefined
}

// ---------------------------------------------------------------------------
// Pure codecs (no network / no Node APIs)
// ---------------------------------------------------------------------------

// --- minimal protobuf decode for the known GetMeResponse shape ---

type PbField = { fieldNo: number; wireType: number; bytes?: Uint8Array; varint?: bigint }

function parseProtoFields(buf: Uint8Array): PbField[] {
  const fields: PbField[] = []
  let i = 0
  function varint(): bigint {
    let shift = 0n
    let result = 0n
    for (;;) {
      if (i >= buf.length) break
      const b = buf[i++]!
      result |= BigInt(b & 0x7f) << shift
      if ((b & 0x80) === 0) break
      shift += 7n
      if (shift > 70n) break
    }
    return result
  }
  while (i < buf.length) {
    const key = varint()
    const fieldNo = Number(key >> 3n)
    const wireType = Number(key & 7n)
    if (wireType === 2) {
      const len = Number(varint())
      fields.push({ fieldNo, wireType, bytes: buf.subarray(i, i + len) })
      i += len
    } else if (wireType === 0) {
      fields.push({ fieldNo, wireType, varint: varint() })
    } else {
      break // groups / fixed widths — not present in this message
    }
  }
  return fields
}

const GET_ME_STRING_FIELDS: Record<number, string> = {
  1: "authId",
  3: "email",
  4: "firstName",
  5: "lastName",
  6: "workosId",
  8: "createdAt",
  10: "teamName",
  11: "emailDomainType",
  12: "country",
}

/**
 * Decode a GetMeResponse protobuf payload.
 * Tolerant of unknown fields; exported for tests and reuse.
 */
export function decodeGetMeResponse(buf: Uint8Array): CursorAccountInfo {
  const out: Record<string, unknown> = {}
  for (const field of parseProtoFields(buf)) {
    if (field.wireType === 2 && field.bytes) {
      const name = GET_ME_STRING_FIELDS[field.fieldNo]
      if (name != null) out[name] = new TextDecoder().decode(field.bytes)
    } else if (field.wireType === 0 && field.varint != null) {
      if (field.fieldNo === 2) out.userId = Number(field.varint)
      if (field.fieldNo === 7) out.teamId = Number(field.varint)
      if (field.fieldNo === 9) out.isEnterpriseUser = field.varint !== 0n
    }
  }
  return out as CursorAccountInfo
}

/** Flatten a GetCurrentPeriodUsage body into persisted-friendly scalars. */
export function parseCursorPeriodUsageInfo(body: Record<string, unknown>): CursorPeriodUsageInfo {
  const plan = (body.planUsage ?? {}) as Record<string, unknown>
  const spend = (body.spendLimitUsage ?? {}) as Record<string, unknown>
  const info: CursorPeriodUsageInfo = {}
  const start = msFromWire(body.billingCycleStart)
  const end = msFromWire(body.billingCycleEnd)
  if (start != null) info.billingCycleStartMs = start
  if (end != null) info.billingCycleEndMs = end
  const totalSpend = num(plan.totalSpend)
  if (totalSpend != null) info.totalSpendCents = totalSpend
  const included = num(plan.includedSpend)
  if (included != null) info.includedSpendCents = included
  const bonus = num(plan.bonusSpend)
  if (bonus != null) info.bonusSpendCents = bonus
  const limit = num(plan.limit)
  if (limit != null) info.planLimitCents = limit
  const percent = num(plan.totalPercentUsed)
  if (percent != null) info.totalPercentUsed = percent
  const odLimit = num(spend.individualLimit)
  if (odLimit != null) info.onDemandLimitCents = odLimit
  const odUsed = num(spend.individualUsed)
  if (odUsed != null) info.onDemandUsedCents = odUsed
  const odRemaining = num(spend.individualRemaining)
  if (odRemaining != null) info.onDemandRemainingCents = odRemaining
  if (typeof body.displayMessage === "string") info.displayMessage = body.displayMessage
  return info
}

// ---------------------------------------------------------------------------
// Secret-bag codec: persist / read enrichment metadata alongside tokens
// ---------------------------------------------------------------------------

/**
 * Merge enrichment results into an existing secret bag (pure).
 *
 * Existing bag keys win only when the incoming value is undefined, so a probe
 * failure never erases previously stored metadata. Token fields are preserved
 * untouched.
 */
export function withAccountMetadata(
  secrets: Record<string, AuthSecretValue>,
  enrichment: CursorEnrichmentResult,
): Record<string, AuthSecretValue> {
  const merged: Record<string, AuthSecretValue> = { ...secrets }
  const sources: Array<CursorAccountInfo | CursorPeriodUsageInfo> = []
  if (enrichment.account) sources.push(enrichment.account)
  if (enrichment.periodUsage) sources.push(enrichment.periodUsage)
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined && !(key in merged && merged[key] !== undefined)) {
        // Fresh probe data should overwrite stale stored values, except when
        // the caller explicitly kept a richer local value.
        merged[key] = value as AuthSecretValue
      } else if (value !== undefined) {
        merged[key] = value as AuthSecretValue
      }
    }
  }
  return merged
}

const ACCOUNT_KEYS = [
  "authId",
  "userId",
  "email",
  "firstName",
  "lastName",
  "workosId",
  "teamId",
  "teamName",
  "createdAt",
  "isEnterpriseUser",
  "emailDomainType",
  "country",
  "billingCycleStartMs",
  "billingCycleEndMs",
  "totalSpendCents",
  "includedSpendCents",
  "bonusSpendCents",
  "planLimitCents",
  "totalPercentUsed",
  "onDemandLimitCents",
  "onDemandUsedCents",
  "onDemandRemainingCents",
  "displayMessage",
] as const

/**
 * Project a stored secret bag back into typed account metadata (pure).
 *
 * This is the read half used by `inspectCredential` → host `auth-status`.
 * Returns only keys this module owns; token material is never surfaced.
 */
export function accountInfoFromBag(secrets: Record<string, AuthSecretValue>): CursorAccountSecrets {
  const out: Partial<CursorAccountSecrets> = {}
  for (const key of ACCOUNT_KEYS) {
    const value = secrets[key]
    if (value === undefined || value === null) continue
    ;(out as Record<string, unknown>)[key] = value
  }
  return out as CursorAccountSecrets
}

/** True when the bag carries any account metadata key (pure). */
export function hasAccountMetadata(secrets: Record<string, AuthSecretValue>): boolean {
  return ACCOUNT_KEYS.some((key) => secrets[key] !== undefined && secrets[key] !== null)
}

// ---------------------------------------------------------------------------
// Best-effort network probes (login / refresh time)
// ---------------------------------------------------------------------------

export type CursorEnrichmentResult = {
  account?: CursorAccountInfo
  periodUsage?: CursorPeriodUsageInfo
}

async function jsonConnectHeaders(token: string): Promise<Record<string, string>> {
  let ids
  try {
    ids = await loadClientIds()
  } catch {
    ids = undefined
  }
  const headers = buildCursorHeaders({
    token,
    ids: ids ?? {
      machineId: "enrichment-fallback",
      clientKey: "enrichment-fallback",
      sessionId: crypto.randomUUID(),
    },
    streaming: false,
    clientType: "cli",
  })
  headers.accept = "application/json"
  headers["content-type"] = "application/json"
  return headers
}

/**
 * Best-effort enrichment probe against both endpoints. Never throws; each
 * endpoint fails independently and simply contributes nothing.
 */
export async function fetchCursorAccountEnrichment(
  token: string,
  options: {
    signal?: AbortSignal
    apiBase?: string
    /** Skip the GetMe identity call. */
    skipIdentity?: boolean
    /** Skip the usage quota call. */
    skipUsage?: boolean
  } = {},
): Promise<CursorEnrichmentResult> {
  const base = (options.apiBase ?? CURSOR_API_BASE).replace(/\/$/, "")
  const result: CursorEnrichmentResult = {}
  const timeoutSignal = AbortSignal.timeout(PROBE_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
  const headers = await jsonConnectHeaders(token)

  if (!options.skipIdentity) {
    try {
      const response = await fetch(`${base}/aiserver.v1.DashboardService/GetMe`, {
        method: "POST",
        headers: {
          ...headers,
          accept: "application/proto",
          "content-type": "application/proto",
        },
        body: new Uint8Array(0),
        signal,
      })
      if (response.ok) {
        result.account = decodeGetMeResponse(new Uint8Array(await response.arrayBuffer()))
      }
    } catch {
      // best-effort
    }
  }

  if (!options.skipUsage) {
    try {
      const response = await fetch(`${base}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`, {
        method: "POST",
        headers,
        body: "{}",
        signal,
      })
      if (response.ok) {
        const body: unknown = await response.json()
        if (body && typeof body === "object" && !Array.isArray(body)) {
          result.periodUsage = parseCursorPeriodUsageInfo(body as Record<string, unknown>)
        }
      }
    } catch {
      // best-effort
    }
  }

  return result
}
