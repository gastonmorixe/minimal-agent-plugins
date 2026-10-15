import { describe, expect, test } from "bun:test"

import { resolvePolicy, ruleSetting } from "./resolve.ts"
import type { ResolveInput } from "./types.ts"

const SPEC = "MINIMAL_AGENT_SECURITY_SPEC"

function r(input: ResolveInput) {
  return resolvePolicy(input)
}

describe("defaults", () => {
  test("empty input is steer", () => {
    const p = r({})
    expect(p.profile).toBe("steer")
    expect(p.disabled).toBe(false)
    expect(p.failMode).toBe("open")
    expect(p.cat).toEqual({
      status: "on",
      escalate_after: 3,
      escalate_total: 5,
      escalate_window: 50,
    })
    expect(p.stores.cache_mb).toBe(64)
    expect(p.notes.perResult).toBe(3)
    expect(p.origin.profile).toBe("builtin")
    expect(p.dropped).toEqual([])
    expect(p.hash).toMatch(/^[0-9a-f]{64}$/)
  })
  test("policy is frozen", () => {
    const p = r({})
    expect(Object.isFrozen(p)).toBe(true)
    expect(Object.isFrozen(p.features.redactor)).toBe(true)
    expect(Object.isFrozen(ruleSetting(p, "pii.email"))).toBe(true)
  })
  test("strict fail mode closed", () => {
    expect(r({ config: { profile: "strict" } }).failMode).toBe("closed")
  })
})

describe("precedence", () => {
  test("config.rules < config.spec < env < plugin-opt", () => {
    const p = r({
      config: { rules: { "pii.email": { level: "mid" } }, spec: "pii.email:level=high" },
      env: { [SPEC]: "pii.email:level=xhigh" },
    })
    expect(ruleSetting(p, "pii.email").level).toBe("xhigh")
    expect(ruleSetting(p, "pii.email").origin.level).toBe("env")
    const q = r({
      config: { rules: { "pii.email": { level: "mid" } }, spec: "pii.email:level=high" },
      env: { [SPEC]: "pii.email:level=xhigh" },
      pluginOpt: "pii.email:low",
    })
    expect(ruleSetting(q, "pii.email").level).toBe("low")
    expect(ruleSetting(q, "pii.email").origin.level).toBe("plugin-opt")
    const s = r({
      config: { rules: { "pii.email": { level: "high" } }, spec: "pii.email:level=mid" },
    })
    expect(ruleSetting(s, "pii.email").level).toBe("mid")
  })
  test("higher source wins over a more specific lower clause", () => {
    const p = r({ config: { spec: "pii.email:level=high" }, env: { [SPEC]: "pii:level=low" } })
    expect(ruleSetting(p, "pii.email").level).toBe("low")
  })
  test("profile from config, overridden by env", () => {
    expect(r({ config: { profile: "guard" } }).profile).toBe("guard")
    const p = r({ config: { profile: "guard" }, env: { [SPEC]: "profile:strict" } })
    expect(p.profile).toBe("strict")
    expect(p.origin.profile).toBe("env")
    expect(r({ config: { profile: "strict", spec: "profile:steer" } }).profile).toBe("steer")
  })
  test("per-rule clause wins over the profile default", () => {
    const p = r({ config: { profile: "guard", spec: "cmd.git.reset-hard:status=on" } })
    expect(ruleSetting(p, "cmd.git.reset-hard").decision).toBe("deny")
  })
  test("value=default removes a lower override", () => {
    const p = r({
      config: { spec: "pii.email:level=high" },
      env: { [SPEC]: "pii.email:level=default" },
    })
    expect(ruleSetting(p, "pii.email").level).toBe("low")
    expect(ruleSetting(p, "pii.email").origin.level).toBeUndefined()
    const q = r({
      config: { spec: "redactor:cache_mb=8" },
      env: { [SPEC]: "redactor:cache_mb=default" },
    })
    expect(q.stores.cache_mb).toBe(64)
  })
  test("feature keys reach stores", () => {
    const p = r({ env: { [SPEC]: "vault:max_entries=10,audit:max_mb=2,audit:keep=1" } })
    expect(p.stores.max_entries).toBe(10)
    expect(p.stores.audit_max_mb).toBe(2)
    expect(p.stores.audit_keep).toBe(1)
    expect(p.origin["vault.max_entries"]).toBe("env")
  })
})

describe("specificity", () => {
  test("exact id > longest glob > shorter glob > family > *", () => {
    const spec = "*:warn,secret:off,secret.*:on,secret.openai.*:high,secret.openai.api-key:low"
    const p = r({ config: { spec } })
    expect(ruleSetting(p, "secret.openai.api-key").level).toBe("low")
    expect(ruleSetting(p, "secret.openai.svcacct").level).toBe("high")
    expect(ruleSetting(p, "secret.github.token").status).toBe("on")
    expect(ruleSetting(p, "pii.card").status).toBe("warn")
  })
  test("order does not beat specificity", () => {
    const p = r({ config: { spec: "pii.email:off,pii.*:on" } })
    expect(ruleSetting(p, "pii.email").status).toBe("off")
  })
  test("tie: later clause wins", () => {
    expect(
      ruleSetting(r({ config: { spec: "pii.email:high,pii.email:mid" } }), "pii.email").level,
    ).toBe("mid")
    expect(ruleSetting(r({ config: { spec: "pii.*:high,pii.*:mid" } }), "pii.card").level).toBe(
      "mid",
    )
  })
  test("glob prefix needs a segment boundary", () => {
    const p = r({ config: { spec: "secret.open.*:high" } })
    expect(ruleSetting(p, "secret.openai.api-key").level).toBe("mid")
  })
})

describe("cmd.cat alias", () => {
  test("cat keys", () => {
    const p = r({ env: { [SPEC]: "cmd.cat:escalate_after=0,cmd.cat:escalate_window=10" } })
    expect(p.cat.escalate_after).toBe(0)
    expect(p.cat.escalate_window).toBe(10)
    expect(p.origin["cat.escalate_window"]).toBe("env")
  })
  test("cmd.cat:off turns the set off, a single id clause wins over it", () => {
    const p = r({ config: { spec: "cmd.cat:off,cmd.disk.format:on" } })
    expect(p.cat.status).toBe("off")
    expect(ruleSetting(p, "cmd.rm.recursive-root-or-home").decision).toBe("none")
    expect(ruleSetting(p, "cmd.disk.format").decision).toBe("deny")
  })
  test("cmd.* and * do not touch CAT ids", () => {
    const p = r({ config: { spec: "cmd:off,*:off" } })
    expect(ruleSetting(p, "cmd.disk.raw-write").decision).toBe("deny")
    expect(ruleSetting(p, "cmd.sudo").decision).toBe("none")
  })
  test("profile off runs no CAT rule", () => {
    const p = r({ config: { profile: "off", spec: "cmd.cat:on,cmd.disk.format:on" } })
    expect(p.cat.status).toBe("off")
    expect(ruleSetting(p, "cmd.disk.format").decision).toBe("none")
  })
})

describe("kill switch", () => {
  test("DISABLED=1 turns everything off", () => {
    const p = r({
      config: { profile: "strict", spec: "pii.email:high" },
      env: { MINIMAL_AGENT_SECURITY_DISABLED: "1" },
    })
    expect(p.disabled).toBe(true)
    expect(p.profile).toBe("off")
    expect(p.features.redactor.status).toBe("off")
    expect(p.features.guard.status).toBe("off")
    expect(p.cat.status).toBe("off")
    expect(ruleSetting(p, "pii.email").decision).toBe("none")
    expect(ruleSetting(p, "cmd.disk.format").decision).toBe("none")
    expect(p.origin.profile).toBe("env.disabled")
  })
  test("DISABLED=0 is not a kill", () => {
    expect(r({ env: { MINIMAL_AGENT_SECURITY_DISABLED: "0" } }).disabled).toBe(false)
  })
})

describe("lead floor (tighten only)", () => {
  const lead = r({ config: { profile: "guard", spec: "pii.email:high,cmd.cat:escalate_after=2" } })
  const env = { MINIMAL_AGENT_SECURITY_RESOLVED: lead.exported }

  test("child inherits the lead", () => {
    const c = r({ env })
    expect(c.floored).toBe(true)
    expect(c.profile).toBe("guard")
    expect(ruleSetting(c, "pii.email").level).toBe("high")
    expect(ruleSetting(c, "pii.email").origin.level).toBe("lead")
    expect(c.cat.escalate_after).toBe(2)
  })
  test("child may tighten", () => {
    const c = r({ env: { ...env, [SPEC]: "profile:strict,pii.email:xhigh,cmd.git.reset-hard:on" } })
    expect(c.profile).toBe("strict")
    expect(ruleSetting(c, "pii.email").level).toBe("xhigh")
    expect(c.dropped).toEqual([])
  })
  test("loosening clauses are dropped with a reason", () => {
    const c = r({
      env: {
        ...env,
        [SPEC]:
          "profile:steer,pii.email:low,cmd.cat:off,cmd.cat:escalate_after=0,redactor:scope=prompt,pii.*:off,pii.email:level=default",
      },
    })
    expect(c.profile).toBe("guard")
    expect(ruleSetting(c, "pii.email").level).toBe("high")
    expect(c.cat.status).toBe("on")
    expect(c.cat.escalate_after).toBe(2)
    expect(c.features.redactor.scope).toBe("history")
    expect(ruleSetting(c, "pii.card").level).toBe("mid")
    const clauses = c.dropped.map((d) => d.clause)
    expect(clauses).toContain("profile:steer")
    expect(clauses).toContain("pii.email:low")
    expect(clauses).toContain("cmd.cat:off")
    expect(clauses).toContain("cmd.cat:escalate_after=0")
    expect(clauses).toContain("redactor:scope=prompt")
    expect(clauses).toContain("pii.*:off")
    // A child reset only clears the child's own lower sources. The lead layer stays.
    expect(clauses).not.toContain("pii.email:level=default")
    for (const d of c.dropped) expect(d.reason).toMatch(/loosens lead/)
    expect(c.dropped.every((d) => d.source === "env")).toBe(true)
  })
  test("kill switch cannot loosen a floored child", () => {
    const c = r({ env: { ...env, MINIMAL_AGENT_SECURITY_DISABLED: "1" } })
    expect(c.disabled).toBe(false)
    expect(c.profile).toBe("guard")
    expect(c.dropped[0]?.source).toBe("env.disabled")
  })
  test("bad lead JSON is dropped, not thrown", () => {
    const c = r({ env: { MINIMAL_AGENT_SECURITY_RESOLVED: "{nope" } })
    // Review M2: a malformed lead still gives a steer floor.
    expect(c.floored).toBe(true)
    expect(c.profile).toBe("steer")
    expect(c.dropped[0]?.reason).toBe("lead policy is not JSON")
  })
  test("grandchild keeps the floor chain", () => {
    const child = r({ env: { ...env, [SPEC]: "pii.card:high" } })
    const g = r({
      env: { MINIMAL_AGENT_SECURITY_RESOLVED: child.exported, [SPEC]: "pii.email:low" },
    })
    expect(ruleSetting(g, "pii.email").level).toBe("high")
    expect(ruleSetting(g, "pii.card").level).toBe("high")
    expect(g.dropped.map((d) => d.clause)).toEqual(["pii.email:low"])
  })
})

describe("hash", () => {
  test("same input, same hash", () => {
    const a = r({ config: { spec: "pii.email:high,cmd.sudo:on" } })
    const b = r({ config: { spec: "pii.email:high,cmd.sudo:on" } })
    expect(a.hash).toBe(b.hash)
  })
  test("equivalent clause order gives the same hash", () => {
    const a = r({ config: { spec: "pii.email:high,cmd.sudo:on" } })
    const b = r({ config: { spec: " cmd.sudo:on , pii.email:high " } })
    expect(a.hash).toBe(b.hash)
  })
  test("different policy, different hash", () => {
    expect(r({}).hash).not.toBe(r({ config: { spec: "pii.email:high" } }).hash)
    expect(r({}).hash).not.toBe(r({ config: { profile: "guard" } }).hash)
  })
})

describe("never throws", () => {
  test("junk inputs", () => {
    const junk: unknown[] = [null, 1, "x", [], { rules: 5, spec: 7, profile: {} }]
    for (const config of junk) {
      expect(() => r({ config, env: { [SPEC]: ":::" } })).not.toThrow()
    }
    const p = r({ config: { profile: "nope" } })
    expect(p.profile).toBe("steer")
    expect(p.dropped[0]?.source).toBe("config.profile")
  })
  test("dropped clauses carry their source", () => {
    const p = r({ config: { spec: "bad:on" }, env: { [SPEC]: "pii.email:guard" }, pluginOpt: "x" })
    expect(p.dropped.map((d) => d.source)).toEqual(["config.spec", "env", "plugin-opt"])
  })
})

describe("ruleSetting", () => {
  test("path rules carry read and write", () => {
    const p = r({ config: { profile: "guard" } })
    expect(ruleSetting(p, "path.harness-auth").path).toEqual({ read: "deny", write: "deny" })
    expect(ruleSetting(r({}), "path.harness-auth").path).toEqual({ read: "note", write: "note" })
  })
  test("variant decision for force-push", () => {
    expect(ruleSetting(r({}), "cmd.git.force-push").decision).toEqual({
      "default-branch": "autofix",
      other: "none",
    })
  })
  test("redactor:level applies to on-by-default rules only", () => {
    const p = r({ config: { spec: "redactor:level=high" } })
    expect(ruleSetting(p, "secret.openai.api-key").level).toBe("high")
    expect(ruleSetting(p, "pii.phone").level).toBe("off")
  })
  test("rule-file defaults for unlisted ids", () => {
    expect(ruleSetting(r({}), "cmd.new.thing", { status: "on" }).decision).toBe("note")
  })
})
