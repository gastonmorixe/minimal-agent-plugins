import { describe, expect, test } from "bun:test"

import { resolvePolicy } from "../config/resolve.ts"
import type { ResolvedPolicy, RuleSetting } from "../config/types.ts"
import { buildSecurityStatus, type SecurityStatusInput } from "../status.ts"

const sentinel = "SENTINEL_PRIVATE_VALUE_739"
const id = "secret.openai.api-key"
const policy = () => resolvePolicy({})

function poison(value: unknown): unknown {
  if (typeof value === "string") return sentinel
  if (Array.isArray(value)) return value.map(poison)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, poison(v)]))
  }
  return value
}

describe("pure security status", () => {
  test("default is uninitialized and lists only static rule ids", () => {
    const report = buildSecurityStatus()
    expect(report.json.phase).toBe("uninitialized")
    expect(report.json.rules.some((r) => r.id === id)).toBe(true)
    expect(report.text).toContain("uninitialized")
  })

  test("reports settings, lead floors, runtime counts and last ten durations", () => {
    const p = policy()
    const report = buildSecurityStatus({
      policy: p,
      rules: [p.rules.lookup(id)],
      flooredKeys: ["redactor.level", "not-a-key"],
      malformedLeadFloor: true,
      sessionKeyStatus: "memory",
      sessionKeyReason: "symlinked-dir",
      disabledRules: [{ id, reason: "self-test-failed", builtin: true }],
      registryErrors: [{ id, code: "compile-error" }],
      hits: [
        { ruleId: id, agentId: "lead", count: 4 },
        { ruleId: id, count: 2 },
      ],
      recent: [{ ruleId: id, decision: "deny", tool: "Read", count: 2 }],
      tierHits: { tier1: 3, tier2: 1, deadline: 2 },
      hookDurationsMs: Array.from({ length: 14 }, (_, i) => i),
      capabilities: {
        copyToolInput: false,
        compaction: false,
        failClosed: false,
        finalPhase: false,
        contentFilter: false,
        memorySave: false,
        policyHandoff: false,
        ask: false,
        userNotice: false,
      },
      stores: {
        cacheBytes: 42,
        vaultEntries: 2,
        derivedEntries: 3,
        knownWholeToken: 4,
        knownSubstring: 5,
        tagCollisions: { vault: 1, index: 2 },
        derivedEvictions: 6,
      },
    })
    expect(report.json.phase).toBe("resolved")
    expect(report.json.settings.find((s) => s.key === "redactor.level")?.flooredByLead).toBe(true)
    expect(report.json.sessionKey).toEqual({ status: "memory", reason: "symlinked-dir" })
    expect(report.json.hookDurationsMs).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
    expect(report.json.counts.notes).toBe(0)
    expect(report.json.counts.denies).toBe(2)
    expect(report.json.counts.hits).toBe(6)
    expect(report.json.disabledRules[0]?.state).toBe("disabled-builtin")
    expect(report.json.notices).toContain("compaction not covered")
    expect(report.json.notices).toContain("malformed lead floor: steer floor applied")
    expect(report.json.stores?.tagCollisions).toEqual({ vault: 1, index: 2 })
  })

  test("all string-bearing inputs are sanitized at the output boundary", () => {
    const base = policy()
    const poisoned = poison(base) as ResolvedPolicy
    const badPolicy = {
      ...poisoned,
      origin: { [sentinel]: sentinel, profile: sentinel, "redactor.level": sentinel },
      rules: {
        lookup: () =>
          ({ ...(poison(base.rules.lookup(id)) as RuleSetting), id: sentinel }) as RuleSetting,
        map: [{ source: sentinel, depth: 1, targets: { [sentinel]: { [sentinel]: [sentinel] } } }],
      },
    } as unknown as ResolvedPolicy
    const input = {
      policy: badPolicy,
      rules: [
        { ...(poison(base.rules.lookup(id)) as RuleSetting), id },
        { ...base.rules.lookup(id), id: sentinel },
      ],
      disabledRules: [
        { id, reason: sentinel, builtin: true },
        { id: sentinel, reason: sentinel, builtin: false },
      ],
      registryErrors: [
        { id, code: sentinel },
        { id: sentinel, code: sentinel },
      ],
      hits: [
        { ruleId: id, agentId: sentinel, count: 2 },
        { ruleId: sentinel, agentId: sentinel, count: 3 },
      ],
      recent: [
        { ruleId: id, decision: sentinel, reason: sentinel, tool: sentinel },
        { ruleId: sentinel, decision: sentinel, reason: sentinel, tool: sentinel },
      ],
      sessionKeyStatus: sentinel,
      sessionKeyReason: sentinel,
      flooredKeys: [sentinel],
      droppedClauses: [{ source: sentinel, target: sentinel, key: sentinel, reason: sentinel }],
    } as unknown as SecurityStatusInput
    expect(JSON.stringify(buildSecurityStatus(input))).not.toContain(sentinel)
    expect(buildSecurityStatus(input).json.counts.disabledRules).toBe(2)
    expect(buildSecurityStatus(input).json.counts.registryErrors).toBe(2)
    expect(buildSecurityStatus(input).json.counts.droppedClauses).toBe(1)
  })

  test("rejects future ids, arbitrary decision variant keys, reasons and agents", () => {
    const p = policy()
    const result = buildSecurityStatus({
      policy: p,
      rules: [
        { ...p.rules.lookup(id), decision: { [sentinel]: "deny" }, origin: { [sentinel]: "lead" } },
        { ...p.rules.lookup(id), id: "secret.future.key" },
      ],
      recent: [{ ruleId: id, decision: "note", reason: sentinel, tool: sentinel }],
      hits: [{ ruleId: id, agentId: sentinel, count: -9 }],
    })
    expect(JSON.stringify(result)).not.toContain("secret.future.key")
    expect(JSON.stringify(result)).not.toContain(sentinel)
    expect(result.json.recent[0]?.reason).toBe("unspecified")
    expect(result.json.hits[0]?.agentId).toBe("unknown")
    expect(result.json.counts.hits).toBe(0)
  })

  test("revalidates dropped targets and keys even when grammar-valid", () => {
    const p = policy()
    const result = buildSecurityStatus({
      policy: p,
      droppedClauses: [
        { source: "env", target: "secret.future.key", key: "future_key", reason: "unknown target" },
      ],
    })
    expect(result.json.droppedClauses[0]).toEqual({
      source: "env",
      target: "<unknown-target>",
      key: "<unknown-key>",
      reason: "unknown target",
    })
  })

  test("strict reports missing enforcement and capability gates", () => {
    const result = buildSecurityStatus({ policy: resolvePolicy({ config: { profile: "strict" } }) })
    expect(result.json.enforceability.strict).toBe(false)
    expect(result.json.enforceability.derivedCap).toBe(false)
    expect(result.json.notices).toContain("strict not enforceable")
  })
})
