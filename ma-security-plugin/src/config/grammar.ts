// Spec grammar (SPEC-v3 "Config resolver, grammar, precedence"):
//   spec = clause *( "," clause ), clause = target ":" setting,
//   setting = key "=" value | shorthand, value = item *( "|" item ).
// Pure and sync. Never throws: a bad clause is dropped with a reason.
//
// B7 fix3: a dropped clause never echoes user text. It carries a target only
// when the target passes the grammar, a key only when the key is known, and a
// reason from the fixed DROP_REASONS list. `dropped` goes to the model after
// redaction, so a token pasted into the spec must not come back through it.

import { isRandomLooking } from "../engine/random.ts"

import { CAT_IDS, KNOWN_IDS } from "./profiles.ts"
import {
  type Clause,
  type DroppedClause,
  type DropReason,
  INVALID_TARGET,
  type ParseResult,
  type TargetKind,
  UNKNOWN_KEY,
  UNKNOWN_TARGET,
} from "./types.ts"

/** Built-in rule ids a clause may name: the profile tables plus the CAT set.
 * B4 adds rule-pack ids through `ResolveInput.knownIds` (B7 fix3b). */
export const BUILTIN_KNOWN_IDS: ReadonlySet<string> = new Set([...KNOWN_IDS, ...CAT_IDS])

export const FEATURES = ["redactor", "guard", "entropy", "known-value", "vault", "audit"] as const
export const FAMILIES = ["secret", "pii", "cmd", "path"] as const
export const CAT_ALIAS = "cmd.cat"

export const STATUS_WORDS = ["on", "warn", "off", "ask"] as const
export const LEVEL_WORDS = ["off", "low", "mid", "high", "xhigh"] as const
export const PROFILE_WORDS = ["off", "steer", "guard", "strict"] as const

/** Every key the grammar knows (SPEC-v3 key list plus `escalate_window` from the cmd.cat table). */
export const KEYS = [
  "status",
  "level",
  "fail",
  "timeout_ms",
  "min_len",
  "threshold",
  "allow",
  "scope",
  "tag",
  "bash",
  "tools",
  "cache_mb",
  "max_entries",
  "max_derived",
  "max_mb",
  "keep",
  "escalate_after",
  "escalate_total",
  "escalate_window",
] as const

const FEATURE_KEYS: Readonly<Record<string, readonly string[]>> = {
  redactor: ["status", "level", "scope", "tag", "fail", "timeout_ms", "cache_mb"],
  guard: ["status", "fail", "timeout_ms", "scope"],
  entropy: ["status", "threshold", "min_len", "allow"],
  "known-value": ["status", "min_len", "max_derived"],
  vault: ["status", "bash", "tools", "max_entries"],
  audit: ["status", "max_mb", "keep"],
}
const CAT_KEYS = ["status", "escalate_after", "escalate_total", "escalate_window"]
const REDACT_RULE_KEYS = ["status", "level", "min_len", "threshold", "allow"]
const GUARD_RULE_KEYS = ["status", "allow", "scope"]
const ALL_KEYS = ["status", "level"]

const ID_SEGMENT = /^[a-z0-9-]+$/
const SPEC_ITEM = /^[A-Za-z0-9_./~*+-]+$/
const TOOL_ITEM = /^(\*|[A-Za-z][A-Za-z0-9_-]*)$/

/** Tool names a `scope` value may hold for guard and rule targets (B7 fix3b).
 * A fixed enum: any other value is dropped as `bad scope` and never stored. */
export const SCOPE_TOOLS: readonly string[] = [
  "*",
  "Bash",
  "Read",
  "Edit",
  "Write",
  "Grep",
  "Glob",
  "Fetch",
  "WebSearch",
  "ChromeCDP",
  "Computer",
  "MemoryTool",
  "SessionHistory",
  "SubAgentsSpawnAgent",
  "BackgroundRun",
]
const REDACTOR_SCOPES = ["prompt", "history", "disk"]

/** Allow value grammars (B7 fix3b). Env file names for `path.env-file`, path
 * globs for every other target. No `..`. */
const ENV_NAME = /^[A-Za-z0-9._-]{1,64}$/
const PATH_GLOB = /^[A-Za-z0-9._/*?-]{1,128}$/

/** True when a value looks random, so it may be a secret pasted by mistake.
 * Uses the one shared definition (D14, src/engine/random.ts). */
function looksRandom(v: string): boolean {
  return isRandomLooking(v)
}

/** True when an allow item fits the strict grammar for its target. */
export function allowItemOk(info: TargetInfo, item: string): boolean {
  const grammar = info.kind === "id" && info.prefix === "path.env-file" ? ENV_NAME : PATH_GLOB
  if (!grammar.test(item)) return false
  if (item.includes("..")) return false
  return !looksRandom(item)
}

/** Tools the vault may swap markers for (SPEC-v3 Vault). Bash only via `vault:bash`.
 * Never Fetch, WebSearch, ChromeCDP, IntercomSend, SubAgentsSpawnAgent, MemoryTool,
 * or any other tool off this list. */
export const VAULT_TOOL_ALLOW: readonly string[] = ["Edit", "Write"]
/** CAT status (the `cmd.cat` alias and every exact CAT id): blocking is on or
 * off. No warn, no ask (review m7, fix2 MAJOR 1). SPEC-v3: only an explicit off
 * clause turns CAT blocking off, so a warn or ask clause is dropped. */
const CAT_STATUS_WORDS = ["on", "off"]

/** Fixed `bad <key>` reasons for the one-of keys. */
const BAD_WORD: Readonly<Record<string, DropReason>> = {
  status: "bad status",
  level: "bad level",
  fail: "bad fail",
  tag: "bad tag",
  bash: "bad bash",
  scope: "bad scope",
}

type IntRange = readonly [number, number]
const INT_KEYS: Readonly<Record<string, IntRange>> = {
  // Review m10: a tiny deadline makes every hook time out (allow with note).
  timeout_ms: [100, 600000],
  min_len: [0, 100000],
  cache_mb: [0, 65536],
  max_entries: [0, 10000000],
  max_derived: [0, 10000000],
  max_mb: [1, 65536],
  keep: [0, 100],
  escalate_after: [0, 1000],
  escalate_total: [0, 1000],
  escalate_window: [1, 1000],
}

function includes(list: readonly string[], word: string): boolean {
  return list.indexOf(word) !== -1
}

export interface TargetInfo {
  readonly kind: TargetKind
  readonly prefix: string
}

/** True when a grammar-valid target names something known: a feature, a
 * family, `*`, `profile`, `cmd.cat`, a known id, or a glob whose prefix is a
 * family or a dotted prefix of a known id (B7 fix3b). */
export function isKnownTarget(info: TargetInfo, known: ReadonlySet<string>): boolean {
  switch (info.kind) {
    case "id":
      return known.has(info.prefix)
    case "glob": {
      if (includes(FAMILIES, info.prefix)) return true
      const head = `${info.prefix}.`
      for (const id of known) if (id === info.prefix || id.startsWith(head)) return true
      return false
    }
    default:
      return true
  }
}

/** Classify a target against the grammar and the known set. Returns a fixed
 * reason when the target is invalid or unknown. */
export function classifyKnown(target: string, known: ReadonlySet<string>): TargetInfo | DropReason {
  const info = classifyTarget(target)
  if (typeof info === "string") return info
  return isKnownTarget(info, known) ? info : "unknown target"
}

/** Classify a target by grammar only. Returns a fixed reason when the target is invalid. */
export function classifyTarget(target: string): TargetInfo | DropReason {
  if (target === "") return "empty target"
  if (target === "*") return { kind: "all", prefix: "*" }
  if (target === "profile") return { kind: "profile", prefix: "profile" }
  if (includes(FEATURES, target)) return { kind: "feature", prefix: target }
  if (target === CAT_ALIAS) return { kind: "cat", prefix: CAT_ALIAS }
  if (includes(FAMILIES, target)) return { kind: "family", prefix: target }
  let body = target
  let glob = false
  if (target.endsWith(".*")) {
    body = target.slice(0, -2)
    glob = true
  }
  if (body.includes("*")) return "glob only at the end"
  if (glob && body === CAT_ALIAS) return "cmd.cat is a fixed alias"
  if (body !== body.toLowerCase()) return "ids are lowercase"
  const segs = body.split(".")
  for (const s of segs) {
    if (!ID_SEGMENT.test(s)) return "bad id segment"
  }
  const fam = segs[0] ?? ""
  if (!includes(FAMILIES, fam)) return "unknown target"
  if (glob) return { kind: "glob", prefix: body }
  if (segs.length < 2) return "unknown target"
  return { kind: "id", prefix: body }
}

/** Keys valid for a target. */
export function keysFor(info: TargetInfo): readonly string[] {
  switch (info.kind) {
    case "profile":
      return []
    case "feature":
      return FEATURE_KEYS[info.prefix] ?? []
    case "cat":
      return CAT_KEYS
    case "all":
      return ALL_KEYS
    default: {
      const fam = info.prefix.split(".")[0] ?? ""
      return fam === "cmd" || fam === "path" ? GUARD_RULE_KEYS : REDACT_RULE_KEYS
    }
  }
}

/** Validate a value list for a key on a target. Returns a fixed reason or null. */
export function validateValue(
  info: TargetInfo,
  key: string,
  items: readonly string[],
  strictChars: boolean,
): DropReason | null {
  if (items.length === 0) return "empty value"
  for (const it of items) {
    if (it === "") return "empty item"
    if (strictChars && !SPEC_ITEM.test(it)) return "bad character in value"
  }
  const single = (): DropReason | null => (items.length === 1 ? null : "takes one value")
  const one = items[0] ?? ""
  const oneOf = (words: readonly string[]): DropReason | null =>
    single() ?? (includes(words, one) ? null : (BAD_WORD[key] ?? "unknown key"))
  const range = INT_KEYS[key]
  if (range) {
    const s = single()
    if (s) return s
    if (!/^\d+$/.test(one)) return "needs an integer"
    const n = Number(one)
    if (n < range[0] || n > range[1]) return "out of range"
    return null
  }
  switch (key) {
    case "status":
      if (info.kind === "cat" || (info.kind === "id" && CAT_IDS.includes(info.prefix))) {
        return single() ?? (includes(CAT_STATUS_WORDS, one) ? null : "CAT status takes on or off")
      }
      return oneOf(STATUS_WORDS)
    case "level":
      return oneOf(LEVEL_WORDS)
    case "fail":
      return oneOf(["open", "closed"])
    case "tag":
    case "bash":
      return oneOf(["on", "off"])
    case "threshold": {
      const s = single()
      if (s) return s
      if (!/^\d+(\.\d+)?([eE][+-]?\d+)?$/.test(one)) return "needs a number"
      const n = Number(one)
      return n > 0 && n <= 8 ? null : "out of range"
    }
    case "scope":
      if (info.kind === "feature" && info.prefix === "redactor") return oneOf(REDACTOR_SCOPES)
      if (!items.every((t) => TOOL_ITEM.test(t))) return "scope takes tool names"
      return items.every((t) => includes(SCOPE_TOOLS, t)) ? null : "bad scope"
    case "tools": {
      if (!items.every((t) => TOOL_ITEM.test(t))) return "tools takes tool names"
      return items.every((t) => includes(VAULT_TOOL_ALLOW, t)) ? null : "vault tool not allowed"
    }
    case "allow":
      return items.every((t) => allowItemOk(info, t)) ? null : "bad allow value"
    default:
      return "unknown key"
  }
}

/** The key a drop may name: a known key, `profile`, or `<unknown-key>`. */
export function safeKey(key: string | null): string {
  if (key === null) return UNKNOWN_KEY
  return key === "profile" || includes(KEYS, key) ? key : UNKNOWN_KEY
}

/** The target a drop may name: a known target, `<invalid-target>` (fails the
 * grammar) or `<unknown-target>` (fits the grammar but is not known). */
export function safeTarget(target: string, known: ReadonlySet<string> = BUILTIN_KNOWN_IDS): string {
  const info = classifyTarget(target)
  if (typeof info === "string") return INVALID_TARGET
  return isKnownTarget(info, known) ? target : UNKNOWN_TARGET
}

/** Build a drop with no user text. */
export function drop(
  target: string,
  key: string | null,
  reason: DropReason,
  known: ReadonlySet<string> = BUILTIN_KNOWN_IDS,
): DroppedClause {
  return { target: safeTarget(target, known), key: safeKey(key), reason }
}

const dropKnown = (
  t: string,
  k: string | null,
  r: DropReason,
  known: ReadonlySet<string>,
): DroppedClause => drop(t, k, r, known)

function mk(
  target: string,
  info: TargetInfo,
  key: string,
  value: readonly string[],
  reset: boolean,
): Clause {
  return { target, kind: info.kind, prefix: info.prefix, key, value, reset }
}

/** Key a shorthand word stands for, for the drop record only. */
function shorthandKey(info: TargetInfo | DropReason, word: string): string | null {
  if (typeof info !== "string" && info.kind === "profile") return "profile"
  if (includes(STATUS_WORDS, word)) return "status"
  if (includes(LEVEL_WORDS, word)) return "level"
  return null
}

/** Build clauses for one (target, key, value) triple. Shared by the spec string,
 * the JSON `rules` object, and the lead floor import. `key` null = shorthand.
 * A bad triple gives a drop with no user text. */
export function buildClauses(
  target: string,
  key: string | null,
  items: readonly string[],
  strictChars: boolean,
  known: ReadonlySet<string> = BUILTIN_KNOWN_IDS,
): Clause[] | DroppedClause {
  const info = classifyKnown(target, known)
  const drop = (t: string, k: string | null, r: DropReason): DroppedClause =>
    dropKnown(t, k, r, known)
  if (key === null) {
    const word = items.length === 1 ? (items[0] ?? "") : ""
    const dk = shorthandKey(info, word)
    if (typeof info === "string") return drop(target, dk, info)
    if (word === "") return drop(target, dk, "empty setting")
    if (info.kind === "profile") {
      return includes(PROFILE_WORDS, word)
        ? [mk(target, info, "profile", [word], false)]
        : drop(target, dk, "not a profile name")
    }
    const keys = keysFor(info)
    if (includes(STATUS_WORDS, word)) {
      if (!includes(keys, "status")) return drop(target, dk, "shorthand not valid for target")
      const bad = validateValue(info, "status", [word], false)
      return bad ? drop(target, dk, bad) : [mk(target, info, "status", [word], false)]
    }
    if (includes(LEVEL_WORDS, word) && includes(keys, "level")) {
      // Review M5: `*:<level>` sets only the level. It implies no status, so cmd
      // and path decisions do not change.
      if (info.kind === "all") return [mk(target, info, "level", [word], false)]
      return [mk(target, info, "level", [word], false), mk(target, info, "status", ["on"], false)]
    }
    return drop(target, dk, "shorthand not valid for target")
  }
  if (typeof info === "string") return drop(target, key, info)
  if (!includes(KEYS, key)) return drop(target, key, "unknown key")
  if (!includes(keysFor(info), key)) return drop(target, key, "key not valid for target")
  if (items.length === 1 && items[0] === "default") {
    return [mk(target, info, key, ["default"], true)]
  }
  const bad = validateValue(info, key, items, strictChars)
  if (bad) return drop(target, key, bad)
  return [mk(target, info, key, canonicalItems(key, items), false)]
}

/** Review m8, fix2 MINOR 4: parse to a number, then write the number back, so
 * `007` = `7` and `4.5` = `4.50` = `045e-1`. The hash does not change with the
 * spelling. */
function canonicalItems(key: string, items: readonly string[]): readonly string[] {
  if (INT_KEYS[key] === undefined && key !== "threshold") return items
  return items.map((it) => String(Number(it)))
}

function parseOne(raw: string, known: ReadonlySet<string>): Clause[] | DroppedClause {
  const colon = raw.indexOf(":")
  if (colon === -1) return drop("", null, "missing colon")
  const target = raw.slice(0, colon).trim()
  const setting = raw.slice(colon + 1).trim()
  if (setting === "") return drop(target, null, "empty setting", known)
  const eq = setting.indexOf("=")
  if (eq === -1) {
    if (setting.includes("|")) return drop(target, null, "shorthand takes one word", known)
    return buildClauses(target, null, [setting], true, known)
  }
  const key = setting.slice(0, eq).trim()
  if (key === "") return drop(target, null, "empty key", known)
  const items = setting
    .slice(eq + 1)
    .split("|")
    .map((s) => s.trim())
  return buildClauses(target, key, items, true, known)
}

function collect(out: Clause[] | DroppedClause, clauses: Clause[], dropped: DroppedClause[]): void {
  if (Array.isArray(out)) clauses.push(...out)
  else dropped.push(out)
}

/** Parse a spec string. Never throws. Non-string input gives one drop. */
export function parseSpec(
  spec: unknown,
  known: ReadonlySet<string> = BUILTIN_KNOWN_IDS,
): ParseResult {
  const clauses: Clause[] = []
  const dropped: DroppedClause[] = []
  try {
    if (spec === undefined || spec === null) return { clauses, dropped }
    if (typeof spec !== "string") {
      dropped.push(drop("", null, "spec is not a string"))
      return { clauses, dropped }
    }
    for (const part of spec.split(",")) {
      const raw = part.trim()
      if (raw === "") continue
      collect(parseOne(raw, known), clauses, dropped)
    }
  } catch {
    dropped.push(drop("", null, "internal parse error"))
  }
  return { clauses, dropped }
}

function jsonItems(v: unknown): string[] | null {
  if (typeof v === "string") return [v]
  if (typeof v === "number" && Number.isFinite(v)) return [String(v)]
  if (typeof v === "boolean") return [v ? "on" : "off"]
  if (Array.isArray(v)) {
    const out: string[] = []
    for (const x of v) {
      if (typeof x === "string") out.push(x)
      else if (typeof x === "number" && Number.isFinite(x)) out.push(String(x))
      else return null
    }
    return out
  }
  return null
}

/** Parse the JSON `rules` object: `{ "<target>": { "<key>": value } | "<shorthand>" }`.
 * Values may hold spaces or commas (that is why the JSON form exists). Never throws. */
export function parseRulesObject(
  rules: unknown,
  known: ReadonlySet<string> = BUILTIN_KNOWN_IDS,
): ParseResult {
  const clauses: Clause[] = []
  const dropped: DroppedClause[] = []
  try {
    if (rules === undefined || rules === null) return { clauses, dropped }
    if (typeof rules !== "object" || Array.isArray(rules)) {
      dropped.push(drop("", null, "rules is not an object"))
      return { clauses, dropped }
    }
    for (const [rawTarget, body] of Object.entries(rules as Record<string, unknown>)) {
      const target = rawTarget.trim()
      if (typeof body === "string") {
        collect(buildClauses(target, null, [body.trim()], false, known), clauses, dropped)
        continue
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        dropped.push(drop(target, null, "rule body is not an object", known))
        continue
      }
      for (const [rawKey, v] of Object.entries(body as Record<string, unknown>)) {
        const key = rawKey.trim()
        const items = jsonItems(v)
        if (!items) {
          dropped.push(drop(target, key, "bad JSON value", known))
          continue
        }
        collect(
          buildClauses(
            target,
            key,
            items.map((s) => s.trim()),
            false,
            known,
          ),
          clauses,
          dropped,
        )
      }
    }
  } catch {
    dropped.push(drop("", null, "internal parse error"))
  }
  return { clauses, dropped }
}
