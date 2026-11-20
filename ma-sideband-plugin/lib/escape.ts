/**
 * Escape rule a v1 emit site applies to attribute values.
 * raw: unchanged. e3: `&`, `"`, `<`. e4: `&`, `<`, `>`, `"`. aq: `&`, `"`.
 */
export type V1EscapeMode = "raw" | "e3" | "e4" | "aq"

/**
 * Escape rule a v1 emit site applies to the body.
 * raw: unchanged. lt-gt: `<`, `>`. text: `&`, `<`, `>`.
 */
export type V1BodyMode = "raw" | "lt-gt" | "text"

/** One checked row: the escape rules of the v1 emitter of a kind. */
interface V1EscapeRow {
  /** Attribute escape. */
  attr: V1EscapeMode
  /** Body escape. Default raw. */
  body?: V1BodyMode
}

/**
 * Rows checked against the emitters of today (parity.test.ts pins each one).
 * Kinds in no row use e4 attributes and a raw body.
 */
const ROWS: Readonly<Record<string, V1EscapeRow>> = {
  // core templates and core-tools synthetic text: values written raw
  "mode-active": { attr: "raw" },
  "mode-change": { attr: "raw" },
  "raw-output": { attr: "raw" },
  "output-preview": { attr: "raw" },
  diagnostics: { attr: "raw" },
  compaction: { attr: "raw" },
  policy: { attr: "raw" },
  "wrap-up": { attr: "raw" },
  // turn-recovery static tags (int attrs only)
  "turn-aborted": { attr: "raw" },
  "session-resumed": { attr: "raw" },
  "stream-interrupted": { attr: "raw" },
  "max-tokens-continue": { attr: "raw" },
  "reflection-checkpoint": { attr: "raw" },
  // local escapeAttr copies (core, ma-fetch, ma-session-history)
  "binary-result": { attr: "e3" },
  "redacted-asset": { attr: "e3" },
  "context-sanitizer": { attr: "e3" },
  // system role tags (core escapeTagAttr)
  behavior: { attr: "e4" },
  context: { attr: "e4" },
  emit: { attr: "e4" },
  mode: { attr: "e4" },
  tool: { attr: "e4" },
  // plugin templates
  "memory-saved": { attr: "aq", body: "lt-gt" },
  "short-term-memory": { attr: "raw" },
  tasks: { attr: "e4" },
  subagents: { attr: "raw" },
  // the codec is the emitter already (core renders the annotation)
  budget: { attr: "e4" },
  "intercom-inbox": { attr: "raw" },
  "intercom-peer": { attr: "e4", body: "text" },
}

/** Pick the v1 attribute escape mode for a kind name. Kinds in no row use e4. */
export function escapeModeFor(kindName: string): V1EscapeMode {
  return ROWS[kindName]?.attr ?? "e4"
}

/** Pick the v1 body escape mode for a kind name. Kinds in no row use raw. */
export function bodyModeFor(kindName: string): V1BodyMode {
  return ROWS[kindName]?.body ?? "raw"
}

/** Escape an attribute value as the v1 site of the kind does. */
export function escapeV1Attr(value: string, mode: V1EscapeMode): string {
  if (mode === "raw") return value
  const aq = value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
  if (mode === "aq") return aq
  const base = aq.replace(/</g, "&lt;")
  return mode === "e3" ? base : base.replace(/>/g, "&gt;")
}

/** Escape a body as the v1 site of the kind does. */
export function escapeV1Body(body: string, mode: V1BodyMode): string {
  if (mode === "raw") return body
  const amp = mode === "text" ? body.replace(/&/g, "&amp;") : body
  return amp.replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
