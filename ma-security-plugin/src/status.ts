/** Pure status reports. Runtime snapshots are supplied by the caller. */
import type { ResolvedPolicy, RuleSetting } from "./config/types.ts"
import {
  count,
  DECISIONS,
  duration,
  LEVELS,
  pick,
  REASONS,
  SOURCES,
  STATUS_RULE_IDS,
  STATUSES,
  safeAgent,
  safeDrop,
  safeId,
  safeTool,
} from "./status/sanitize.ts"
import {
  SESSION_KEY_REASONS,
  type SecurityCapabilities,
  type SecurityStatusInput,
} from "./status/types.ts"

export { STATUS_RULE_IDS } from "./status/sanitize.ts"
export {
  SESSION_KEY_REASONS,
  type SecurityCapabilities,
  type SecurityStatusInput,
  type SecurityStatusInputProvider,
  type SecurityStores,
  type SessionKeyReason,
} from "./status/types.ts"

type Kind =
  | "status"
  | "level"
  | "fail"
  | "toggle"
  | "number"
  | "boolean"
  | "scope"
  | "decision"
  | "configError"
  | "profile"
  | "omitted"
const schema: Readonly<Record<string, Readonly<Record<string, Kind>>>> = {
  redactor: {
    status: "status",
    level: "level",
    scope: "scope",
    tag: "toggle",
    fail: "fail",
    cache_mb: "number",
    timeout_ms: "number",
  },
  guard: {
    status: "status",
    scope: "omitted",
    fail: "fail",
    timeout_ms: "number",
    unresolvedMarker: "decision",
    selfProtection: "boolean",
    configError: "configError",
  },
  entropy: { status: "status", threshold: "number", min_len: "number", allow: "omitted" },
  "known-value": { status: "status", min_len: "number", max_derived: "number" },
  vault: { status: "status", bash: "toggle", max_entries: "number", tools: "omitted" },
  audit: { status: "status", max_mb: "number", keep: "number" },
  cat: {
    status: "status",
    escalate_after: "number",
    escalate_total: "number",
    escalate_window: "number",
  },
  stores: {
    cache_mb: "number",
    max_entries: "number",
    max_derived: "number",
    audit_max_mb: "number",
    audit_keep: "number",
  },
  notes: { perResult: "number", repeatTurns: "number" },
}

function scalar(value: unknown, kind: Kind): string | number | boolean {
  switch (kind) {
    case "status":
      return pick(value, STATUSES, "off")
    case "level":
      return pick(value, LEVELS, "off")
    case "fail":
      return pick(value, ["open", "closed"], "open")
    case "toggle":
      return pick(value, ["on", "off"], "off")
    case "number":
      return duration(value)
    case "boolean":
      return value === true
    case "scope":
      return pick(value, ["prompt", "history", "disk"], "prompt")
    case "decision":
      return pick(value, DECISIONS, "none")
    case "configError":
      return pick(value, ["none", "drop", "halt"], "none")
    case "profile":
      return pick(value, ["off", "steer", "guard", "strict"], "steer")
    case "omitted":
      return "omitted"
  }
}

export interface SecurityStatusSetting {
  key: string
  value: string | number | boolean
  origin: (typeof SOURCES)[number]
  flooredByLead: boolean
}

function policySettings(
  policy: ResolvedPolicy | undefined,
  floored: readonly string[],
): SecurityStatusSetting[] {
  if (!policy) return []
  const settings: SecurityStatusSetting[] = []
  const add = (key: string, value: unknown, kind: Kind) => {
    const origin = pick(policy.origin?.[key], SOURCES, "builtin")
    settings.push({
      key,
      value: scalar(value, kind),
      origin,
      flooredByLead: origin === "lead" || floored.includes(key),
    })
  }
  add("profile", policy.profile, "profile")
  add("disabled", policy.disabled, "boolean")
  add("failMode", policy.failMode, "fail")
  for (const [group, fields] of Object.entries(schema)) {
    const record = (group === "cat"
      ? policy.cat
      : group === "stores"
        ? policy.stores
        : group === "notes"
          ? policy.notes
          : policy.features?.[group as keyof ResolvedPolicy["features"]]) as unknown as
      | Record<string, unknown>
      | undefined
    for (const [key, kind] of Object.entries(fields)) add(`${group}.${key}`, record?.[key], kind)
  }
  return settings
}

function ruleReport(id: string, rule: RuleSetting | undefined, floored: readonly string[]) {
  const origin: Record<string, (typeof SOURCES)[number]> = {}
  const flooredKeys: string[] = []
  for (const key of [
    "status",
    "level",
    "min_len",
    "threshold",
    "allow",
    "scope",
    "read",
    "write",
  ]) {
    if (rule?.origin?.[key] !== undefined) origin[key] = pick(rule.origin[key], SOURCES, "builtin")
    if (origin[key] === "lead" || floored.includes(`${id}.${key}`)) flooredKeys.push(key)
  }
  const raw = rule?.decision
  const decision: string | Record<string, string> =
    typeof raw === "string" ? pick(raw, DECISIONS, "none") : {}
  if (typeof decision !== "string") {
    for (const variant of ["default-branch", "other", "deny-keyword"]) {
      if (raw && typeof raw === "object" && raw[variant] !== undefined)
        decision[variant] = pick(raw[variant], DECISIONS, "none")
    }
  }
  return {
    id,
    status: rule ? pick(rule.status, STATUSES, "off") : "uninitialized",
    level: pick(rule?.level, LEVELS, "off"),
    decision,
    origin,
    flooredKeys,
    ...(rule?.path
      ? {
          path: {
            read: pick(rule.path.read, DECISIONS, "none"),
            write: pick(rule.path.write, DECISIONS, "none"),
          },
        }
      : {}),
    ...(typeof rule?.min_len === "number" ? { min_len: count(rule.min_len) } : {}),
    ...(typeof rule?.threshold === "number" ? { threshold: duration(rule.threshold) } : {}),
  }
}

function capabilities(input: SecurityStatusInput): SecurityCapabilities {
  const c = input.capabilities
  return {
    copyToolInput: c?.copyToolInput === true,
    compaction: c?.compaction === true,
    failClosed: c?.failClosed === true,
    finalPhase: c?.finalPhase === true,
    contentFilter: c?.contentFilter === true,
    memorySave: c?.memorySave === true,
    policyHandoff: c?.policyHandoff === true,
    ask: c?.ask === true,
    userNotice: c?.userNotice === true,
  }
}

/** Build both forms from the same sanitized snapshot. Never copies raw policy data. */
export function buildSecurityStatus(input: SecurityStatusInput = {}) {
  const policy = input.policy
  const floored = input.flooredKeys ?? []
  const settings = policySettings(policy, floored)
  const supplied = new Map((input.rules ?? []).filter((r) => safeId(r.id)).map((r) => [r.id, r]))
  const rules = STATUS_RULE_IDS.map((id) => {
    let rule = supplied.get(id)
    if (!rule && policy) {
      try {
        rule = policy.rules.lookup(id)
      } catch {
        /* An unavailable rule stays uninitialized. */
      }
    }
    return ruleReport(id, rule, floored)
  })
  const c = capabilities(input)
  const notices: string[] = []
  if (!c.compaction) notices.push("compaction not covered")
  if (!c.copyToolInput) notices.push("derived cap unavailable: copy input not covered")
  if (!c.failClosed) notices.push("fail closed not covered")
  if (!c.finalPhase) notices.push("final phase not covered")
  if (!c.contentFilter) notices.push("history and disk unavailable: prompt scope only")
  if (!c.memorySave) notices.push("inline memory saves not covered")
  if (!c.policyHandoff) notices.push("tighten-only policy handoff not covered")
  if (!c.ask) notices.push("ask acts as a note")
  if (!c.userNotice) notices.push("notes and autofix are model-only")
  const malformedLeadFloor =
    input.malformedLeadFloor === true ||
    (input.droppedClauses ?? policy?.dropped ?? []).some(
      (drop) =>
        drop.source === "lead" &&
        (drop.reason === "lead policy is not JSON" ||
          drop.reason === "lead policy has a bad shape"),
    )
  if (malformedLeadFloor) notices.push("malformed lead floor: steer floor applied")
  const strictEnforceable =
    c.failClosed &&
    c.copyToolInput &&
    c.compaction &&
    c.finalPhase &&
    c.contentFilter &&
    c.memorySave &&
    c.policyHandoff &&
    c.ask
  const profile = policy
    ? pick(policy.profile, ["off", "steer", "guard", "strict"], "steer")
    : "uninitialized"
  if (profile === "strict" && !strictEnforceable) notices.push("strict not enforceable")
  const dropped = input.droppedClauses ?? policy?.dropped ?? []
  const disabledRules = (input.disabledRules ?? []).flatMap((r) => {
    const id = safeId(r.id)
    return id
      ? [
          {
            id,
            reason: pick(r.reason, REASONS, "unspecified"),
            builtin: r.builtin === true,
            state: r.builtin === true ? "disabled-builtin" : "skipped",
          },
        ]
      : []
  })
  const registryErrors = (input.registryErrors ?? []).flatMap((r) => {
    const id = safeId(r.id)
    return id ? [{ id, code: pick(r.code, REASONS, "internal-error") }] : []
  })
  const hitMap = new Map<string, { ruleId: string; agentId: string; count: number }>()
  for (const hit of input.hits ?? []) {
    const ruleId = safeId(hit.ruleId)
    if (!ruleId) continue
    const agentId = safeAgent(hit.agentId)
    const key = `${ruleId}:${agentId}`
    const prior = hitMap.get(key)
    hitMap.set(key, { ruleId, agentId, count: count((prior?.count ?? 0) + count(hit.count)) })
  }
  const hits = [...hitMap.values()]
  const recent = (input.recent ?? []).flatMap((r) => {
    const ruleId = safeId(r.ruleId)
    return ruleId
      ? [
          {
            ruleId,
            decision: pick(r.decision, DECISIONS, "none"),
            reason: pick(r.reason, REASONS, "unspecified"),
            tool: safeTool(r.tool),
            count: r.count === undefined ? 1 : count(r.count),
          },
        ]
      : []
  })
  const s = input.stores
  const stores = s
    ? {
        ...(s.cacheBytes !== undefined ? { cacheBytes: count(s.cacheBytes) } : {}),
        vaultEntries: count(s.vaultEntries),
        derivedEntries: count(s.derivedEntries),
        knownWholeToken: count(s.knownWholeToken),
        knownSubstring: count(s.knownSubstring),
        tagCollisions: {
          vault: count(s.tagCollisions?.vault),
          index: count(s.tagCollisions?.index),
        },
        derivedEvictions: count(s.derivedEvictions),
      }
    : null
  const json = {
    phase: policy ? "resolved" : "uninitialized",
    profile,
    disabled: policy?.disabled === true,
    settings,
    rules,
    flooredByLead: policy?.floored === true,
    flooredKeys: settings
      .filter((s) => s.flooredByLead)
      .map((s) => s.key)
      .concat(rules.flatMap((r) => r.flooredKeys.map((k) => `${r.id}.${k}`))),
    malformedLeadFloor,
    sessionKey: {
      status: pick(
        input.sessionKeyStatus,
        ["loaded", "created", "replaced", "memory", "uninitialized"],
        "uninitialized",
      ),
      reason: pick(input.sessionKeyReason, SESSION_KEY_REASONS, "unavailable"),
    },
    disabledRules,
    registryErrors,
    hits,
    recent,
    counts: {
      disabledRules: input.disabledRules?.length ?? 0,
      disabledBuiltins: (input.disabledRules ?? []).filter((r) => r.builtin === true).length,
      skippedRules: (input.disabledRules ?? []).filter((r) => r.builtin !== true).length,
      registryErrors: input.registryErrors?.length ?? 0,
      droppedClauses: dropped.length,
      hitRows: input.hits?.length ?? 0,
      recent: input.recent?.length ?? 0,
      hits: count(hits.reduce((n, h) => n + h.count, 0)),
      notes: count(recent.filter((r) => r.decision === "note").reduce((n, r) => n + r.count, 0)),
      denies: count(recent.filter((r) => r.decision === "deny").reduce((n, r) => n + r.count, 0)),
    },
    tierHits: {
      tier1: count(input.tierHits?.tier1),
      tier2: count(input.tierHits?.tier2),
      deadline: count(input.tierHits?.deadline),
    },
    hookDurationsMs: (input.hookDurationsMs ?? []).slice(-10).map(duration),
    capabilities: c,
    enforceability: {
      strict: strictEnforceable,
      derivedCap: c.copyToolInput,
      compaction: c.compaction,
      historyAndDisk: c.contentFilter,
      failClosed: c.failClosed,
      tightenOnly: c.policyHandoff,
    },
    stores,
    audit: {
      auditWriteErrors: count(input.audit?.auditWriteErrors),
      degraded: input.audit?.degraded === true,
      errorReason: pick(input.audit?.errorReason, ["none", "audit-io-error"], "none"),
    },
    droppedClauses: dropped.map(safeDrop),
    notices,
  }
  const warnings = disabledRules
    .filter((rule) => rule.builtin)
    .map((rule) => `built-in rule disabled: ${rule.id} (${rule.reason})`)
  return { text: [...warnings, JSON.stringify(json, null, 2)].join("\n"), json }
}

export type SecurityStatusReport = ReturnType<typeof buildSecurityStatus>
/** Compatibility helpers, with no process-wide state. */
export function buildReport(input: SecurityStatusInput = {}) {
  return buildSecurityStatus(input).json
}
/** Render the compatibility report without runtime state. */
export function reportText(input: SecurityStatusInput = {}): string {
  return buildSecurityStatus(input).text
}
