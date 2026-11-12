/** Escape rule a v1 emit site applies to attribute values. */
export type V1EscapeMode = "raw" | "e3" | "e4"

const RAW_KINDS = [
  "mode-active",
  "mode-change",
  "raw-output",
  "diagnostics",
  "compaction",
  "policy",
]
const E4_KINDS = ["behavior", "context", "emit", "mode", "tool"]
const E3_KINDS = ["binary-result", "redacted-asset", "context-sanitizer"]

const MODES = new Map<string, V1EscapeMode>()
for (const k of RAW_KINDS) MODES.set(k, "raw")
for (const k of E3_KINDS) MODES.set(k, "e3")
for (const k of E4_KINDS) MODES.set(k, "e4")

/** Pick the v1 attribute escape mode for a kind name. Kinds in no list use e4 (not audited yet). */
export function escapeModeFor(kindName: string): V1EscapeMode {
  return MODES.get(kindName) ?? "e4"
}

/**
 * Escape an attribute value as the v1 site of the kind does.
 * raw: unchanged. e3: `&`, `"`, `<`. e4: `&`, `<`, `>`, `"`.
 */
export function escapeV1Attr(value: string, mode: V1EscapeMode): string {
  if (mode === "raw") return value
  const base = value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
  return mode === "e3" ? base : base.replace(/>/g, "&gt;")
}
