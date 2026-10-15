import { describe, expect, test } from "bun:test"

import {
  CAT_DEFAULTS,
  CAT_IDS,
  CMD_TABLE,
  FEATURE_DEFAULTS,
  KNOWN_IDS,
  maxDecision,
  NOTE_CAPS,
  PATH_TABLE,
  PROFILE_META,
  ruleBase,
  STORE_DEFAULTS,
} from "./profiles.ts"
import type { Decision, ProfileName } from "./types.ts"

const ON: ProfileName[] = ["steer", "guard", "strict"]
const HALT_OR_ASK: Decision[] = ["deny", "ask"]

function allDecisions(p: ProfileName, id: string): Decision[] {
  const b = ruleBase(p, id)
  const out: Decision[] = [maxDecision(b.decision)]
  if (b.path) out.push(b.path.read, b.path.write)
  return out
}

describe("profiles", () => {
  test("steer: no deny or ask except the CAT set", () => {
    for (const id of KNOWN_IDS) {
      if (CAT_IDS.includes(id)) continue
      for (const d of allDecisions("steer", id)) expect(HALT_OR_ASK.includes(d)).toBe(false)
    }
    expect(PROFILE_META.steer.asksUser).toBe(false)
    expect(PROFILE_META.steer.haltsBeyondCat).toBe(false)
    expect(FEATURE_DEFAULTS.steer.guard.unresolvedMarker).toBe("note")
    expect(FEATURE_DEFAULTS.steer.guard.configError).toBe("drop")
    expect(FEATURE_DEFAULTS.steer.guard.fail).toBe("open")
    expect(FEATURE_DEFAULTS.steer.guard.selfProtection).toBe(false)
    expect(FEATURE_DEFAULTS.steer.entropy.status).toBe("off")
  })

  test("steer: only autofix is git force-push to the default branch", () => {
    const autofix = KNOWN_IDS.filter((id) => allDecisions("steer", id).includes("autofix"))
    expect(autofix).toEqual(["cmd.git.force-push"])
  })

  test("strict asks and halts", () => {
    expect(PROFILE_META.strict.asksUser).toBe(true)
    expect(PROFILE_META.strict.haltsBeyondCat).toBe(true)
    expect(FEATURE_DEFAULTS.strict.guard.fail).toBe("closed")
    expect(FEATURE_DEFAULTS.strict.guard.unresolvedMarker).toBe("deny")
    expect(FEATURE_DEFAULTS.strict.guard.configError).toBe("halt")
    expect(CMD_TABLE["cmd.git.force-push"]?.[2]).toEqual({
      "default-branch": "deny",
      other: "warn",
    })
  })

  test("CAT on and deny in every on-profile, none in off", () => {
    for (const p of ON) {
      expect(CAT_DEFAULTS[p].status).toBe("on")
      for (const id of CAT_IDS) expect(ruleBase(p, id).decision).toBe("deny")
    }
    expect(CAT_DEFAULTS.off.status).toBe("off")
    for (const id of CAT_IDS) expect(ruleBase("off", id).decision).toBe("none")
    expect(CAT_IDS.length).toBe(5)
  })

  test("off profile: every feature off, every rule none", () => {
    const f = FEATURE_DEFAULTS.off
    expect([f.redactor.status, f.guard.status, f["known-value"].status, f.vault.status]).toEqual([
      "off",
      "off",
      "off",
      "off",
    ])
    for (const id of KNOWN_IDS) for (const d of allDecisions("off", id)) expect(d).toBe("none")
  })

  test("feature matrix", () => {
    expect(ON.map((p) => FEATURE_DEFAULTS[p].redactor.scope)).toEqual(["prompt", "history", "disk"])
    expect(ON.map((p) => FEATURE_DEFAULTS[p].redactor.level)).toEqual(["mid", "mid", "mid"])
    expect(ON.map((p) => FEATURE_DEFAULTS[p].entropy.status)).toEqual(["off", "warn", "warn"])
    expect(ON.map((p) => FEATURE_DEFAULTS[p].guard.selfProtection)).toEqual([false, true, true])
    expect(FEATURE_DEFAULTS.steer.vault.tools).toEqual(["Edit", "Write"])
  })

  test("family levels", () => {
    for (const p of ON) {
      expect(ruleBase(p, "pii.email").level).toBe("low")
      expect(ruleBase(p, "pii.harness-identity").level).toBe("low")
      expect(ruleBase(p, "pii.card").level).toBe("mid")
      expect(ruleBase(p, "pii.phone").level).toBe("off")
      expect(ruleBase(p, "secret.openai.api-key").level).toBe("mid")
    }
  })

  test("path matrix samples", () => {
    expect(PATH_TABLE["path.harness-auth"]?.[0]).toEqual({ read: "note", write: "note" })
    expect(PATH_TABLE["path.harness-auth"]?.[1]).toEqual({ read: "deny", write: "deny" })
    expect(PATH_TABLE["path.env-file"]?.[0]).toEqual({ read: "redact", write: "none" })
    expect(PATH_TABLE["path.security-plugin"]?.[1]).toEqual({ read: "none", write: "deny" })
    expect(ruleBase("guard", "path.env-file").allow).toEqual([
      ".env.example",
      ".env.sample",
      ".env.template",
    ])
  })

  test("guard denies exfil, bypass, credential rules but notes reset-hard", () => {
    for (const id of ["cmd.net.exfil-upload", "cmd.git.no-verify", "cmd.secret.keychain"]) {
      expect(ruleBase("guard", id).decision).toBe("deny")
    }
    expect(ruleBase("guard", "cmd.git.reset-hard").decision).toBe("note")
    expect(ruleBase("guard", "cmd.git.unlisted-thing").decision).toBe("none")
    expect(ruleBase("strict", "cmd.git.unlisted-thing").decision).toBe("warn")
  })

  test("unlisted rule with rule-file defaults: steer never denies", () => {
    expect(ruleBase("steer", "cmd.new.thing", { status: "on" }).decision).toBe("note")
    // Review M6: guard denies an unlisted rule only when the rule file declares deny.
    expect(ruleBase("guard", "cmd.new.thing", { status: "on" }).decision).toBe("note")
    expect(ruleBase("guard", "cmd.new.thing", { status: "on", decision: "deny" }).decision).toBe(
      "deny",
    )
    expect(ruleBase("strict", "cmd.new.thing", { status: "on" }).decision).toBe("deny")
    expect(ruleBase("steer", "secret.new.key", { status: "on", level: "high" }).level).toBe("high")
  })

  test("caps and stores", () => {
    expect(NOTE_CAPS).toEqual({ perResult: 3, repeatTurns: 20 })
    expect(STORE_DEFAULTS).toEqual({
      cache_mb: 64,
      max_entries: 50000,
      max_derived: 20000,
      audit_max_mb: 16,
      audit_keep: 3,
    })
    expect(CAT_DEFAULTS.steer).toEqual({
      status: "on",
      escalate_after: 3,
      escalate_total: 5,
      escalate_window: 50,
    })
  })
})
