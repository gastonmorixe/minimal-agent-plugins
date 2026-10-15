// Policy resolver (SPEC-v3 "Config resolver, grammar, precedence").
// Sources low to high: built-in, profile defaults, lead floor, config.profile,
// config.rules, config.spec, env, plugin-opt. A higher source wins. Inside one
// source the more specific target wins (exact id, cmd.cat, longest glob, family,
// `*`). Same target and key: the later clause wins. Sync. Never throws.

import { createHash } from "node:crypto"

import {
  BUILTIN_KNOWN_IDS,
  buildClauses,
  classifyTarget,
  drop,
  parseRulesObject,
  parseSpec,
} from "./grammar.ts"
import {
  CAT_DEFAULTS,
  CAT_IDS,
  DECISION_ORDER,
  DEFAULT_PROFILE,
  FEATURE_DEFAULTS,
  KNOWN_IDS,
  maxDecision,
  NOTE_CAPS,
  PROFILES,
  ruleBase,
  statusOfDecision,
  stricterDecision,
} from "./profiles.ts"
import type {
  CatSettings,
  Clause,
  CmdDefault,
  Decision,
  FailMode,
  Features,
  Level,
  OverrideMap,
  ParseResult,
  PathDecision,
  ProfileName,
  ResolvedPolicy,
  ResolveInput,
  RuleDefaults,
  RuleSetting,
  SourcedDrop,
  SourceName,
  Status,
} from "./types.ts"

/** One override layer. `depth` 0 = own source, 1+ = imported from a lead. */
export interface Layer {
  readonly source: SourceName
  readonly depth: number
  /** Target, then key, to value items. `["default"]` = reset. */
  readonly targets: Record<string, Record<string, string[]>>
}

interface Hit {
  readonly value: readonly string[]
  readonly source: SourceName
}

const STATUS_ORDER: readonly Status[] = ["off", "warn", "ask", "on"]
const LEVEL_ORDER: readonly Level[] = ["off", "low", "mid", "high", "xhigh"]
const SCOPE_ORDER = ["prompt", "history", "disk"]

/** Steer and guard never ask (no-halt checklist). Outside strict a reported
 * `ask` status reads as `warn` (fix2 MINOR 3). Strict keeps `ask`. */
function normStatus(s: Status, profile: ProfileName): Status {
  return s === "ask" && profile !== "strict" ? "warn" : s
}

/** Copy of the layers with every `status=ask` item written as `warn` outside
 * strict, so the map, the export, and the hash never carry `ask` there. */
function normLayers(layers: readonly Layer[], profile: ProfileName): Layer[] {
  if (profile === "strict") return [...layers]
  return layers.map((l) => {
    const targets: Record<string, Record<string, string[]>> = {}
    for (const [t, keys] of Object.entries(l.targets)) {
      const slot: Record<string, string[]> = {}
      for (const [k, v] of Object.entries(keys)) {
        slot[k] = k === "status" ? v.map((x) => (x === "ask" ? "warn" : x)) : [...v]
      }
      targets[t] = slot
    }
    return { ...l, targets }
  })
}

function rank<T>(order: readonly T[], v: T): number {
  return order.indexOf(v)
}

/** Specificity of a target for an id. -1 = no match. */
function score(target: string, id: string): number {
  const info = classifyTarget(target)
  if (typeof info === "string") return -1
  const cat = CAT_IDS.includes(id)
  switch (info.kind) {
    case "id":
      return info.prefix === id ? 1_000_000 : -1
    case "cat":
      return cat ? 999_999 : -1
    case "glob":
      if (cat) return -1
      return id === info.prefix || id.startsWith(`${info.prefix}.`) ? 1000 + info.prefix.length : -1
    case "family":
      if (cat) return -1
      return id === info.prefix || id.startsWith(`${info.prefix}.`) ? 100 : -1
    case "all":
      return cat ? -1 : 1
    default:
      return -1
  }
}

/** Walk layers high to low. Reset at depth d limits the walk to deeper layers. */
function walk(
  layers: readonly Layer[],
  key: string,
  match: (target: string) => number,
): Hit | null {
  let minDepth = -1
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i]
    if (!layer || layer.depth <= minDepth) continue
    let best = -1
    let val: string[] | undefined
    for (const [target, keys] of Object.entries(layer.targets)) {
      const v = keys[key]
      if (!v) continue
      const s = match(target)
      if (s >= 0 && s >= best) {
        best = s
        val = v
      }
    }
    if (!val) continue
    if (val.length === 1 && val[0] === "default") {
      minDepth = layer.depth
      continue
    }
    return { value: val, source: layer.depth > 0 ? "lead" : layer.source }
  }
  return null
}

function exact(name: string): (t: string) => number {
  return (t) => (t === name ? 1 : -1)
}

function first(h: Hit | null): string | undefined {
  return h?.value[0]
}

function num(h: Hit | null, dflt: number): number {
  const v = first(h)
  const n = v === undefined ? Number.NaN : Number(v)
  return Number.isFinite(n) ? n : dflt
}

type Origin = Record<string, SourceName>

function resolveFeatures(profile: ProfileName, layers: readonly Layer[], origin: Origin): Features {
  const base = FEATURE_DEFAULTS[profile]
  const get = (feature: string, key: string): Hit | null => {
    const h = walk(layers, key, exact(feature))
    if (h) origin[`${feature}.${key}`] = h.source
    if (h && key === "status") {
      return { ...h, value: h.value.map((x) => normStatus(x as Status, profile)) }
    }
    return h
  }
  const r = base.redactor
  const g = base.guard
  const e = base.entropy
  const k = base["known-value"]
  const v = base.vault
  const a = base.audit
  return {
    redactor: {
      status: (first(get("redactor", "status")) as Status) ?? r.status,
      level: (first(get("redactor", "level")) as Level) ?? r.level,
      scope: (first(get("redactor", "scope")) as typeof r.scope) ?? r.scope,
      tag: (first(get("redactor", "tag")) as "on" | "off") ?? r.tag,
      fail: (first(get("redactor", "fail")) as FailMode) ?? r.fail,
      cache_mb: num(get("redactor", "cache_mb"), r.cache_mb),
      timeout_ms: num(get("redactor", "timeout_ms"), r.timeout_ms),
    },
    guard: {
      ...g,
      status: (first(get("guard", "status")) as Status) ?? g.status,
      fail: (first(get("guard", "fail")) as FailMode) ?? g.fail,
      timeout_ms: num(get("guard", "timeout_ms"), g.timeout_ms),
      scope: get("guard", "scope")?.value ?? g.scope,
    },
    entropy: {
      status: (first(get("entropy", "status")) as Status) ?? e.status,
      threshold: num(get("entropy", "threshold"), e.threshold),
      min_len: num(get("entropy", "min_len"), e.min_len),
      allow: get("entropy", "allow")?.value ?? e.allow,
    },
    "known-value": {
      status: (first(get("known-value", "status")) as Status) ?? k.status,
      min_len: num(get("known-value", "min_len"), k.min_len),
      max_derived: num(get("known-value", "max_derived"), k.max_derived),
    },
    vault: {
      status: (first(get("vault", "status")) as Status) ?? v.status,
      bash: (first(get("vault", "bash")) as "on" | "off") ?? v.bash,
      tools: get("vault", "tools")?.value ?? v.tools,
      max_entries: num(get("vault", "max_entries"), v.max_entries),
    },
    audit: {
      status: (first(get("audit", "status")) as Status) ?? a.status,
      max_mb: num(get("audit", "max_mb"), a.max_mb),
      keep: num(get("audit", "keep"), a.keep),
    },
  }
}

function resolveCat(profile: ProfileName, layers: readonly Layer[], origin: Origin): CatSettings {
  const base = CAT_DEFAULTS[profile]
  if (profile === "off") return base
  const get = (key: string): Hit | null => {
    const h = walk(layers, key, exact("cmd.cat"))
    if (h) origin[`cat.${key}`] = h.source
    return h
  }
  return {
    status: (first(get("status")) as Status) ?? base.status,
    escalate_after: num(get("escalate_after"), base.escalate_after),
    escalate_total: num(get("escalate_total"), base.escalate_total),
    escalate_window: num(get("escalate_window"), base.escalate_window),
  }
}

/** Map a status override onto a decision. Steer and guard never ask, so `ask`
 * maps to `note` there (review m7). `warn` maps to `note` outside strict. This
 * also drops a stronger default: `cmd.git.force-push:warn` in steer turns the
 * default-branch autofix into a note. That is intended (review m11): the user
 * asked for a warning only, and a warning never rewrites the command. */
function applyStatus(d: Decision, s: Status, profile: ProfileName): Decision {
  if (s === "off") return "none"
  if (d === "redact") return d
  if (s === "on") return d === "none" || d === "note" || d === "warn" ? "deny" : d
  if (s === "ask" && profile === "strict") return "ask"
  return profile === "strict" ? "warn" : "note"
}

function applyStatusAll(d: CmdDefault, s: Status, profile: ProfileName): CmdDefault {
  if (typeof d === "string") return applyStatus(d, s, profile)
  const out: Record<string, Decision> = {}
  for (const [k, v] of Object.entries(d)) out[k] = applyStatus(v, s, profile)
  return out
}

/** Pure rule lookup over (profile, layers, features). */
function lookupRule(
  profile: ProfileName,
  layers: readonly Layer[],
  features: Features,
  featureOrigin: Origin,
  id: string,
  defaults?: RuleDefaults,
): RuleSetting {
  const base = ruleBase(profile, id, defaults)
  const origin: Origin = {}
  const get = (key: string): Hit | null => {
    const h = walk(layers, key, (t) => score(t, id))
    if (h) origin[key] = h.source
    return h
  }
  const rawStatus = first(get("status")) as Status | undefined
  const statusOv = rawStatus === undefined ? undefined : normStatus(rawStatus, profile)
  const levelOv = first(get("level")) as Level | undefined
  const allow = get("allow")?.value ?? base.allow
  const scope = get("scope")?.value ?? ["*"]
  const minHit = get("min_len")
  const thrHit = get("threshold")
  const min_len = minHit ? num(minHit, 0) : base.min_len
  const threshold = thrHit ? num(thrHit, 0) : undefined
  const common = { id, family: base.family, allow, scope, min_len, threshold, cat: base.cat }

  // Profile `off` runs no CAT rule, even with an explicit clause.
  if (profile === "off" && base.cat) {
    return { ...common, status: "off", level: "off", decision: "none", origin }
  }
  if (base.family === "secret" || base.family === "pii") {
    // Feature gate: redactor status off turns every redact rule off.
    if (features.redactor.status === "off") {
      return { ...common, status: "off", level: "off", decision: "none", origin }
    }
    // `redactor:level` applies to rules that are on by default and have no own level.
    const redactorOverridden = featureOrigin["redactor.level"] !== undefined
    let level: Level =
      levelOv ?? (redactorOverridden && base.level !== "off" ? features.redactor.level : base.level)
    if (statusOv && statusOv !== "off" && level === "off" && !levelOv) {
      level = features.redactor.level === "off" ? "mid" : features.redactor.level
    }
    const status: Status = statusOv ?? (level === "off" ? "off" : "on")
    const decision: Decision =
      status === "off" || level === "off" ? "none" : status === "on" ? "redact" : "note"
    return { ...common, status, level, decision, origin }
  }
  // Feature gate: guard status off turns every cmd and path rule off, but not the
  // CAT set. Only `cmd.cat:off` or an exact CAT id clause turns CAT off (review M1).
  if (
    features.guard.status === "off" &&
    !base.cat &&
    (base.family === "cmd" || base.family === "path")
  ) {
    const none: RuleSetting = { ...common, status: "off", level: "off", decision: "none", origin }
    return base.path ? { ...none, path: { read: "none", write: "none" } } : none
  }
  let path: PathDecision | undefined = base.path
  let decision = base.decision
  if (statusOv) {
    if (path) {
      path = {
        read: applyStatus(path.read, statusOv, profile),
        write: applyStatus(path.write, statusOv, profile),
      }
      decision = stricterDecision(path.read, path.write)
    } else {
      decision = applyStatusAll(decision, statusOv, profile)
    }
  }
  const status: Status = statusOv ?? normStatus(statusOfDecision(maxDecision(decision)), profile)
  const out: RuleSetting = { ...common, status, level: "off", decision, origin }
  return path ? { ...out, path } : out
}

/** Effective policy core: what the hash and floor checks compare. */
interface Core {
  readonly profile: ProfileName
  readonly layers: readonly Layer[]
  readonly features: Features
  readonly cat: CatSettings
  readonly origin: Origin
  lookup(id: string, defaults?: RuleDefaults): RuleSetting
}

/** Profile default for one id with no overrides. The safe fallback when a
 * lookup fails (review m9): never `none` for CAT or a strict rule. */
function baseSetting(profile: ProfileName, id: unknown): RuleSetting {
  const safeId = typeof id === "string" ? id : String(id)
  const base = ruleBase(profile, safeId)
  const out: RuleSetting = {
    id: safeId,
    family: base.family,
    status: normStatus(statusOfDecision(maxDecision(base.decision)), profile),
    level: base.level,
    decision: base.decision,
    allow: base.allow,
    scope: ["*"],
    min_len: base.min_len,
    threshold: undefined,
    cat: base.cat,
    origin: {},
  }
  return base.path ? { ...out, path: base.path } : out
}

function makeCore(profile: ProfileName, layers: readonly Layer[]): Core {
  const origin: Origin = {}
  const features = resolveFeatures(profile, layers, origin)
  const cat = resolveCat(profile, layers, origin)
  const cache = new Map<string, RuleSetting>()
  return {
    profile,
    layers,
    features,
    cat,
    origin,
    lookup(id, defaults) {
      try {
        if (!defaults) {
          const hit = cache.get(id)
          if (hit) return hit
        }
        const r = deepFreeze(lookupRule(profile, layers, features, origin, id, defaults))
        if (!defaults && cache.size < 4096) cache.set(id, r)
        return r
      } catch {
        return deepFreeze(baseSetting(profile, id))
      }
    },
  }
}

// ---------- floor merge at lookup time (review M3) ----------

function stricterCmd(a: CmdDefault, b: CmdDefault): CmdDefault {
  if (typeof a === "string" && typeof b === "string") return stricterDecision(a, b)
  const fa = typeof a === "string" ? null : a
  const fb = typeof b === "string" ? null : b
  const out: Record<string, Decision> = {}
  for (const k of new Set([...Object.keys(fa ?? {}), ...Object.keys(fb ?? {})])) {
    const x = fa ? (fa[k] ?? "none") : (a as Decision)
    const y = fb ? (fb[k] ?? "none") : (b as Decision)
    out[k] = stricterDecision(x, y)
  }
  return out
}

function maxBy<T>(order: readonly T[], a: T, b: T): T {
  return rank(order, a) >= rank(order, b) ? a : b
}

/** The stricter of a child setting and the lead floor setting, key by key. */
function stricterSetting(c: RuleSetting, f: RuleSetting): RuleSetting {
  const minOpt = (x?: number, y?: number): number | undefined =>
    x === undefined ? y : y === undefined ? x : Math.min(x, y)
  const out: RuleSetting = {
    ...c,
    status: maxBy(STATUS_ORDER, c.status, f.status),
    level: maxBy(LEVEL_ORDER, c.level, f.level),
    decision: stricterCmd(c.decision, f.decision),
    allow: c.allow.filter((x) => f.allow.includes(x)),
    scope: coversTools(c.scope, f.scope) ? c.scope : [...new Set([...c.scope, ...f.scope])],
    min_len: minOpt(c.min_len, f.min_len),
    threshold: minOpt(c.threshold, f.threshold),
  }
  if (c.path && f.path) {
    return {
      ...out,
      path: {
        read: stricterDecision(c.path.read, f.path.read),
        write: stricterDecision(c.path.write, f.path.write),
      },
    }
  }
  return out
}

/** Lookup that never returns a setting looser than the lead floor. Covers ids
 * outside the tables (`cmd.newrule`, `path.newrule.*`) that the clause check
 * cannot see.
 *
 * Known gap (fix2 MINOR 2): when the floor wins here, no `dropped` entry is
 * recorded. The policy is deep frozen and hashed at resolve time, and a drop
 * that appears only when a caller asks for a given id (with given rule-file
 * defaults) would make `dropped` change over the session. The setting returned
 * is still the stricter one, so this is a reporting gap only, not a hole. */
function flooredLookup(core: Core, floor: Core): Core["lookup"] {
  return (id, defaults) => {
    const child = core.lookup(id, defaults)
    try {
      return deepFreeze(stricterSetting(child, floor.lookup(id, defaults)))
    } catch {
      return child
    }
  }
}

// ---------- tighten-only comparison ----------

function decisionLooser(a: CmdDefault, floor: CmdDefault): boolean {
  if (typeof a === "string" && typeof floor === "string") {
    return rank(DECISION_ORDER, a) < rank(DECISION_ORDER, floor)
  }
  const fa = typeof a === "string" ? null : a
  const ff = typeof floor === "string" ? null : floor
  const keys = new Set([...Object.keys(fa ?? {}), ...Object.keys(ff ?? {})])
  for (const k of keys) {
    const x = fa ? (fa[k] ?? "none") : (a as Decision)
    const y = ff ? (ff[k] ?? "none") : (floor as Decision)
    if (rank(DECISION_ORDER, x) < rank(DECISION_ORDER, y)) return true
  }
  return false
}

function subset(a: readonly string[], b: readonly string[]): boolean {
  return a.every((x) => b.includes(x))
}

function coversTools(a: readonly string[], floor: readonly string[]): boolean {
  return a.includes("*") || (!floor.includes("*") && subset(floor, a))
}

/** 0 turns a trigger off, so 0 is the loosest. Lower non-zero is tighter. */
function escalateLooser(a: number, floor: number): boolean {
  if (floor === 0) return false
  return a === 0 || a > floor
}

function ruleLooser(a: RuleSetting, f: RuleSetting): string | null {
  if (rank(STATUS_ORDER, a.status) < rank(STATUS_ORDER, f.status)) return "status"
  if (rank(LEVEL_ORDER, a.level) < rank(LEVEL_ORDER, f.level)) return "level"
  if (decisionLooser(a.decision, f.decision)) return "decision"
  if (a.path && f.path) {
    if (decisionLooser(a.path.read, f.path.read)) return "read"
    if (decisionLooser(a.path.write, f.path.write)) return "write"
  }
  if (!subset(a.allow, f.allow)) return "allow"
  if (!coversTools(a.scope, f.scope)) return "scope"
  if ((a.min_len ?? 0) > (f.min_len ?? 0)) return "min_len"
  if (f.threshold !== undefined && (a.threshold ?? 0) > f.threshold) return "threshold"
  return null
}

function featuresLooser(a: Features, f: Features, c: CatSettings, fc: CatSettings): string | null {
  for (const name of ["redactor", "guard", "entropy", "known-value", "vault", "audit"] as const) {
    if (rank(STATUS_ORDER, a[name].status) < rank(STATUS_ORDER, f[name].status)) {
      return `${name}.status`
    }
  }
  if (rank(LEVEL_ORDER, a.redactor.level) < rank(LEVEL_ORDER, f.redactor.level)) {
    return "redactor.level"
  }
  if (rank(SCOPE_ORDER, a.redactor.scope) < rank(SCOPE_ORDER, f.redactor.scope)) {
    return "redactor.scope"
  }
  if (a.redactor.tag === "off" && f.redactor.tag === "on") return "redactor.tag"
  if (a.redactor.timeout_ms < f.redactor.timeout_ms) return "redactor.timeout_ms"
  if (a.guard.timeout_ms < f.guard.timeout_ms) return "guard.timeout_ms"
  if (a.redactor.fail === "open" && f.redactor.fail === "closed") return "redactor.fail"
  if (a.guard.fail === "open" && f.guard.fail === "closed") return "guard.fail"
  if (!coversTools(a.guard.scope, f.guard.scope)) return "guard.scope"
  if (a.entropy.threshold > f.entropy.threshold) return "entropy.threshold"
  if (a.entropy.min_len > f.entropy.min_len) return "entropy.min_len"
  if (!subset(a.entropy.allow, f.entropy.allow)) return "entropy.allow"
  if (a["known-value"].min_len > f["known-value"].min_len) return "known-value.min_len"
  if (a["known-value"].max_derived < f["known-value"].max_derived) {
    return "known-value.max_derived"
  }
  if (a.vault.max_entries < f.vault.max_entries) return "vault.max_entries"
  if (a.audit.keep < f.audit.keep) return "audit.keep"
  if (a.audit.max_mb < f.audit.max_mb) return "audit.max_mb"
  if (a.vault.bash === "on" && f.vault.bash === "off") return "vault.bash"
  // Adding a tool is looser: more tools see real secrets.
  if (!subset(a.vault.tools, f.vault.tools)) return "vault.tools"
  if (rank(STATUS_ORDER, c.status) < rank(STATUS_ORDER, fc.status)) return "cat.status"
  if (escalateLooser(c.escalate_after, fc.escalate_after)) return "cat.escalate_after"
  if (escalateLooser(c.escalate_total, fc.escalate_total)) return "cat.escalate_total"
  if (fc.escalate_total !== 0 && c.escalate_window < fc.escalate_window) {
    return "cat.escalate_window"
  }
  return null
}

/** Ids a clause can reach: the target itself (as a pseudo id), known ids, and
 * ids named by floor layers. */
function reachedIds(c: Clause, floorLayers: readonly Layer[]): string[] {
  const ids = new Set<string>()
  if (c.kind === "id" || c.kind === "glob" || c.kind === "family") ids.add(c.prefix)
  if (c.kind === "all") for (const f of ["secret", "pii", "cmd", "path"]) ids.add(f)
  const pool = [...KNOWN_IDS, ...CAT_IDS]
  for (const l of floorLayers) {
    for (const t of Object.keys(l.targets)) {
      const info = classifyTarget(t)
      if (typeof info !== "string" && info.kind === "id") pool.push(info.prefix)
    }
  }
  for (const id of pool) if (score(c.target, id) >= 0) ids.add(id)
  return [...ids]
}

function clauseLoosens(
  profile: ProfileName,
  floorLayers: readonly Layer[],
  floor: Core,
  c: Clause,
  source: SourceName,
): string | null {
  const layer: Layer = { source, depth: 0, targets: { [c.target]: { [c.key]: [...c.value] } } }
  const trial = makeCore(profile, [...floorLayers, layer])
  const f = featuresLooser(trial.features, floor.features, trial.cat, floor.cat)
  if (f) return f
  if (c.kind === "feature" || c.kind === "profile") return null
  for (const id of reachedIds(c, floorLayers)) {
    const k = ruleLooser(trial.lookup(id), floor.lookup(id))
    if (k) return `${id} ${k}`
  }
  return null
}

// ---------- helpers ----------

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o)
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v)
  }
  return o
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`
  if (v && typeof v === "object") {
    const keys = Object.keys(v as Record<string, unknown>).sort()
    return `{${keys
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`
  }
  return JSON.stringify(v) ?? "null"
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex")
}

function profileRank(p: ProfileName): number {
  return PROFILES.indexOf(p)
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

interface LeadFloor {
  readonly profile: ProfileName
  readonly layers: Layer[]
}

/** Floor for a lead policy that is present but malformed (review M2). Never
 * fail open: the default profile, no layers, and the kill switch is ignored. */
const MALFORMED_FLOOR: LeadFloor = { profile: DEFAULT_PROFILE, layers: [] }

/** Parse `MINIMAL_AGENT_SECURITY_RESOLVED`. Every clause is validated again. */
function parseLead(
  raw: string,
  drops: SourcedDrop[],
  known: ReadonlySet<string> = BUILTIN_KNOWN_IDS,
): LeadFloor {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    drops.push({ source: "lead", ...drop("", null, "lead policy is not JSON") })
    return MALFORMED_FLOOR
  }
  if (!isObj(data) || data.v !== 1 || !PROFILES.includes(data.profile as ProfileName)) {
    drops.push({ source: "lead", ...drop("", null, "lead policy has a bad shape") })
    return MALFORMED_FLOOR
  }
  const layers: Layer[] = []
  const rawLayers = Array.isArray(data.layers) ? data.layers : []
  for (const l of rawLayers) {
    if (!isObj(l) || !isObj(l.targets)) continue
    const depth = typeof l.depth === "number" && l.depth >= 0 ? Math.floor(l.depth) + 1 : 1
    const targets: Record<string, Record<string, string[]>> = {}
    for (const [t, keys] of Object.entries(l.targets)) {
      if (!isObj(keys)) continue
      for (const [k, v] of Object.entries(keys)) {
        const items = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
        const out = buildClauses(t, k, items, false, known)
        if (!Array.isArray(out)) {
          drops.push({ source: "lead", ...out })
          continue
        }
        for (const c of out) addClause(targets, c)
      }
    }
    layers.push({ source: "lead", depth, targets })
  }
  return { profile: data.profile as ProfileName, layers }
}

function addClause(targets: Record<string, Record<string, string[]>>, c: Clause): void {
  const slot = targets[c.target] ?? {}
  // Re-insert so the latest clause is last in insertion order.
  delete slot[c.key]
  slot[c.key] = [...c.value]
  targets[c.target] = slot
}

// ---------- entry point ----------

interface SourceInput {
  readonly source: SourceName
  readonly clauses: readonly Clause[]
}

function disabledFlag(v: unknown): boolean {
  return typeof v === "string" && ["1", "true", "yes", "on"].includes(v.trim().toLowerCase())
}

/** Resolve the policy once at session start. Never throws. */
export function resolvePolicy(input: ResolveInput = {}): ResolvedPolicy {
  try {
    return resolveInner(input)
  } catch {
    return fallbackPolicy(input)
  }
}

/** Read a property without trusting the getter. */
function safeGet(o: unknown, key: string): unknown {
  try {
    return isObj(o) ? o[key] : undefined
  } catch {
    return undefined
  }
}

/** Fallback after an internal error (review m9). Keeps the lead floor and the
 * configured profile. Drops every clause. Never fails open. */
function fallbackPolicy(input: unknown): ResolvedPolicy {
  const drops: SourcedDrop[] = [{ source: "builtin", ...drop("", null, "internal resolve error") }]
  const origin: Origin = { profile: "builtin" }
  let profile: ProfileName = DEFAULT_PROFILE
  let lead: LeadFloor | null = null
  try {
    const raw = safeGet(safeGet(input, "env"), "MINIMAL_AGENT_SECURITY_RESOLVED")
    if (typeof raw === "string" && raw.trim() !== "") lead = parseLead(raw, drops, knownOf(input))
    const cp = safeGet(safeGet(input, "config"), "profile")
    if (typeof cp === "string" && PROFILES.includes(cp.trim() as ProfileName)) {
      profile = cp.trim() as ProfileName
      origin.profile = "config.profile"
    }
    if (lead && profileRank(profile) < profileRank(lead.profile)) {
      profile = lead.profile
      origin.profile = "lead"
    }
    const floor = lead ? makeCore(lead.profile, lead.layers) : null
    return finish(profile, lead ? [...lead.layers] : [], false, floor, drops, origin)
  } catch {
    return finish(lead?.profile ?? DEFAULT_PROFILE, [], false, null, drops, origin)
  }
}

/** The known id set: built-in ids plus any ids the caller passes (B4 rule
 * packs). A bad option falls back to the built-in set. */
function knownOf(input: unknown): ReadonlySet<string> {
  const extra = safeGet(input, "knownIds")
  if (!(extra instanceof Set) || extra.size === 0) return BUILTIN_KNOWN_IDS
  const out = new Set<string>(BUILTIN_KNOWN_IDS)
  for (const id of extra)
    if (typeof id === "string" && typeof classifyTarget(id) !== "string") out.add(id)
  return out
}

function resolveInner(input: ResolveInput): ResolvedPolicy {
  const drops: SourcedDrop[] = []
  const known = knownOf(input)
  const env = input.env ?? {}
  const cfg = isObj(input.config) ? input.config : {}
  if (input.config !== undefined && input.config !== null && !isObj(input.config)) {
    drops.push({ source: "config.rules", ...drop("", null, "config is not an object") })
  }

  const lead =
    typeof env.MINIMAL_AGENT_SECURITY_RESOLVED === "string" &&
    env.MINIMAL_AGENT_SECURITY_RESOLVED.trim() !== ""
      ? parseLead(env.MINIMAL_AGENT_SECURITY_RESOLVED, drops, known)
      : null
  // A present lead is a floor. A malformed one is MALFORMED_FLOOR (steer).

  let disabled = disabledFlag(env.MINIMAL_AGENT_SECURITY_DISABLED)
  if (disabled && lead && lead.profile !== "off") {
    drops.push({ source: "env.disabled", ...drop("", null, "disabled under lead floor") })
    disabled = false
  }

  const sources: SourceInput[] = []
  const add = (source: SourceName, parsed: ParseResult): void => {
    for (const d of parsed.dropped) drops.push({ source, ...d })
    sources.push({ source, clauses: parsed.clauses })
  }
  if (cfg.profile !== undefined) {
    const p = typeof cfg.profile === "string" ? cfg.profile.trim() : ""
    const out = buildClauses("profile", null, [p], false)
    if (!Array.isArray(out)) drops.push({ source: "config.profile", ...out })
    else sources.push({ source: "config.profile", clauses: out })
  }
  add("config.rules", parseRulesObject(cfg.rules, known))
  add("config.spec", parseSpec(cfg.spec, known))
  add("env", parseSpec(env.MINIMAL_AGENT_SECURITY_SPEC, known))
  add("plugin-opt", parseSpec(input.pluginOpt, known))

  const origin: Origin = {}
  if (disabled) {
    origin.profile = "env.disabled"
    return finish("off", [], true, null, drops, origin)
  }

  // Profile: highest source with a profile clause, last clause in that source.
  let profile: ProfileName = DEFAULT_PROFILE
  origin.profile = "builtin"
  let profileClause: { clause: Clause; source: SourceName } | null = null
  for (const s of sources) {
    for (const c of s.clauses)
      if (c.kind === "profile") profileClause = { clause: c, source: s.source }
  }
  if (profileClause) {
    profile = (profileClause.clause.value[0] as ProfileName) ?? DEFAULT_PROFILE
    origin.profile = profileClause.source
  }
  if (lead && profileRank(profile) < profileRank(lead.profile)) {
    if (profileClause) {
      drops.push({
        source: profileClause.source,
        ...drop("profile", "profile", "loosens lead profile"),
      })
    }
    profile = lead.profile
    origin.profile = "lead"
  }

  const floorLayers = lead ? lead.layers : []
  // The floor is what the lead set: its profile and its layers. A child that
  // raised its own profile may still relax a rule down to the lead level.
  const floor = lead ? makeCore(lead.profile, floorLayers) : null
  const layers: Layer[] = [...floorLayers]
  for (const s of sources) {
    const targets: Record<string, Record<string, string[]>> = {}
    for (const c of s.clauses) {
      if (c.kind === "profile") continue
      if (floor) {
        if (clauseLoosens(profile, floorLayers, floor, c, s.source)) {
          drops.push({ source: s.source, ...drop(c.target, c.key, "loosens lead floor", known) })
          continue
        }
      }
      addClause(targets, c)
    }
    layers.push({ source: s.source, depth: 0, targets })
  }
  return finish(profile, layers, false, floor, drops, origin)
}

function finish(
  profile: ProfileName,
  layers: Layer[],
  disabled: boolean,
  floor: Core | null,
  drops: SourcedDrop[],
  origin: Origin,
): ResolvedPolicy {
  const floored = floor !== null
  layers = normLayers(layers, profile)
  const core = makeCore(profile, layers)
  const lookup = floor ? flooredLookup(core, floor) : core.lookup
  const allOrigin: Origin = { ...core.origin, ...origin }
  const features = core.features
  const failMode: FailMode =
    features.guard.fail === "closed" || features.redactor.fail === "closed" ? "closed" : "open"
  const stores = {
    cache_mb: features.redactor.cache_mb,
    max_entries: features.vault.max_entries,
    max_derived: features["known-value"].max_derived,
    audit_max_mb: features.audit.max_mb,
    audit_keep: features.audit.keep,
  }
  const kept = layers.filter((l) => Object.keys(l.targets).length > 0)
  const map: OverrideMap = kept.map((l) => ({
    source: l.source,
    depth: l.depth,
    targets: l.targets,
  }))
  const exported = canonical({ v: 1, profile, layers: map })
  // The hash covers the layers with their source names. Numbers are already
  // canonical (grammar), so `007` and `7` hash the same. But the same clause
  // from a different source (config.spec vs env) gives a different hash, on
  // purpose: the origin is part of the policy record (review m8).
  const hash = sha256(
    canonical({ v: 1, profile, disabled, floored, layers: map, features, cat: core.cat }),
  )
  const policy: ResolvedPolicy = {
    profile,
    disabled,
    features,
    rules: { lookup, map },
    cat: core.cat,
    stores,
    failMode,
    notes: NOTE_CAPS,
    hash,
    origin: allOrigin,
    dropped: drops,
    floored,
    exported,
  }
  return deepFreeze(policy)
}

/** Status, level, and decision for one rule id via the specificity order.
 * `defaults` are the rule file defaults for ids the profile tables do not list. */
export function ruleSetting(
  policy: ResolvedPolicy,
  ruleId: string,
  defaults?: RuleDefaults,
): RuleSetting {
  return policy.rules.lookup(ruleId, defaults)
}
