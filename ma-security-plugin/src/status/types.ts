import type { ResolvedPolicy, RuleSetting, SourcedDrop } from "../config/types.ts"

export interface SecurityCapabilities {
  copyToolInput: boolean
  compaction: boolean
  failClosed: boolean
  finalPhase: boolean
  contentFilter: boolean
  memorySave: boolean
  policyHandoff: boolean
  ask: boolean
  userNotice: boolean
}

export interface SecurityStores {
  cacheBytes?: number
  vaultEntries: number
  derivedEntries: number
  knownWholeToken: number
  knownSubstring: number
  tagCollisions: { vault: number; index: number }
  derivedEvictions: number
}

/** Fixed codes only. Callers must not supply IO error messages. */
export const SESSION_KEY_REASONS = [
  "none",
  "symlinked-dir",
  "foreign-owner",
  "bad-mode",
  "hmac-error",
  "missing",
  "corrupt",
  "not-regular",
  "read-error",
  "write-error",
  "no-session",
  "unavailable",
] as const
export type SessionKeyReason = (typeof SESSION_KEY_REASONS)[number]

/** Plain snapshots only. This unit has no IO or runtime state. */
export interface SecurityStatusInput {
  policy?: ResolvedPolicy
  rules?: readonly RuleSetting[]
  disabledRules?: readonly { id: string; reason: string; builtin: boolean }[]
  registryErrors?: readonly { id: string; code: string }[]
  hits?: readonly { ruleId: string; agentId?: string; count: number }[]
  recent?: readonly {
    ruleId: string
    decision: string
    reason?: string
    tool?: string
    count?: number
  }[]
  tierHits?: { tier1: number; tier2: number; deadline: number }
  hookDurationsMs?: readonly number[]
  capabilities?: Partial<SecurityCapabilities>
  stores?: SecurityStores
  audit?: { auditWriteErrors: number; degraded: boolean; errorReason: "none" | "audit-io-error" }
  sessionKeyStatus?: "loaded" | "created" | "replaced" | "memory"
  sessionKeyReason?: SessionKeyReason
  flooredKeys?: readonly string[]
  malformedLeadFloor?: boolean
  droppedClauses?: readonly SourcedDrop[]
}

export type SecurityStatusInputProvider = () => SecurityStatusInput
