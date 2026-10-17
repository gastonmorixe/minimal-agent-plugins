import { describe, expect, test } from "bun:test"

import { resolvePolicy } from "../config/resolve.ts"

import { CMD_RULES, PATH_RULES, REDACT_RULES, RULE_IDS } from "./index.ts"

describe("RULE_IDS feeds the config resolver (task 2r)", () => {
  test("RULE_IDS holds every rule id in the index, once", () => {
    const all = [...REDACT_RULES, ...PATH_RULES, ...CMD_RULES].map((r) => r.id)
    expect(RULE_IDS.size).toBe(all.length)
    for (const id of all) expect(RULE_IDS.has(id)).toBe(true)
  })

  test("every rule-pack id resolves with no drop when knownIds is passed", () => {
    for (const id of RULE_IDS) {
      const policy = resolvePolicy({
        config: { spec: `${id}:status=on` },
        env: {},
        knownIds: RULE_IDS,
      })
      expect(policy.dropped).toEqual([])
    }
  })

  test("without knownIds a rule-pack id outside the profile tables is dropped (safe default)", () => {
    const policy = resolvePolicy({
      config: { spec: "secret.github.token:status=on" },
      env: {},
    })
    expect(policy.dropped.length).toBe(1)
  })
})
