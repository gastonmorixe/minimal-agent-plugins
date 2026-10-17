import { CAT_IDS, CMD_TABLE, PATH_TABLE, REDACT_LEVELS } from "../config/profiles.ts"
import { DROP_REASONS } from "../config/types.ts"
import { RULE_IDS } from "../rules/index.ts"

export const STATUS_RULE_IDS: readonly string[] = [
  ...new Set([
    ...RULE_IDS,
    ...CAT_IDS,
    ...Object.keys(CMD_TABLE),
    ...Object.keys(PATH_TABLE),
    ...Object.keys(REDACT_LEVELS).filter((id) => id.includes(".")),
  ]),
].sort()
const knownIds = new Set(STATUS_RULE_IDS)

export const STATUSES = ["off", "warn", "on", "ask"] as const
export const LEVELS = ["off", "low", "mid", "high", "xhigh"] as const
export const DECISIONS = ["none", "note", "warn", "redact", "autofix", "ask", "deny"] as const
export const SOURCES = [
  "builtin",
  "profile",
  "lead",
  "env.disabled",
  "config.profile",
  "config.rules",
  "config.spec",
  "env",
  "plugin-opt",
] as const
export const REASONS = [
  "unspecified",
  "self-test-failed",
  "compile-error",
  "static-shape",
  "example-cap",
  "marker-safety",
  "duplicate-id",
  "malformed-rule",
  "internal-error",
  "deadline",
  "tier1",
  "tier2",
  "unresolved-marker",
  "policy",
  "tag-collision",
  "bench",
  "audit-io-error",
  "oversized-archive-kept",
] as const
const tools = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "Task",
  "SecurityStatus",
  "SubAgentsSpawnAgent",
  "IntercomSend",
  "MemoryTool",
] as const
export const CONFIG_KEYS = [
  "status",
  "level",
  "scope",
  "tag",
  "fail",
  "cache_mb",
  "timeout_ms",
  "threshold",
  "min_len",
  "allow",
  "max_derived",
  "bash",
  "tools",
  "max_entries",
  "max_mb",
  "keep",
  "escalate_after",
  "escalate_total",
  "escalate_window",
] as const

/** Select a fixed value. Never return unknown input. */
export function pick<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  return typeof value === "string" && choices.includes(value as T) ? (value as T) : fallback
}
/** Clamp a count to a safe nonnegative integer. */
export function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
    : 0
}
export const safeCount = count
/** Admit a profile enum only. */
export function safeProfile(value: unknown): "off" | "steer" | "guard" | "strict" {
  return pick(value, ["off", "steer", "guard", "strict"], "steer")
}
/** Admit a fixed reason only. */
export function safeReason(value: unknown): string {
  return pick(value, REASONS, "unspecified")
}
/** Return a known rule id or a fixed unknown label. */
export function safeRuleId(value: unknown): string {
  return safeId(value) ?? "unknown-rule"
}

/** Clamp a numeric setting or duration without rounding it. */
export function duration(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(value, Number.MAX_SAFE_INTEGER)
    : 0
}
/** Admit only a rule in the static index or profile tables. */
export function safeId(value: unknown): string | undefined {
  return typeof value === "string" && knownIds.has(value) ? value : undefined
}
/** Admit UUID agent ids or fixed role labels only. */
export function safeAgent(value: unknown): string {
  if (value === undefined) return "session"
  if (value === "lead" || value === "worker" || value === "session") return value
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : "unknown"
}
/** Unknown tools use a fixed label, not an input name. */
export function safeTool(value: unknown): string {
  return pick(value, [...tools, "unknown"] as const, "unknown")
}

const targets = new Set<string>([
  "*",
  "profile",
  "redactor",
  "guard",
  "entropy",
  "known-value",
  "vault",
  "audit",
  "secret",
  "pii",
  "cmd",
  "path",
  "cmd.cat",
  "<invalid-target>",
  "<unknown-target>",
  ...STATUS_RULE_IDS,
])
for (const id of STATUS_RULE_IDS) {
  const parts = id.split(".")
  for (let i = 1; i < parts.length; i++) targets.add(`${parts.slice(0, i).join(".")}.*`)
}

/** Recheck every dropped clause field against static lists. */
export function safeDrop(drop: {
  target: unknown
  key: unknown
  source: unknown
  reason: unknown
}) {
  return {
    source: pick(drop.source, SOURCES, "builtin"),
    target:
      typeof drop.target === "string" && targets.has(drop.target)
        ? drop.target
        : "<unknown-target>",
    key: pick(drop.key, [...CONFIG_KEYS, "<unknown-key>"] as const, "<unknown-key>"),
    reason: pick(drop.reason, DROP_REASONS, "internal resolve error"),
  }
}
