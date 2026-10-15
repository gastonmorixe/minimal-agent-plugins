// Spec grammar (SPEC-v3 "Config resolver, grammar, precedence"):
//   spec = clause *( "," clause ), clause = target ":" setting,
//   setting = key "=" value | shorthand, value = item *( "|" item ).
// Pure and sync. Never throws: a bad clause is dropped with a reason.

import { CAT_IDS } from "./profiles.ts"
import type { Clause, DroppedClause, ParseResult, TargetKind } from "./types.ts"

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

/** Tools the vault may swap markers for (SPEC-v3 Vault). Bash only via `vault:bash`.
 * Never Fetch, WebSearch, ChromeCDP, IntercomSend, SubAgentsSpawnAgent, MemoryTool,
 * or any other tool off this list. */
export const VAULT_TOOL_ALLOW: readonly string[] = ["Edit", "Write"]
/** CAT status (the `cmd.cat` alias and every exact CAT id): blocking is on or
 * off. No warn, no ask (review m7, fix2 MAJOR 1). SPEC-v3: only an explicit off
 * clause turns CAT blocking off, so a warn or ask clause is dropped. */
const CAT_STATUS_WORDS = ["on", "off"]

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

interface TargetInfo {
  readonly kind: TargetKind
  readonly prefix: string
}

/** Classify a target. Returns a reason string when the target is invalid. */
export function classifyTarget(target: string): TargetInfo | string {
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
  if (glob && body === CAT_ALIAS) return "cmd.cat is a fixed alias, not a glob"
  if (body !== body.toLowerCase()) return "ids are lowercase"
  const segs = body.split(".")
  for (const s of segs) {
    if (!ID_SEGMENT.test(s)) return `bad id segment '${s}'`
  }
  const fam = segs[0] ?? ""
  if (!includes(FAMILIES, fam)) return `unknown target '${target}'`
  if (glob) return { kind: "glob", prefix: body }
  if (segs.length < 2) return `unknown target '${target}'`
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

/** Validate a value list for a key on a target. Returns a reason or null. */
export function validateValue(
  info: TargetInfo,
  key: string,
  items: readonly string[],
  strictChars: boolean,
): string | null {
  if (items.length === 0) return `empty value for ${key}`
  for (const it of items) {
    if (it === "") return `empty item in ${key}`
    if (strictChars && !SPEC_ITEM.test(it)) return `bad character in value '${it}'`
  }
  const single = (): string | null => (items.length === 1 ? null : `${key} takes one value`)
  const one = items[0] ?? ""
  const oneOf = (words: readonly string[]): string | null =>
    single() ?? (includes(words, one) ? null : `bad ${key} '${one}'`)
  const range = INT_KEYS[key]
  if (range) {
    const s = single()
    if (s) return s
    if (!/^\d+$/.test(one)) return `${key} needs an integer`
    const n = Number(one)
    if (n < range[0] || n > range[1]) return `${key} out of range ${range[0]}..${range[1]}`
    return null
  }
  switch (key) {
    case "status":
      if (info.kind === "cat" || (info.kind === "id" && CAT_IDS.includes(info.prefix))) {
        return (
          single() ??
          (includes(CAT_STATUS_WORDS, one) ? null : `${info.prefix} status takes on or off`)
        )
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
      if (!/^\d+(\.\d+)?([eE][+-]?\d+)?$/.test(one)) return "threshold needs a number"
      const n = Number(one)
      return n > 0 && n <= 8 ? null : "threshold out of range (0, 8]"
    }
    case "scope":
      if (info.kind === "feature" && info.prefix === "redactor") {
        return oneOf(["prompt", "history", "disk"])
      }
      return items.every((t) => TOOL_ITEM.test(t)) ? null : "scope takes tool names"
    case "tools": {
      if (!items.every((t) => TOOL_ITEM.test(t))) return "tools takes tool names"
      const bad = items.find((t) => !includes(VAULT_TOOL_ALLOW, t))
      return bad === undefined
        ? null
        : `vault never swaps for '${bad}' (allowed: ${VAULT_TOOL_ALLOW.join("|")}, Bash via vault:bash)`
    }
    case "allow":
      return null
    default:
      return `unknown key '${key}'`
  }
}

function mk(
  raw: string,
  target: string,
  info: TargetInfo,
  key: string,
  value: readonly string[],
  reset: boolean,
): Clause {
  return { raw, target, kind: info.kind, prefix: info.prefix, key, value, reset }
}

/** Build clauses for one (target, key, value) triple. Shared by the spec string,
 * the JSON `rules` object, and the lead floor import. `key` null = shorthand. */
export function buildClauses(
  raw: string,
  target: string,
  key: string | null,
  items: readonly string[],
  strictChars: boolean,
): Clause[] | string {
  const info = classifyTarget(target)
  if (typeof info === "string") return info
  if (key === null) {
    const word = items.length === 1 ? (items[0] ?? "") : ""
    if (word === "") return "empty setting"
    if (info.kind === "profile") {
      return includes(PROFILE_WORDS, word)
        ? [mk(raw, target, info, "profile", [word], false)]
        : `'${word}' is not a profile name`
    }
    const keys = keysFor(info)
    if (includes(STATUS_WORDS, word)) {
      if (!includes(keys, "status")) return `'${word}' not valid for ${target}`
      const bad = validateValue(info, "status", [word], false)
      return bad ?? [mk(raw, target, info, "status", [word], false)]
    }
    if (includes(LEVEL_WORDS, word) && includes(keys, "level")) {
      // Review M5: `*:<level>` sets only the level. It implies no status, so cmd
      // and path decisions do not change.
      if (info.kind === "all") return [mk(raw, target, info, "level", [word], false)]
      return [
        mk(raw, target, info, "level", [word], false),
        mk(raw, target, info, "status", ["on"], false),
      ]
    }
    return `'${word}' not valid for ${target}`
  }
  if (!includes(KEYS, key)) return `unknown key '${key}'`
  if (!includes(keysFor(info), key)) return `key '${key}' not valid for ${target}`
  if (items.length === 1 && items[0] === "default") {
    return [mk(raw, target, info, key, ["default"], true)]
  }
  const bad = validateValue(info, key, items, strictChars)
  if (bad) return bad
  return [mk(raw, target, info, key, canonicalItems(key, items), false)]
}

/** Review m8, fix2 MINOR 4: parse to a number, then write the number back, so
 * `007` = `7` and `4.5` = `4.50` = `045e-1`. The hash does not change with the
 * spelling. */
function canonicalItems(key: string, items: readonly string[]): readonly string[] {
  if (INT_KEYS[key] === undefined && key !== "threshold") return items
  return items.map((it) => String(Number(it)))
}

function parseOne(raw: string): Clause[] | string {
  const colon = raw.indexOf(":")
  if (colon === -1) return "missing ':'"
  const target = raw.slice(0, colon).trim()
  const setting = raw.slice(colon + 1).trim()
  if (setting === "") return "empty setting"
  const eq = setting.indexOf("=")
  if (eq === -1) {
    if (setting.includes("|")) return "shorthand takes one word"
    return buildClauses(raw, target, null, [setting], true)
  }
  const key = setting.slice(0, eq).trim()
  if (key === "") return "empty key"
  const items = setting
    .slice(eq + 1)
    .split("|")
    .map((s) => s.trim())
  return buildClauses(raw, target, key, items, true)
}

/** Parse a spec string. Never throws. Non-string input gives one drop. */
export function parseSpec(spec: unknown): ParseResult {
  const clauses: Clause[] = []
  const dropped: DroppedClause[] = []
  try {
    if (spec === undefined || spec === null) return { clauses, dropped }
    if (typeof spec !== "string") {
      dropped.push({ clause: String(spec), reason: "spec is not a string" })
      return { clauses, dropped }
    }
    for (const part of spec.split(",")) {
      const raw = part.trim()
      if (raw === "") continue
      const out = parseOne(raw)
      if (typeof out === "string") dropped.push({ clause: raw, reason: out })
      else clauses.push(...out)
    }
  } catch {
    dropped.push({ clause: "<spec>", reason: "internal parse error" })
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
export function parseRulesObject(rules: unknown): ParseResult {
  const clauses: Clause[] = []
  const dropped: DroppedClause[] = []
  try {
    if (rules === undefined || rules === null) return { clauses, dropped }
    if (typeof rules !== "object" || Array.isArray(rules)) {
      dropped.push({ clause: "rules", reason: "rules is not an object" })
      return { clauses, dropped }
    }
    for (const [rawTarget, body] of Object.entries(rules as Record<string, unknown>)) {
      const target = rawTarget.trim()
      if (typeof body === "string") {
        const raw = `${target}:${body}`
        const out = buildClauses(raw, target, null, [body.trim()], false)
        if (typeof out === "string") dropped.push({ clause: raw, reason: out })
        else clauses.push(...out)
        continue
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        dropped.push({ clause: target, reason: "rule body is not an object" })
        continue
      }
      for (const [rawKey, v] of Object.entries(body as Record<string, unknown>)) {
        const key = rawKey.trim()
        const items = jsonItems(v)
        const raw = `${target}:${key}=${items ? items.join("|") : "?"}`
        if (!items) {
          dropped.push({ clause: raw, reason: `bad JSON value for ${key}` })
          continue
        }
        const out = buildClauses(
          raw,
          target,
          key,
          items.map((s) => s.trim()),
          false,
        )
        if (typeof out === "string") dropped.push({ clause: raw, reason: out })
        else clauses.push(...out)
      }
    }
  } catch {
    dropped.push({ clause: "rules", reason: "internal parse error" })
  }
  return { clauses, dropped }
}
