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
import type { AnyRule, CmdRule, PathRule, RedactRule } from "./types.ts"

export type DisabledRule = { id: string; reason: string }

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
  sources?: RegistrySources
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
    disabled: [{ id: "*", reason }],
    errors: [reason],
    automaton,
    keywordRules: [],
    byId: new Map(),
    aliases: {},
    resolveId: (id) => ({ id, aliased: false }),
  }
}

/** Load the registry. Never throws. */
export function loadRegistry(opts: LoadOptions = {}): Registry {
  try {
    const src = opts.sources ?? {}
    const redactIn = [...(src.redact ?? REDACT_RULES)]
    const pathIn = [...(src.path ?? PATH_RULES)]
    const cmdIn = [...(src.cmd ?? CMD_RULES)]
    const aliases = src.aliases ?? ALIASES
    const disabled: DisabledRule[] = []
    const byId = new Map<string, AnyRule>()

    // m7: drop non-object and id-less rules before the sort, so one bad entry
    // never disables the whole registry.
    const wellFormed = <T extends AnyRule>(list: T[]): T[] =>
      list.filter((r, i) => {
        if (typeof r === "object" && r !== null && typeof r.id === "string" && r.id !== "")
          return true
        disabled.push({ id: `<malformed #${i}>`, reason: "rule is not an object with a string id" })
        return false
      })
    const redactOk = wellFormed(redactIn)
    const pathOk = wellFormed(pathIn)
    const cmdOk = wellFormed(cmdIn)

    // m8: a duplicate id disables every copy. Load order must not pick a winner.
    const count = new Map<string, number>()
    for (const r of [...redactOk, ...pathOk, ...cmdOk]) count.set(r.id, (count.get(r.id) ?? 0) + 1)
    for (const [id, n] of count)
      if (n > 1) disabled.push({ id, reason: `duplicate id (${n} rules)` })

    const admit = (rule: AnyRule): boolean => {
      if ((count.get(rule.id) ?? 0) > 1) return false
      const id = rule.id
      if (!opts.skipSelfTest) {
        const r = selfTest(rule, opts)
        if (!r.ok) {
          disabled.push({ id, reason: r.reason })
          return false
        }
      }
      return true
    }

    const byIdSort = <T extends { id: string }>(a: T, b: T): number =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0

    const compiledIn: CompiledRedactRule[] = []
    for (const rule of redactOk.sort(byIdSort)) {
      if (!admit(rule)) continue
      const c = compileRedactRule(rule)
      if (typeof c === "string") {
        disabled.push({ id: rule.id, reason: c })
        continue
      }
      compiledIn.push(c)
    }
    // M2: every enabled rule's markers through the full rule set. Offenders are disabled.
    // mn4: an internal error of the check itself disables nothing (that would fail open
    // on secrets). It keeps the compiled set and records the error.
    const errors: string[] = []
    let offenders: DisabledRule[] = []
    if (!opts.skipSelfTest) {
      try {
        offenders = (opts.markerSafetyImpl ?? markerSafety)(compiledIn)
      } catch (e) {
        errors.push(`marker safety internal: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    for (const o of offenders) if (o.id === "*") errors.push(o.reason)
    const real = offenders.filter((o) => o.id !== "*")
    const bad = new Set(real.map((o) => o.id))
    disabled.push(...real)
    const redact = compiledIn.filter((c) => !bad.has(c.rule.id))
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
