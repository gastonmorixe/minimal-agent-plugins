import { describe, expect, test } from "bun:test"

import { parseRulesObject, parseSpec } from "./grammar.ts"

function brief(spec: string): string[] {
  return parseSpec(spec).clauses.map((c) => `${c.target}|${c.kind}|${c.key}=${c.value.join("|")}`)
}

function dropReasons(spec: string): string[] {
  return parseSpec(spec).dropped.map((d) => d.reason)
}

describe("parseSpec: SPEC-v3 examples", () => {
  test("profile:guard", () => {
    expect(brief("profile:guard")).toEqual(["profile|profile|profile=guard"])
  })
  test("redactor:scope=history,pii.email:low", () => {
    expect(brief("redactor:scope=history,pii.email:low")).toEqual([
      "redactor|feature|scope=history",
      "pii.email|id|level=low",
      "pii.email|id|status=on",
    ])
  })
  test("cmd ids and globs", () => {
    expect(brief("cmd.rm.recursive-root-or-home:status=on,cmd.disk.*:status=on")).toEqual([
      "cmd.rm.recursive-root-or-home|id|status=on",
      "cmd.disk.*|glob|status=on",
    ])
  })
  test("list value with |", () => {
    expect(brief("path.env-file:allow=.env.example|.env.sample")).toEqual([
      "path.env-file|id|allow=.env.example|.env.sample",
    ])
  })
  test("store keys", () => {
    expect(brief("vault:max_entries=50000,redactor:cache_mb=64")).toEqual([
      "vault|feature|max_entries=50000",
      "redactor|feature|cache_mb=64",
    ])
  })
  test("cmd.cat clauses", () => {
    expect(
      brief(
        "cmd.cat:status=on,cmd.cat:escalate_after=3,cmd.cat:escalate_total=5,cmd.cat:escalate_window=50",
      ),
    ).toEqual([
      "cmd.cat|cat|status=on",
      "cmd.cat|cat|escalate_after=3",
      "cmd.cat|cat|escalate_total=5",
      "cmd.cat|cat|escalate_window=50",
    ])
  })
  test("audit:max_mb=16 and keep", () => {
    expect(brief("audit:max_mb=16,audit:keep=3")).toEqual([
      "audit|feature|max_mb=16",
      "audit|feature|keep=3",
    ])
  })
  test("E examples: family, nested glob, guard keys", () => {
    expect(brief("secret.*:on,secret.openai.*:high,cmd.git.force-push:warn")).toEqual([
      "secret.*|glob|status=on",
      "secret.openai.*|glob|level=high",
      "secret.openai.*|glob|status=on",
      "cmd.git.force-push|id|status=warn",
    ])
    expect(brief("guard:fail=closed,guard:timeout_ms=500")).toEqual([
      "guard|feature|fail=closed",
      "guard|feature|timeout_ms=500",
    ])
  })
})

describe("parseSpec: shorthand by target", () => {
  test("off on profile is profile off", () => {
    expect(brief("profile:off")).toEqual(["profile|profile|profile=off"])
  })
  test("off on a rule is status off", () => {
    expect(brief("pii.email:off")).toEqual(["pii.email|id|status=off"])
  })
  test("ask is a status", () => {
    expect(brief("cmd.sudo:ask")).toEqual(["cmd.sudo|id|status=ask"])
  })
  test("family and * targets", () => {
    expect(brief("pii:off,*:warn")).toEqual(["pii|family|status=off", "*|all|status=warn"])
  })
  test("level shorthand on redactor", () => {
    expect(brief("redactor:high")).toEqual([
      "redactor|feature|level=high",
      "redactor|feature|status=on",
    ])
  })
})

describe("parseSpec: whitespace, empties, default", () => {
  test("whitespace trimmed and empty clauses ignored", () => {
    const r = parseSpec("  profile : strict ,, , pii.email : level = low | mid ,")
    expect(r.dropped).toEqual([
      { clause: "pii.email : level = low | mid", reason: "level takes one value" },
    ])
    expect(r.clauses.map((c) => c.value[0])).toEqual(["strict"])
  })
  test("empty string gives nothing", () => {
    expect(parseSpec("")).toEqual({ clauses: [], dropped: [] })
    expect(parseSpec("  ,  ,")).toEqual({ clauses: [], dropped: [] })
  })
  test("value=default is a reset clause", () => {
    const [c] = parseSpec("pii.email:level=default").clauses
    expect(c?.reset).toBe(true)
    expect(c?.value).toEqual(["default"])
  })
})

describe("parseSpec: drop cases", () => {
  const cases: Array<[string, string]> = [
    ["profile", "missing ':'"],
    ["pii.email:", "empty setting"],
    [":on", "empty target"],
    ["pii.email:=low", "empty key"],
    ["profile:low", "'low' is not a profile name"],
    ["profile:status=on", "key 'status' not valid for profile"],
    ["pii.email:guard", "'guard' not valid for pii.email"],
    ["cmd.sudo:low", "'low' not valid for cmd.sudo"],
    ["audit:low", "'low' not valid for audit"],
    ["pii.email:bogus=1", "unknown key 'bogus'"],
    ["pii.email:bash=on", "key 'bash' not valid for pii.email"],
    ["vault:level=mid", "key 'level' not valid for vault"],
    ["cmd.cat:level=mid", "key 'level' not valid for cmd.cat"],
    ["cmd.cat:escalate_window=0", "escalate_window out of range 1..1000"],
    ["cmd.cat:escalate_window=1001", "escalate_window out of range 1..1000"],
    ["cmd.cat:escalate_after=1001", "escalate_after out of range 0..1000"],
    ["cmd.cat:escalate_total=x", "escalate_total needs an integer"],
    ["cmd.cat.*:off", "cmd.cat is a fixed alias, not a glob"],
    ["secret.*.foo:on", "glob only at the end"],
    ["*.openai:on", "glob only at the end"],
    ["secret.OpenAI:on", "ids are lowercase"],
    ["secret.open_ai:on", "bad id segment 'open_ai'"],
    ["secret..x:on", "bad id segment ''"],
    ["foo.bar:on", "unknown target 'foo.bar'"],
    ["redactorx:on", "unknown target 'redactorx'"],
    ["pii.email:status=maybe", "bad status 'maybe'"],
    ["pii.email:level=huge", "bad level 'huge'"],
    ["redactor:scope=everywhere", "bad scope 'everywhere'"],
    ["guard:fail=sometimes", "bad fail 'sometimes'"],
    ["entropy:threshold=9", "threshold out of range (0, 8]"],
    ["pii.email:on|off", "shorthand takes one word"],
    ["path.env-file:allow=a||b", "empty item in allow"],
    ["path.env-file:allow=a$b", "bad character in value 'a$b'"],
    ["vault:tools=Edit|1x", "tools takes tool names"],
  ]
  for (const [clause, reason] of cases) {
    test(clause, () => {
      const r = parseSpec(clause)
      expect(r.clauses).toEqual([])
      expect(r.dropped).toEqual([{ clause, reason }])
    })
  }
  test("one bad clause does not drop the rest", () => {
    const r = parseSpec("pii.email:low,bogus:on,profile:strict")
    expect(r.clauses.map((c) => c.key)).toEqual(["level", "status", "profile"])
    expect(dropReasons("pii.email:low,bogus:on,profile:strict")).toEqual(["unknown target 'bogus'"])
  })
  test("never throws on junk input", () => {
    for (const junk of [null, undefined, 42, {}, [], "\u0000:\u0000", ":::,=,|"]) {
      expect(() => parseSpec(junk)).not.toThrow()
    }
    expect(parseSpec(42).dropped[0]?.reason).toBe("spec is not a string")
  })
})

describe("parseRulesObject", () => {
  test("E JSON example", () => {
    const r = parseRulesObject({
      redactor: { level: "mid" },
      "pii.email": { status: "on", level: "low" },
      "path.env-file": { allow: [".env.example", ".env sample"] },
    })
    expect(r.dropped).toEqual([])
    expect(r.clauses.map((c) => `${c.target}:${c.key}=${c.value.join("|")}`)).toEqual([
      "redactor:level=mid",
      "pii.email:status=on",
      "pii.email:level=low",
      "path.env-file:allow=.env.example|.env sample",
    ])
  })
  test("shorthand string and numbers", () => {
    const r = parseRulesObject({ "pii.email": "off", vault: { max_entries: 10 } })
    expect(r.clauses.map((c) => `${c.key}=${c.value[0]}`)).toEqual(["status=off", "max_entries=10"])
  })
  test("bad shapes drop", () => {
    expect(parseRulesObject("x").dropped[0]?.reason).toBe("rules is not an object")
    expect(parseRulesObject({ "pii.email": 3 }).dropped[0]?.reason).toBe(
      "rule body is not an object",
    )
    expect(parseRulesObject({ "pii.email": { allow: [{}] } }).dropped[0]?.reason).toBe(
      "bad JSON value for allow",
    )
  })
})
