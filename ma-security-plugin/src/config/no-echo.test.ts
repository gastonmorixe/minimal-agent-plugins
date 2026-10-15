// B7 fix3: a dropped clause never echoes a raw user value. A user who pastes a
// real token into the spec by mistake must not see it come back through the
// policy (dropped, origin, exported, hash input). Every check stringifies the
// WHOLE policy.

import { describe, expect, test } from "bun:test"

import { resolvePolicy } from "./resolve.ts"
import { DROP_REASONS, type ResolveInput } from "./types.ts"

const S = "TOKENSHAPE_abcDEF123456"

/** Spec strings with the sentinel in a bad clause. The first six are the
 * reviewer's probe cases. */
const SPECS: readonly string[] = [
  `secret.github.pat:status=${S}`,
  `redactor:${S}=1`,
  `${S}:on`,
  `cmd.cat:escalate_after=${S}`,
  `redactor:scope=${S}`,
  `profile:${S}`,
  `pii.email:level=${S}`,
  `pii.email:level=low|${S}`,
  `secret.${S}.*:on`,
  `secret.x.${S}:on`,
  `secret.x:${S}`,
  `*:${S}`,
  `redactor:fail=${S}`,
  `redactor:tag=${S}`,
  `vault:bash=${S}`,
  `vault:tools=${S}`,
  `entropy:threshold=${S}`,
  `pii.email:min_len=${S}`,
  `cmd.cat:${S}`,
  `cmd.cat:status=${S}`,
  S,
  `${S}:status=on`,
  `pii.email:${S}|on`,
  `pii.email:allow=a$${S}`,
]

/** JSON `rules` objects with the sentinel in a bad entry. */
const RULES: readonly unknown[] = [
  { [S]: "on" },
  { [S]: { status: "on" } },
  { [S]: 5 },
  { "pii.email": S },
  { "pii.email": { level: S } },
  { "pii.email": { [S]: "x" } },
  { "pii.email": { [S]: [{}] } },
  { "pii.email": { allow: [S, {}] } },
  { redactor: { scope: S } },
  { vault: { tools: [S] } },
  { "cmd.cat": { escalate_after: S } },
]

function leaks(input: ResolveInput): void {
  const p = resolvePolicy(input)
  expect(p.dropped.length).toBeGreaterThan(0)
  expect(JSON.stringify(p)).not.toContain(S)
  for (const d of p.dropped) {
    expect(Object.keys(d).sort()).toEqual(["key", "reason", "source", "target"])
    expect(DROP_REASONS).toContain(d.reason)
  }
}

const strictLead = (): string => resolvePolicy({ config: { profile: "strict" } }).exported

describe("no raw value in the policy: spec sources", () => {
  for (const spec of SPECS) {
    test(`env: ${spec}`, () => leaks({ env: { MINIMAL_AGENT_SECURITY_SPEC: spec } }))
    test(`config.spec: ${spec}`, () => leaks({ config: { spec } }))
    test(`plugin-opt: ${spec}`, () => leaks({ pluginOpt: spec }))
  }
})

describe("no raw value in the policy: config rules object and profile", () => {
  for (const rules of RULES) {
    test(`rules: ${JSON.stringify(rules)}`, () => leaks({ config: { rules } }))
  }
  test("config.profile", () => leaks({ config: { profile: S } }))
  test("config.spec not a string", () => leaks({ config: { spec: [S] } }))
  test("config.rules not an object", () => leaks({ config: { rules: S } }))
})

describe("no raw value in the policy: lead floor", () => {
  test("a clause that loosens the floor", () =>
    leaks({
      env: {
        MINIMAL_AGENT_SECURITY_RESOLVED: strictLead(),
        MINIMAL_AGENT_SECURITY_SPEC: `entropy:allow=${S}`,
      },
    }))
  test("a profile clause that loosens the floor", () =>
    leaks({
      env: { MINIMAL_AGENT_SECURITY_RESOLVED: strictLead() },
      config: { spec: "profile:steer" },
    }))
  const forged: readonly unknown[] = [
    { v: 1, profile: "guard", layers: [{ depth: 0, targets: { [S]: { status: ["on"] } } }] },
    { v: 1, profile: "guard", layers: [{ depth: 0, targets: { "pii.email": { [S]: ["x"] } } }] },
    { v: 1, profile: "guard", layers: [{ depth: 0, targets: { "pii.email": { level: [S] } } }] },
    { v: 1, profile: "guard", layers: [{ depth: 0, targets: { redactor: { scope: [S] } } }] },
    { v: 1, profile: S, layers: [] },
    { v: S },
  ]
  for (const lead of forged) {
    test(`forged lead: ${JSON.stringify(lead)}`, () =>
      leaks({ env: { MINIMAL_AGENT_SECURITY_RESOLVED: JSON.stringify(lead) } }))
  }
  test("lead that is not JSON", () => leaks({ env: { MINIMAL_AGENT_SECURITY_RESOLVED: `{${S}` } }))
  test("the export carries only validated clauses from a forged lead", () => {
    const lead = {
      v: 1,
      profile: "guard",
      layers: [{ depth: 0, targets: { "pii.email": { level: ["high", S] }, [S]: { x: [S] } } }],
    }
    const p = resolvePolicy({ env: { MINIMAL_AGENT_SECURITY_RESOLVED: JSON.stringify(lead) } })
    expect(p.exported).not.toContain(S)
    expect(JSON.stringify(p.rules.map)).not.toContain(S)
  })
})

describe("dropped shape", () => {
  test("target and key only when known", () => {
    const p = resolvePolicy({
      config: { spec: `pii.email:status=${S},redactor:${S}=1,${S}:on` },
    })
    expect(p.dropped).toEqual([
      { source: "config.spec", target: "pii.email", key: "status", reason: "bad status" },
      { source: "config.spec", target: "redactor", key: "<unknown-key>", reason: "unknown key" },
      {
        source: "config.spec",
        target: "<invalid-target>",
        key: "status",
        reason: "ids are lowercase",
      },
    ])
  })
})

// B7 fix3b: sentinels that pass the id grammar. A lowercase hex key and a UUID
// fit `[a-z0-9-]+`, so the grammar alone does not stop them. Only known targets
// and strict allow, scope and tools values may reach the policy.
const GRAMMAR_SENTINELS: readonly string[] = [
  "ghp0deadbeefcafe1234",
  "0f8fa2d4-9c3e-4b7a-8d21-5e6f7a8b9c0d",
]

function noSentinel(input: ResolveInput, s: string): void {
  const p = resolvePolicy(input)
  expect(p.dropped.length).toBeGreaterThan(0)
  expect(JSON.stringify(p)).not.toContain(s)
  expect(p.exported).not.toContain(s)
  for (const d of p.dropped) {
    expect(Object.keys(d).sort()).toEqual(["key", "reason", "source", "target"])
    expect(DROP_REASONS).toContain(d.reason)
  }
}

const leadWith = (targets: Record<string, Record<string, string[]>>): string =>
  JSON.stringify({ v: 1, profile: "guard", layers: [{ depth: 0, targets }] })

for (const G of GRAMMAR_SENTINELS) {
  const specs: readonly string[] = [
    `secret.${G}:on`,
    `secret.${G}:status=on`,
    `pii.${G}:off`,
    `cmd.${G}:on`,
    `path.${G}:on`,
    `secret.${G}.*:off`,
    `secret.x.${G}.*:off`,
    `secret.${G}:zz=1`,
    `secret.${G}:level=high`,
    `pii.email:allow=${G}`,
    `path.env-file:allow=${G}`,
    `path.ssh-private:allow=${G}`,
    `entropy:allow=${G}`,
    `pii.email:allow=ok|${G}`,
    `guard:scope=${G}`,
    `guard:scope=Bash|${G}`,
    `cmd.sudo:scope=${G}`,
    `vault:tools=${G}`,
  ]
  describe(`grammar-valid sentinel ${G}: spec sources`, () => {
    for (const spec of specs) {
      test(`env: ${spec}`, () => noSentinel({ env: { MINIMAL_AGENT_SECURITY_SPEC: spec } }, G))
      test(`config.spec: ${spec}`, () => noSentinel({ config: { spec } }, G))
      test(`plugin-opt: ${spec}`, () => noSentinel({ pluginOpt: spec }, G))
    }
  })
  describe(`grammar-valid sentinel ${G}: rules object`, () => {
    const rules: readonly unknown[] = [
      { [`secret.${G}`]: "on" },
      { [`secret.${G}`]: { status: "on" } },
      { [`secret.${G}.*`]: { status: "off" } },
      { [`secret.${G}`]: { zz: "1" } },
      { "pii.email": { allow: [G] } },
      { "pii.email": { allow: ["ok", G] } },
      { "path.env-file": { allow: G } },
      { entropy: { allow: [G] } },
      { guard: { scope: [G] } },
      { "cmd.sudo": { scope: ["Bash", G] } },
      { vault: { tools: [G] } },
    ]
    for (const r of rules) {
      test(`rules: ${JSON.stringify(r)}`, () => noSentinel({ config: { rules: r } }, G))
    }
  })
  describe(`grammar-valid sentinel ${G}: forged lead`, () => {
    const leads: readonly string[] = [
      leadWith({ [`secret.${G}`]: { status: ["on"] } }),
      leadWith({ [`secret.${G}.*`]: { status: ["off"] } }),
      leadWith({ [`secret.${G}`]: { zz: ["1"] } }),
      leadWith({ "pii.email": { allow: [G] } }),
      leadWith({ "path.env-file": { allow: [G] } }),
      leadWith({ guard: { scope: [G] } }),
      leadWith({ vault: { tools: [G] } }),
    ]
    for (const lead of leads) {
      test(`lead: ${lead}`, () => noSentinel({ env: { MINIMAL_AGENT_SECURITY_RESOLVED: lead } }, G))
    }
  })
}

describe("known targets and strict values (fix3b)", () => {
  test("unknown but grammar-valid target drops as <unknown-target>", () => {
    const p = resolvePolicy({ config: { spec: "secret.ghp0deadbeefcafe1234:zz=1" } })
    expect(p.dropped).toEqual([
      {
        source: "config.spec",
        target: "<unknown-target>",
        key: "<unknown-key>",
        reason: "unknown target",
      },
    ])
  })
  test("known ids, families, globs and features still apply", () => {
    const p = resolvePolicy({
      config: {
        spec: "pii.email:off,secret:high,cmd.git.*:warn,secret.known-value.*:on,cmd.cat:off,guard:scope=Bash|Read",
      },
    })
    expect(p.dropped).toEqual([])
    expect(p.rules.lookup("pii.email").status).toBe("off")
    expect(p.features.guard.scope).toEqual(["Bash", "Read"])
  })
  test("knownIds option admits a rule-pack id", () => {
    const knownIds = new Set(["secret.github.pat"])
    const p = resolvePolicy({ config: { spec: "secret.github.pat:off" }, knownIds })
    expect(p.dropped).toEqual([])
    expect(p.rules.lookup("secret.github.pat").status).toBe("off")
    const q = resolvePolicy({ config: { spec: "secret.github.pat:off" } })
    expect(q.dropped[0]?.reason).toBe("unknown target")
  })
  test("allow values: path globs and env names kept, random dropped", () => {
    const ok = resolvePolicy({
      config: {
        spec: "path.env-file:allow=.env.local|.env.test,path.ssh-private:allow=docs/*.pub",
      },
    })
    expect(ok.dropped).toEqual([])
    const bad = resolvePolicy({
      config: {
        rules: { "path.env-file": { allow: ["a/../b"] }, "path.git-hooks": { allow: "../x" } },
      },
    })
    expect(bad.dropped.map((d) => d.reason)).toEqual(["bad allow value", "bad allow value"])
  })
})
