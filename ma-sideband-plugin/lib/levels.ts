import type { SidebandKind } from "./types.ts"

const AGENT_KINDS = [
  "binary-result",
  "context-sanitizer",
  "diagnostics",
  "intercom-inbox",
  "memory-saved",
  "mode-active",
  "mode-change",
  "output-preview",
  "output-truncated",
  "policy",
  "raw-output",
  "redacted-asset",
  "session-resumed",
  "short-term-memory",
  "stream-interrupted",
  "subagents",
  "tasks",
  "turn-aborted",
]

const SYS_ROLES = ["behavior", "context", "emit", "mode", "tool"]
const EMIT_KINDS = ["diff", "interleave-thinking", "memory", "output"]

function buildTable(): Map<string, string> {
  const table = new Map<string, string>()
  for (const k of AGENT_KINDS) table.set(k, `ma::agent::${k}`)
  for (const k of SYS_ROLES) table.set(k, `ma::sys::${k}`)
  for (const k of EMIT_KINDS) table.set(k, `ma::emit::${k}`)
  table.set("compaction", "ma::context::compaction")
  table.set("intercom-peer", "ma::intercom::peer")
  table.set("plugins", "ma::plugins")
  table.set("tui-preview", "ma::tui-preview")
  return table
}

const V1_QNAMES = buildTable()

/**
 * Return the v1 qualified name for a kind. Private level table first, then the
 * first `ma::` legacy alias of the declaration, then `ma::agent::<kind>`.
 */
export function v1Qname(kind: SidebandKind): string {
  const known = V1_QNAMES.get(kind.kind)
  if (known !== undefined) return known
  const alias = kind.legacy?.find((l) => l.startsWith("ma::"))
  return alias ?? `ma::agent::${kind.kind}`
}
