// Rule registry: load all rules once, self-test, compile, build the keyword automaton.
// A failing rule is disabled with a recorded reason. Never throws.
import { type Automaton, buildAutomaton } from "../engine/prefilter.ts"

import { ALIASES, CMD_RULES, PATH_RULES, REDACT_RULES } from "./index.ts"
import {
  type CompiledRedactRule,
  compileRedactRule,
  markerSafety,
  type SelfTestHooks,
  selfTest,
} from "./selftest.ts"
import type { AnyRule, CmdRule, DisabledReason, PathRule, RedactRule } from "./types.ts"

/** Every value `DisabledRule.reason` can take. */
export const DISABLED_REASONS: readonly DisabledReason[] = [
  "duplicate-id",
  "marker-safety",
  "compile-error",
  "static-shape",
  "example-cap",
  "bench",
  "self-test",
]

/**
 * A disabled rule. `reason` is a fixed enum, never free text. `builtin` is true when
 * the rule came from the hand-listed index (REDACT_RULES, PATH_RULES, CMD_RULES).
 */
export type DisabledRule = { id: string; reason: DisabledReason; builtin: boolean }

export interface Registry {
  /** Enabled redact rules, sorted by id. */
  readonly redact: readonly CompiledRedactRule[]
  readonly path: readonly PathRule[]
  readonly cmd: readonly CmdRule[]
  readonly disabled: readonly DisabledRule[]
  /**
   * Load-time internal errors that did not disable rules (e.g. a marker safety crash).
   * Never holds a secret value. SecurityStatus shows these.
   */
  readonly errors: readonly string[]
  /** Keywords of every enabled "keyword" gate redact rule. */
  readonly automaton: Automaton
  /** Per automaton keyword index: indexes into `redact` of the rules that own it. */
  readonly keywordRules: readonly (readonly number[])[]
  /** Every enabled rule by id. */
  readonly byId: ReadonlyMap<string, AnyRule>
  readonly aliases: Readonly<Record<string, string>>
  /** Map an id through the alias table. `aliased` is true when an alias was used. */
  resolveId(id: string): { id: string; aliased: boolean }
}

export type RegistrySources = {
  redact?: readonly RedactRule[]
  path?: readonly PathRule[]
  cmd?: readonly CmdRule[]
  aliases?: Readonly<Record<string, string>>
}

export type LoadOptions = SelfTestHooks & {
  /**
   * Test seam: replace the base rule lists. A rule in them is a built-in only when it is
   * the same object as an entry of the hand-listed index. Any other rule is custom.
   */
  sources?: RegistrySources
  /**
   * B4-fix F: user custom rules. Always custom (benched at load), whatever fields the
   * rule object carries. A custom rule never disables or changes a built-in.
   */
  custom?: { redact?: readonly RedactRule[] }
  /** Skip self-tests (CI already ran them). Compile still runs. Default false. */
  skipSelfTest?: boolean
  /** Test seam: replace the marker safety check (to inject a failure). */
  markerSafetyImpl?: typeof markerSafety
}

function emptyRegistry(reason: string): Registry {
  const automaton = buildAutomaton([])
  return {
    redact: [],
    path: [],
    cmd: [],
    disabled: [{ id: "*", reason: "self-test", builtin: true }],
    errors: [reason],
    automaton,
    keywordRules: [],
    byId: new Map(),
    aliases: {},
    resolveId: (id) => ({ id, aliased: false }),
  }
}

/**
 * B4-fix F: the built-in set is decided by the registry source only: the exact rule
 * objects of the hand-listed index. Never by a field on the rule object.
 */
const BUILTIN_OBJECTS: ReadonlySet<object> = new Set<object>([
  ...REDACT_RULES,
  ...PATH_RULES,
  ...CMD_RULES,
])

/** Load the registry. Never throws. */
export function loadRegistry(opts: LoadOptions = {}): Registry {
  try {
    const src = opts.sources ?? {}
    const redactIn = [...(src.redact ?? REDACT_RULES)]
    const pathIn = [...(src.path ?? PATH_RULES)]
    const cmdIn = [...(src.cmd ?? CMD_RULES)]
    const customIn = [...(opts.custom?.redact ?? [])]
    const aliases = src.aliases ?? ALIASES
    const disabled: DisabledRule[] = []
    const byId = new Map<string, AnyRule>()
    // A custom entry is never a built-in, even when it is the same object.
    const customSet = new Set<object>()
    const isBuiltin = (r: AnyRule): boolean => BUILTIN_OBJECTS.has(r) && !customSet.has(r)

    // m7: drop non-object and id-less rules before the sort, so one bad entry
    // never disables the whole registry.
    const wellFormed = <T extends AnyRule>(list: T[], custom: boolean): T[] =>
      list.filter((r, i) => {
        if (typeof r === "object" && r !== null && typeof r.id === "string" && r.id !== "")
          return true
        disabled.push({
          id: `<malformed${custom ? " custom" : ""} #${i}>`,
          reason: "self-test",
          builtin: !custom && BUILTIN_OBJECTS.has(r as object),
        })
        return false
      })
    const redactOk = wellFormed(redactIn, false)
    const pathOk = wellFormed(pathIn, false)
    const cmdOk = wellFormed(cmdIn, false)
    const customOk = wellFormed(customIn, true)

    // m8: a duplicate id in the base set disables every copy. Load order must not pick
    // a winner.
    const count = new Map<string, number>()
    for (const r of [...redactOk, ...pathOk, ...cmdOk]) count.set(r.id, (count.get(r.id) ?? 0) + 1)
    const dupBuiltin = new Map<string, boolean>()
    for (const r of [...redactOk, ...pathOk, ...cmdOk])
      if ((count.get(r.id) ?? 0) > 1)
        dupBuiltin.set(r.id, (dupBuiltin.get(r.id) ?? false) || isBuiltin(r))
    for (const [id, builtin] of dupBuiltin) disabled.push({ id, reason: "duplicate-id", builtin })

    // F: a custom rule that reuses any id (base or another custom) is disabled. The base
    // rule with that id stays as it is.
    const customCount = new Map<string, number>()
    for (const r of customOk) customCount.set(r.id, (customCount.get(r.id) ?? 0) + 1)
    const customAdmitted: RedactRule[] = []
    for (const [id, n] of customCount) {
      if (n > 1 || count.has(id)) disabled.push({ id, reason: "duplicate-id", builtin: false })
    }
    for (const r of customOk) {
      if ((customCount.get(r.id) ?? 0) > 1 || count.has(r.id)) continue
      customSet.add(r)
      customAdmitted.push(r)
    }

    const admit = (rule: AnyRule): boolean => {
      if (!customSet.has(rule) && (count.get(rule.id) ?? 0) > 1) return false
      if (!opts.skipSelfTest) {
        // F: built-ins are never wall-clock benched at load (CI benches them).
        const builtin = isBuiltin(rule)
        const r = selfTest(rule, { ...opts, bench: !builtin })
        if (!r.ok) {
          disabled.push({ id: rule.id, reason: r.code, builtin })
          return false
        }
      }
      return true
    }

    const byIdSort = <T extends { id: string }>(a: T, b: T): number =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0

    const compileAll = (list: RedactRule[]): CompiledRedactRule[] => {
      const out: CompiledRedactRule[] = []
      for (const rule of list.sort(byIdSort)) {
        if (!admit(rule)) continue
        const c = compileRedactRule(rule)
        if (typeof c === "string") {
          disabled.push({ id: rule.id, reason: "compile-error", builtin: isBuiltin(rule) })
          continue
        }
        out.push(c)
      }
      return out
    }
    const baseCompiled = compileAll(redactOk)
    const customCompiled = compileAll(customAdmitted)

    // M2: every enabled rule's markers through the full rule set. Offenders are disabled.
    // mn4: an internal error of the check itself disables nothing (that would fail open
    // on secrets). It keeps the compiled set and records the error.
    // F: the base set is checked alone first. Then each custom rule is checked with the
    // base set. A new offender in that run (also a base rule that catches the custom
    // marker) disables the custom rule only.
    const errors: string[] = []
    const bad = new Set<string>()
    const safety = (set: CompiledRedactRule[]): { id: string; reason: string }[] => {
      if (opts.skipSelfTest) return []
      try {
        const off = (opts.markerSafetyImpl ?? markerSafety)(set)
        for (const o of off) if (o.id === "*") errors.push(o.reason)
        return off.filter((o) => o.id !== "*")
      } catch (e) {
        errors.push(`marker safety internal: ${e instanceof Error ? e.message : String(e)}`)
        return []
      }
    }
    const baseOff = safety(baseCompiled)
    for (const o of baseOff) {
      bad.add(o.id)
      const c = baseCompiled.find((x) => x.rule.id === o.id)
      disabled.push({
        id: o.id,
        reason: "marker-safety",
        builtin: c !== undefined && isBuiltin(c.rule),
      })
    }
    const baseKept = baseCompiled.filter((c) => !bad.has(c.rule.id))
    const customKept: CompiledRedactRule[] = []
    for (const c of customCompiled) {
      if (opts.skipSelfTest) {
        customKept.push(c)
        continue
      }
      const off = safety([...baseKept, ...customKept, c])
      if (off.length > 0) {
        disabled.push({ id: c.rule.id, reason: "marker-safety", builtin: false })
        continue
      }
      customKept.push(c)
    }
    const redact = [...baseKept, ...customKept].sort((a, b) => byIdSort(a.rule, b.rule))
    for (const c of redact) byId.set(c.rule.id, c.rule)

    const path: PathRule[] = []
    for (const rule of pathOk.sort(byIdSort)) {
      if (!admit(rule)) continue
      path.push(rule)
      byId.set(rule.id, rule)
    }
    const cmd: CmdRule[] = []
    for (const rule of cmdOk.sort(byIdSort)) {
      if (!admit(rule)) continue
      cmd.push(rule)
      byId.set(rule.id, rule)
    }

    const kwIndex = new Map<string, number[]>()
    redact.forEach((c, i) => {
      if (c.rule.gate !== "keyword" || c.re === null) return
      for (const k of c.rule.keywords) {
        const key = k.toLowerCase()
        const list = kwIndex.get(key)
        if (list) list.push(i)
        else kwIndex.set(key, [i])
      }
    })
    const automaton = buildAutomaton([...kwIndex.keys()])
    const keywordRules = automaton.keywords.map((k) => kwIndex.get(k) ?? [])

    return {
      redact,
      path,
      cmd,
      disabled,
      errors,
      automaton,
      keywordRules,
      byId,
      aliases,
      resolveId(id: string) {
        const target = aliases[id]
        return target !== undefined && !byId.has(id)
          ? { id: target, aliased: true }
          : { id, aliased: false }
      },
    }
  } catch (e) {
    return emptyRegistry(`registry load failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}
