// Tests for the B7 review findings (B7-review.md, majors 1-6, minors 7-11).

import { describe, expect, test } from "bun:test"

import { parseSpec } from "./grammar.ts"
import { resolvePolicy, ruleSetting } from "./resolve.ts"
import type { ResolveInput, RuleDefaults } from "./types.ts"

const SPEC = "MINIMAL_AGENT_SECURITY_SPEC"
const RESOLVED = "MINIMAL_AGENT_SECURITY_RESOLVED"

function r(input: ResolveInput) {
  return resolvePolicy(input)
}

function dropped(p: ReturnType<typeof r>): string[] {
  return p.dropped.map((d) => `${d.target}:${d.key}`)
}

describe("M1 guard:off does not turn CAT off", () => {
  test("guard:off keeps CAT deny, cat.status and lookup agree", () => {
    const p = r({ config: { spec: "guard:off" } })
    expect(p.cat.status).toBe("on")
    expect(ruleSetting(p, "cmd.disk.format").decision).toBe("deny")
    expect(ruleSetting(p, "cmd.rm.recursive-root-or-home").status).toBe("on")
    expect(ruleSetting(p, "cmd.sudo").decision).toBe("none")
  })
  test("only cmd.cat:off or an exact CAT id clause turns CAT off", () => {
    const p = r({ config: { spec: "guard:off,cmd.cat:off" } })
    expect(p.cat.status).toBe("off")
    expect(ruleSetting(p, "cmd.disk.format").decision).toBe("none")
    const q = r({ config: { spec: "guard:off,cmd.disk.format:off" } })
    expect(q.cat.status).toBe("on")
    expect(ruleSetting(q, "cmd.disk.format").decision).toBe("none")
    expect(ruleSetting(q, "cmd.disk.raw-write").decision).toBe("deny")
  })
})

describe("M2 malformed lead floor never fails open", () => {
  for (const bad of ["{nope", '{"v":2}', "[]"]) {
    test(`malformed ${bad}: steer floor, DISABLED ignored`, () => {
      const p = r({
        env: {
          [RESOLVED]: bad,
          MINIMAL_AGENT_SECURITY_DISABLED: "1",
          [SPEC]: "profile:off,pii.email:off",
        },
      })
      expect(p.disabled).toBe(false)
      expect(p.floored).toBe(true)
      expect(p.profile).toBe("steer")
      expect(ruleSetting(p, "pii.email").level).toBe("low")
      expect(p.dropped.some((d) => d.source === "lead")).toBe(true)
      expect(p.dropped.some((d) => d.source === "env.disabled")).toBe(true)
      expect(dropped(p)).toContain("pii.email:status")
    })
  }
})

describe("M3 floor holes", () => {
  const lead = r({ config: { profile: "guard", spec: "vault:tools=Edit" } })
  const env = { [RESOLVED]: lead.exported }
  const denyOn: RuleDefaults = { status: "on", decision: "deny" }

  test("unknown cmd id cannot loosen at lookup time", () => {
    const c = r({ env: { ...env, [SPEC]: "cmd.newrule:off" } })
    expect(ruleSetting(c, "cmd.newrule", denyOn).decision).toBe("deny")
  })
  test("unknown path glob cannot loosen at lookup time", () => {
    const c = r({ env: { ...env, [SPEC]: "path.newrule.*:off" } })
    expect(ruleSetting(c, "path.newrule.x", denyOn).path).toEqual({ read: "deny", write: "deny" })
  })
  test("tighter child still wins at lookup time", () => {
    const c = r({ env: { ...env, [SPEC]: "cmd.git.reset-hard:on" } })
    expect(ruleSetting(c, "cmd.git.reset-hard").decision).toBe("deny")
  })
  const looser = [
    "guard:timeout_ms=100",
    "redactor:timeout_ms=100",
    "audit:keep=1",
    "audit:max_mb=1",
    "known-value:max_derived=10",
    "known-value:min_len=40",
    "vault:max_entries=10",
    "vault:tools=Edit|Write",
    "redactor:tag=off",
    "redactor:scope=prompt",
  ]
  for (const clause of looser) {
    test(`feature key dropped: ${clause}`, () => {
      const c = r({ env: { ...env, [SPEC]: clause } })
      expect(dropped(c)).toEqual([clause.slice(0, clause.indexOf("="))])
      expect(c.dropped[0]?.reason).toBe("loosens lead floor")
    })
  }
  test("tighter feature keys are kept", () => {
    const spec = "guard:timeout_ms=5000,audit:keep=9,vault:max_entries=60000,redactor:scope=disk"
    const c = r({ env: { ...env, [SPEC]: spec } })
    expect(c.dropped).toEqual([])
    expect(c.features.guard.timeout_ms).toBe(5000)
  })
})

describe("M4 vault:tools allowlist", () => {
  for (const tool of [
    "Fetch",
    "WebSearch",
    "ChromeCDP",
    "IntercomSend",
    "SubAgentsSpawnAgent",
    "MemoryTool",
    "Bash",
    "NotebookEdit",
  ]) {
    test(`vault:tools rejects ${tool}`, () => {
      const out = parseSpec(`vault:tools=Edit|${tool}`)
      expect(out.clauses).toEqual([])
      expect(out.dropped[0]?.reason).toBe("vault tool not allowed")
    })
  }
  test("Edit and Write are accepted", () => {
    expect(parseSpec("vault:tools=Edit|Write").clauses.length).toBe(1)
    expect(parseSpec("vault:tools=Write").clauses.length).toBe(1)
  })
})

describe("M5 level shorthand on *", () => {
  test("*:mid emits only level", () => {
    const out = parseSpec("*:mid")
    expect(out.clauses.map((c) => `${c.key}=${c.value.join("|")}`)).toEqual(["level=mid"])
  })
  test("steer + *:mid keeps cmd decisions", () => {
    const p = r({ config: { spec: "*:mid" } })
    expect(ruleSetting(p, "cmd.sudo").decision).toBe("none")
    expect(ruleSetting(p, "cmd.rm.recursive-outside-cwd").decision).toBe("note")
    expect(ruleSetting(p, "path.harness-auth").path).toEqual({ read: "note", write: "note" })
  })
})

describe("M6 guard maps unlisted on to note", () => {
  test("unlisted on is note in guard", () => {
    const p = r({ config: { profile: "guard" } })
    expect(ruleSetting(p, "cmd.new.thing", { status: "on" }).decision).toBe("note")
    expect(ruleSetting(p, "path.new.thing", { status: "on" }).path).toEqual({
      read: "note",
      write: "note",
    })
  })
  test("declared deny stays deny in guard, never in steer", () => {
    const g = r({ config: { profile: "guard" } })
    expect(ruleSetting(g, "cmd.new.thing", { status: "on", decision: "deny" }).decision).toBe(
      "deny",
    )
    expect(ruleSetting(r({}), "cmd.new.thing", { status: "on", decision: "deny" }).decision).toBe(
      "note",
    )
  })
})

describe("m7 ask outside strict", () => {
  test("ask maps to note in steer and guard, ask in strict", () => {
    expect(ruleSetting(r({ config: { spec: "cmd.sudo:ask" } }), "cmd.sudo").decision).toBe("note")
    const g = r({ config: { profile: "guard", spec: "cmd.sudo:ask" } })
    expect(ruleSetting(g, "cmd.sudo").decision).toBe("note")
    const s = r({ config: { profile: "strict", spec: "cmd.sudo:ask" } })
    expect(ruleSetting(s, "cmd.sudo").decision).toBe("ask")
  })
  test("cmd.cat status takes only on or off", () => {
    for (const spec of ["cmd.cat:ask", "cmd.cat:warn", "cmd.cat:status=ask"]) {
      const out = parseSpec(spec)
      expect(out.clauses).toEqual([])
      expect(out.dropped[0]?.reason).toBe("CAT status takes on or off")
    }
    expect(r({ config: { spec: "cmd.cat:ask" } }).cat.status).toBe("on")
  })
})

describe("m8 hash canonical numbers", () => {
  test("007 and 7 hash the same", () => {
    const a = r({ config: { spec: "cmd.cat:escalate_after=7" } })
    const b = r({ config: { spec: "cmd.cat:escalate_after=007" } })
    expect(a.hash).toBe(b.hash)
    expect(b.cat.escalate_after).toBe(7)
  })
  test("threshold 4.50 and 4.5 hash the same", () => {
    const a = r({ config: { spec: "entropy:threshold=4.5" } })
    const b = r({ config: { spec: "entropy:threshold=4.50" } })
    expect(a.hash).toBe(b.hash)
  })
})

describe("m9 fallbacks keep the floor", () => {
  test("resolve catch keeps the lead floor and profile", () => {
    const lead = r({ config: { profile: "guard" } })
    const env = {
      [RESOLVED]: lead.exported,
      get [SPEC](): string {
        throw new Error("boom")
      },
    }
    const p = r({ env })
    expect(p.profile).toBe("guard")
    expect(p.floored).toBe(true)
  })
  test("resolve catch keeps the configured profile", () => {
    const config = {
      profile: "strict",
      get rules(): unknown {
        throw new Error("boom")
      },
    }
    expect(r({ config }).profile).toBe("strict")
  })
  test("lookup catch uses the profile base, CAT stays deny", () => {
    const defaults = {
      status: "on",
      get min_len(): number {
        throw new Error("boom")
      },
    } as unknown as RuleDefaults
    const p = r({})
    expect(() => ruleSetting(p, "cmd.disk.format", defaults)).not.toThrow()
    expect(ruleSetting(p, "cmd.disk.format", defaults).decision).toBe("deny")
    expect(ruleSetting(p, "cmd.rm.recursive-outside-cwd", defaults).decision).toBe("note")
  })
})

describe("m10 timeout_ms minimum", () => {
  test("timeout_ms below 100 is dropped", () => {
    for (const spec of ["guard:timeout_ms=0", "redactor:timeout_ms=99"]) {
      expect(parseSpec(spec).dropped[0]?.reason).toBe("out of range")
    }
    expect(parseSpec("guard:timeout_ms=100").clauses.length).toBe(1)
  })
})

describe("m11 force-push warn in steer", () => {
  test("warn drops the steer autofix to note (documented)", () => {
    const p = r({ config: { spec: "cmd.git.force-push:warn" } })
    expect(ruleSetting(p, "cmd.git.force-push").decision).toEqual({
      "default-branch": "note",
      other: "note",
    })
  })
})
