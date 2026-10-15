// Config types for the security plugin (SPEC-v3 "Config resolver, grammar,
// precedence", K-autonomy-profiles). Data only.

export type Status = "off" | "warn" | "on" | "ask"
export type Level = "off" | "low" | "mid" | "high" | "xhigh"
export type ProfileName = "off" | "steer" | "guard" | "strict"
export type OnProfile = Exclude<ProfileName, "off">
export type Scope = "prompt" | "history" | "disk"
export type FailMode = "open" | "closed"
export type Family = "secret" | "pii" | "cmd" | "path"
export type Feature = "redactor" | "guard" | "entropy" | "known-value" | "vault" | "audit"

/** Guard decision. `none` means the rule does not run. Ordered loose to strict. */
export type Decision = "none" | "note" | "warn" | "redact" | "autofix" | "ask" | "deny"

/** One decision, or one decision per variant (`default-branch`, `other`, ...). */
export type CmdDefault = Decision | Readonly<Record<string, Decision>>

export interface PathDecision {
  readonly read: Decision
  readonly write: Decision
}

export type TargetKind = "all" | "profile" | "feature" | "family" | "glob" | "id" | "cat"

/** One parsed clause. A level shorthand yields two clauses (level, status=on),
 * except on `*`, where it yields only the level. */
export interface Clause {
  readonly target: string
  readonly kind: TargetKind
  /** Glob prefix without `.*`, family name, feature name, or the id. */
  readonly prefix: string
  readonly key: string
  readonly value: readonly string[]
  /** `key=default`: drop lower overrides, use the profile default. */
  readonly reset: boolean
}

/** Every reason a clause can be dropped for. Fixed plain strings: a reason never
 * holds user text (B7 fix3). `dropped` reaches the model after redaction, so a
 * token pasted into the spec by mistake must not come back through it. */
export const DROP_REASONS = [
  "spec is not a string",
  "rules is not an object",
  "rule body is not an object",
  "bad JSON value",
  "internal parse error",
  "missing colon",
  "empty target",
  "empty setting",
  "empty key",
  "shorthand takes one word",
  "glob only at the end",
  "cmd.cat is a fixed alias",
  "ids are lowercase",
  "bad id segment",
  "unknown target",
  "not a profile name",
  "shorthand not valid for target",
  "unknown key",
  "key not valid for target",
  "empty value",
  "empty item",
  "bad character in value",
  "takes one value",
  "needs an integer",
  "needs a number",
  "out of range",
  "bad status",
  "CAT status takes on or off",
  "bad level",
  "bad fail",
  "bad tag",
  "bad bash",
  "bad scope",
  "scope takes tool names",
  "tools takes tool names",
  "vault tool not allowed",
  "bad allow value",
  "config is not an object",
  "lead policy is not JSON",
  "lead policy has a bad shape",
  "loosens lead floor",
  "loosens lead profile",
  "disabled under lead floor",
  "internal resolve error",
] as const

export type DropReason = (typeof DROP_REASONS)[number]

/** Target placeholder when the clause target fails the grammar. */
export const INVALID_TARGET = "<invalid-target>"
/** Target placeholder when the target passes the grammar but is not a known
 * rule id, family, feature, or glob over a known prefix (B7 fix3b). */
export const UNKNOWN_TARGET = "<unknown-target>"
/** Key placeholder when the clause key is not a known key. */
export const UNKNOWN_KEY = "<unknown-key>"

/** A dropped clause. No raw clause text. `target` is a known target,
 * `<invalid-target>` or `<unknown-target>`. `key` is a known key or `<unknown-key>`. */
export interface DroppedClause {
  readonly target: string
  readonly key: string
  readonly reason: DropReason
}

export interface ParseResult {
  readonly clauses: readonly Clause[]
  readonly dropped: readonly DroppedClause[]
}

export type SourceName =
  | "builtin"
  | "profile"
  | "lead"
  | "env.disabled"
  | "config.profile"
  | "config.rules"
  | "config.spec"
  | "env"
  | "plugin-opt"

export interface SourcedDrop extends DroppedClause {
  readonly source: SourceName
}

export interface RedactorFeature {
  readonly status: Status
  readonly level: Level
  readonly scope: Scope
  readonly tag: "on" | "off"
  readonly fail: FailMode
  readonly cache_mb: number
  readonly timeout_ms: number
}
export interface GuardFeature {
  readonly status: Status
  readonly fail: FailMode
  readonly timeout_ms: number
  /** Tools the guard covers. `*` = all. */
  readonly scope: readonly string[]
  /** Unresolved marker: `note` = autofix order, then note. `deny` in strict. */
  readonly unresolvedMarker: Decision
  readonly selfProtection: boolean
  /** Config error handling: drop the clause, or halt all but inspection tools. */
  readonly configError: "none" | "drop" | "halt"
}
export interface EntropyFeature {
  readonly status: Status
  readonly threshold: number
  readonly min_len: number
  readonly allow: readonly string[]
}
export interface KnownValueFeature {
  readonly status: Status
  readonly min_len: number
  /** Valid only after core item 1 lands. Consumers enforce that gate. */
  readonly max_derived: number
}
export interface VaultFeature {
  readonly status: Status
  readonly bash: "on" | "off"
  readonly tools: readonly string[]
  readonly max_entries: number
}
export interface AuditFeature {
  readonly status: Status
  readonly max_mb: number
  readonly keep: number
}

export interface Features {
  readonly redactor: RedactorFeature
  readonly guard: GuardFeature
  readonly entropy: EntropyFeature
  readonly "known-value": KnownValueFeature
  readonly vault: VaultFeature
  readonly audit: AuditFeature
}

/** Hook-facing knobs only. */
export interface CatSettings {
  readonly status: Status
  readonly escalate_after: number
  readonly escalate_total: number
  readonly escalate_window: number
}

export interface StoreSettings {
  readonly cache_mb: number
  readonly max_entries: number
  readonly max_derived: number
  readonly audit_max_mb: number
  readonly audit_keep: number
}

export interface NoteCaps {
  readonly perResult: number
  readonly repeatTurns: number
}

/** Rule-file defaults a caller may pass for ids not in the profile tables. */
export interface RuleDefaults {
  readonly status: Status
  readonly level?: Level
  readonly min_len?: number
  /** Decision the rule file declares for `on`. In guard only `deny` keeps deny
   * (review M6). Other unlisted rules that are on map to `note`. */
  readonly decision?: Decision
}

/** Effective setting of one rule id. */
export interface RuleSetting {
  readonly id: string
  readonly family: Family | "other"
  readonly status: Status
  readonly level: Level
  /** Command and redact rules. Path rules carry `path` too (decision = stricter side). */
  readonly decision: CmdDefault
  readonly path?: PathDecision
  readonly allow: readonly string[]
  readonly scope: readonly string[]
  readonly min_len?: number | undefined
  readonly threshold?: number | undefined
  readonly cat: boolean
  /** Key to source for keys an override set. */
  readonly origin: Readonly<Record<string, SourceName>>
}

/** Override layers, low to high precedence. Per layer: target, then key, to the
 * last value (`["default"]` = reset). `depth` 0 = own source, 1+ = from a lead. */
export type OverrideMap = ReadonlyArray<{
  readonly source: SourceName
  readonly depth: number
  readonly targets: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>
}>

export interface RuleTable {
  lookup(id: string, defaults?: RuleDefaults): RuleSetting
  readonly map: OverrideMap
}

export interface ResolvedPolicy {
  readonly profile: ProfileName
  readonly disabled: boolean
  readonly features: Features
  readonly rules: RuleTable
  readonly cat: CatSettings
  readonly stores: StoreSettings
  readonly failMode: FailMode
  readonly notes: NoteCaps
  /** sha256 hex of the canonical policy JSON. Same semantics, same hash. */
  readonly hash: string
  /** `profile`, `<feature>.<key>`, `cat.<key>` to source. */
  readonly origin: Readonly<Record<string, SourceName>>
  readonly dropped: readonly SourcedDrop[]
  /** True when a lead floor (`MINIMAL_AGENT_SECURITY_RESOLVED`) applies. */
  readonly floored: boolean
  /** Value a lead exports as `MINIMAL_AGENT_SECURITY_RESOLVED`. */
  readonly exported: string
}

export interface SecurityConfig {
  readonly profile?: unknown
  readonly rules?: unknown
  readonly spec?: unknown
}

export interface SecurityEnv {
  readonly MINIMAL_AGENT_SECURITY_SPEC?: string
  readonly MINIMAL_AGENT_SECURITY_DISABLED?: string
  readonly MINIMAL_AGENT_SECURITY_RESOLVED?: string
}

export interface ResolveInput {
  readonly config?: unknown
  readonly env?: SecurityEnv
  readonly pluginOpt?: string
  /** Rule ids a clause may name. Default: the built-in profile tables and CAT
   * ids. The B4 rule index passes its rule-pack ids here. Any other id is
   * dropped as `unknown target` and never echoed or stored. */
  readonly knownIds?: ReadonlySet<string>
}
