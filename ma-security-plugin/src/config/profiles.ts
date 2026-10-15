// Profile defaults as data (K-autonomy-profiles wins on defaults, SPEC-v3 matrices).
// Rule ids are plain strings. The rule files live elsewhere (src/rules).

import type {
  CatSettings,
  CmdDefault,
  Decision,
  FailMode,
  Family,
  Features,
  Level,
  NoteCaps,
  OnProfile,
  PathDecision,
  ProfileName,
  RuleDefaults,
  Status,
} from "./types.ts"

export const PROFILES: readonly ProfileName[] = ["off", "steer", "guard", "strict"]
export const DEFAULT_PROFILE: ProfileName = "steer"

export interface ProfileMeta {
  /** Can the run halt for reasons other than CAT escalation. */
  readonly haltsBeyondCat: boolean
  /** Can a decision wait for the user (core item 7). */
  readonly asksUser: boolean
  readonly failMode: FailMode
}

export const PROFILE_META: Readonly<Record<ProfileName, ProfileMeta>> = {
  off: { haltsBeyondCat: false, asksUser: false, failMode: "open" },
  steer: { haltsBeyondCat: false, asksUser: false, failMode: "open" },
  guard: { haltsBeyondCat: false, asksUser: false, failMode: "open" },
  strict: { haltsBeyondCat: true, asksUser: true, failMode: "closed" },
}

/** Catastrophic set. `cmd.cat` is a fixed alias for exactly these ids. */
export const CAT_IDS: readonly string[] = [
  "cmd.agent.security-bypass",
  "cmd.chmod.recursive-wide",
  "cmd.disk.format",
  "cmd.disk.raw-write",
  "cmd.rm.recursive-root-or-home",
]

export const NOTE_CAPS: NoteCaps = { perResult: 3, repeatTurns: 20 }

export const STORE_DEFAULTS = {
  cache_mb: 64,
  max_entries: 50000,
  max_derived: 20000,
  audit_max_mb: 16,
  audit_keep: 3,
} as const

export const CAT_DEFAULTS: Readonly<Record<ProfileName, CatSettings>> = {
  off: { status: "off", escalate_after: 3, escalate_total: 5, escalate_window: 50 },
  steer: { status: "on", escalate_after: 3, escalate_total: 5, escalate_window: 50 },
  guard: { status: "on", escalate_after: 3, escalate_total: 5, escalate_window: 50 },
  strict: { status: "on", escalate_after: 3, escalate_total: 5, escalate_window: 50 },
}

/** Internal deadline per hook call (SPEC-v3 Hook wiring), used as `timeout_ms`. */
export const DEADLINE_MS = 1500
export const ENTROPY_DEFAULTS = { threshold: 4.5, min_len: 20 } as const
export const KNOWN_VALUE_MIN_LEN = 8
export const VAULT_TOOLS: readonly string[] = ["Edit", "Write"]

function features(p: ProfileName): Features {
  const on = p !== "off"
  const s = (v: boolean): Status => (v ? "on" : "off")
  const fail: FailMode = PROFILE_META[p].failMode
  return {
    redactor: {
      status: s(on),
      level: on ? "mid" : "off",
      scope: p === "guard" ? "history" : p === "strict" ? "disk" : "prompt",
      tag: "on",
      fail,
      cache_mb: STORE_DEFAULTS.cache_mb,
      timeout_ms: DEADLINE_MS,
    },
    guard: {
      status: s(on),
      fail,
      timeout_ms: DEADLINE_MS,
      scope: ["*"],
      unresolvedMarker: p === "off" ? "none" : p === "strict" ? "deny" : "note",
      selfProtection: p === "guard" || p === "strict",
      configError: p === "off" ? "none" : p === "strict" ? "halt" : "drop",
    },
    entropy: {
      status: p === "guard" || p === "strict" ? "warn" : "off",
      threshold: ENTROPY_DEFAULTS.threshold,
      min_len: ENTROPY_DEFAULTS.min_len,
      allow: [],
    },
    "known-value": {
      status: s(on),
      min_len: KNOWN_VALUE_MIN_LEN,
      max_derived: STORE_DEFAULTS.max_derived,
    },
    vault: {
      status: s(on),
      bash: "off",
      tools: VAULT_TOOLS,
      max_entries: STORE_DEFAULTS.max_entries,
    },
    audit: {
      status: s(on),
      max_mb: STORE_DEFAULTS.audit_max_mb,
      keep: STORE_DEFAULTS.audit_keep,
    },
  }
}

export const FEATURE_DEFAULTS: Readonly<Record<ProfileName, Features>> = {
  off: features("off"),
  steer: features("steer"),
  guard: features("guard"),
  strict: features("strict"),
}

/** Secret and PII levels (same in every on-profile). Family keys are fallbacks. */
export const REDACT_LEVELS: Readonly<Record<string, Level>> = {
  secret: "mid",
  pii: "mid",
  "secret.known-value.harness": "mid",
  "pii.email": "low",
  "pii.harness-identity": "low",
  "pii.card": "mid",
  "pii.phone": "off",
  "pii.ip": "off",
  "pii.uuid": "off",
}

type Triple<T> = readonly [steer: T, guard: T, strict: T]
const d3 = (a: Decision, b: Decision, c: Decision): Triple<Decision> => [a, b, c]

/** Command rule decisions per on-profile (K 2.3). `off` is `none` for all. */
export const CMD_TABLE: Readonly<Record<string, Triple<CmdDefault>>> = {
  "cmd.agent.security-bypass": d3("deny", "deny", "deny"),
  "cmd.chmod.recursive-wide": d3("deny", "deny", "deny"),
  "cmd.disk.format": d3("deny", "deny", "deny"),
  "cmd.disk.raw-write": d3("deny", "deny", "deny"),
  "cmd.rm.recursive-root-or-home": d3("deny", "deny", "deny"),
  "cmd.rm.recursive-outside-cwd": d3("note", "deny", "deny"),
  "cmd.rm.recursive-cwd-self": d3("note", "note", "deny"),
  "cmd.rm.git-metadata": d3("note", "note", "deny"),
  "cmd.rm.recursive": d3("none", "note", "warn"),
  "cmd.rm.recursive-dynamic-target": d3("none", "note", "warn"),
  "cmd.find.delete": d3("none", "note", "warn"),
  "cmd.xargs.rm": d3("note", "note", "deny"),
  "cmd.git.force-push": [
    { "default-branch": "autofix", other: "none" },
    { "default-branch": "autofix", other: "note" },
    { "default-branch": "deny", other: "warn" },
  ],
  "cmd.git.reset-hard": d3("note", "note", "deny"),
  "cmd.git.clean-force": d3("note", "note", "deny"),
  "cmd.git.no-verify": d3("note", "deny", "deny"),
  "cmd.git.alias-or-ssh-override": d3("note", "deny", "deny"),
  "cmd.git.push-delete": d3("none", "none", "warn"),
  "cmd.git.checkout-discard": d3("none", "none", "warn"),
  "cmd.git.restore-worktree": d3("none", "none", "warn"),
  "cmd.git.branch-force-delete": d3("none", "none", "warn"),
  "cmd.git.stash-drop": d3("none", "none", "warn"),
  "cmd.git.history-rewrite": d3("none", "none", "warn"),
  "cmd.net.pipe-to-shell": d3("note", "deny", "deny"),
  "cmd.net.exfil-upload": d3("note", "deny", "deny"),
  "cmd.secret.read": d3("none", "note", "deny"),
  "cmd.secret.env-dump": d3("none", "none", "warn"),
  "cmd.secret.keychain": d3("note", "deny", "deny"),
  "cmd.interpreter.inline-danger": d3("note", "note", "deny"),
  "cmd.shell.dynamic-exec": d3("none", "note", "warn"),
  "cmd.sudo": d3("none", "note", "warn"),
  "cmd.shred": d3("none", "note", "warn"),
  "cmd.parse.unparseable": [
    { "deny-keyword": "none", other: "none" },
    { "deny-keyword": "note", other: "note" },
    { "deny-keyword": "deny", other: "warn" },
  ],
}

/** Fallback for unlisted `cmd.git.*` ids (the warn set). */
export const CMD_GIT_FALLBACK: Triple<Decision> = d3("none", "none", "warn")

const pd = (read: Decision, write: Decision): PathDecision => ({ read, write })

/** Path rule decisions per on-profile (K 2.4, SPEC-v3 strict column). */
export const PATH_TABLE: Readonly<Record<string, Triple<PathDecision>>> = {
  "path.harness-auth": [pd("note", "note"), pd("deny", "deny"), pd("deny", "deny")],
  "path.ssh-private": [pd("note", "note"), pd("deny", "deny"), pd("deny", "deny")],
  "path.gnupg": [pd("note", "note"), pd("deny", "deny"), pd("deny", "deny")],
  "path.cloud-creds": [pd("note", "note"), pd("deny", "deny"), pd("deny", "deny")],
  "path.netrc": [pd("note", "note"), pd("deny", "deny"), pd("deny", "deny")],
  "path.private-key": [pd("none", "none"), pd("note", "note"), pd("deny", "warn")],
  "path.env-file": [pd("redact", "none"), pd("redact", "note"), pd("redact", "warn")],
  "path.agent-config": [pd("none", "note"), pd("none", "deny"), pd("none", "deny")],
  "path.security-plugin": [pd("none", "note"), pd("none", "deny"), pd("none", "deny")],
  "path.harness-blobs": [pd("none", "none"), pd("none", "note"), pd("warn", "deny")],
  "path.shell-rc": [pd("none", "none"), pd("none", "note"), pd("none", "warn")],
  "path.git-hooks": [pd("none", "none"), pd("none", "note"), pd("none", "warn")],
  "path.ssh-authorized": [pd("none", "none"), pd("none", "note"), pd("warn", "deny")],
}

export const PATH_ALLOW: Readonly<Record<string, readonly string[]>> = {
  "path.env-file": [".env.example", ".env.sample", ".env.template"],
}

/** Every id the tables know, sorted. Used for floor checks on broad targets. */
export const KNOWN_IDS: readonly string[] = [
  ...Object.keys(REDACT_LEVELS).filter((k) => k.includes(".")),
  ...Object.keys(CMD_TABLE),
  ...Object.keys(PATH_TABLE),
].sort()

export const DECISION_ORDER: readonly Decision[] = [
  "none",
  "note",
  "warn",
  "redact",
  "autofix",
  "ask",
  "deny",
]

/** Family of a rule id, from its first segment. */
export function familyOf(id: string): Family | "other" {
  const f = id.split(".")[0]
  return f === "secret" || f === "pii" || f === "cmd" || f === "path" ? f : "other"
}

function idx(p: OnProfile): 0 | 1 | 2 {
  return p === "steer" ? 0 : p === "guard" ? 1 : 2
}

/** Map a rule-file status to a decision for an unlisted guard rule. `steer`
 * never denies a non-CAT rule, so `on` caps at `note` there. `guard` denies only
 * CAT plus the listed deny set, so an unlisted rule that is on maps to `note`
 * unless the rule file declares `deny` (review M6). `strict` denies. */
function decisionFromStatus(p: OnProfile, s: Status, declared?: Decision): Decision {
  if (s === "off") return "none"
  if (s === "warn") return p === "strict" ? "warn" : "note"
  if (s === "ask") return p === "strict" ? "ask" : "note"
  if (p === "steer") return "note"
  if (p === "guard") return declared === "deny" ? "deny" : "note"
  return "deny"
}

export interface RuleBase {
  readonly family: Family | "other"
  readonly level: Level
  readonly decision: CmdDefault
  readonly path?: PathDecision
  readonly allow: readonly string[]
  readonly min_len?: number | undefined
  readonly cat: boolean
}

const NONE_PATH: PathDecision = pd("none", "none")

/** Profile default for one id. Order: exact table entry, then rule-file
 * defaults, then the family fallback. */
export function ruleBase(profile: ProfileName, id: string, defaults?: RuleDefaults): RuleBase {
  const family = familyOf(id)
  const cat = CAT_IDS.includes(id)
  const allow = PATH_ALLOW[id] ?? []
  const min_len = defaults?.min_len
  if (profile === "off") {
    return family === "path"
      ? { family, level: "off", decision: "none", path: NONE_PATH, allow, min_len, cat }
      : { family, level: "off", decision: "none", allow, min_len, cat }
  }
  const i = idx(profile)
  if (family === "cmd") {
    const row = CMD_TABLE[id]
    const decision: CmdDefault = row
      ? row[i]
      : id.startsWith("cmd.git.") && !defaults
        ? CMD_GIT_FALLBACK[i]
        : decisionFromStatus(profile, defaults?.status ?? "off", defaults?.decision)
    return { family, level: "off", decision, allow, min_len, cat }
  }
  if (family === "path") {
    const row = PATH_TABLE[id]
    const fromStatus = decisionFromStatus(profile, defaults?.status ?? "off", defaults?.decision)
    const path = row ? row[i] : pd(fromStatus, fromStatus)
    return {
      family,
      level: "off",
      decision: stricterDecision(path.read, path.write),
      path,
      allow,
      min_len,
      cat,
    }
  }
  if (family === "secret" || family === "pii") {
    const level = REDACT_LEVELS[id] ?? defaults?.level ?? REDACT_LEVELS[family] ?? "mid"
    const statusOff = defaults?.status === "off" && REDACT_LEVELS[id] === undefined
    const lvl: Level = statusOff ? "off" : level
    return { family, level: lvl, decision: lvl === "off" ? "none" : "redact", allow, min_len, cat }
  }
  return { family, level: "off", decision: "none", allow, min_len, cat }
}

/** The stricter of two decisions. */
export function stricterDecision(a: Decision, b: Decision): Decision {
  return DECISION_ORDER.indexOf(a) >= DECISION_ORDER.indexOf(b) ? a : b
}

/** Strongest decision in a single or variant decision. */
export function maxDecision(d: CmdDefault): Decision {
  if (typeof d === "string") return d
  let best: Decision = "none"
  for (const v of Object.values(d)) best = stricterDecision(best, v)
  return best
}

/** Status implied by a decision when no status override exists. */
export function statusOfDecision(d: Decision): Status {
  if (d === "none") return "off"
  if (d === "note" || d === "warn") return "warn"
  if (d === "ask") return "ask"
  return "on"
}
