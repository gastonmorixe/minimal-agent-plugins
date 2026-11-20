import type { SidebandKind } from "./types.ts"

const AGENT_KINDS = [
  "binary-result",
  "budget",
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
  "wrap-up",
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
  // Turn tag of the max-tokens continue note (design 3.1). The kind name
  // `output-truncated` stays with the tool-result annotation.
  table.set("max-tokens-continue", "ma::agent::output-truncated")
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

/**
 * v1 wire names of declared attributes, by kind. The declared name is
 * `chars-removed`; v1 writes `chars_removed` (design 3.1 note). This map stays
 * until xml-ma-v2.
 */
const V1_ATTR_WIRE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "redacted-asset": { "chars-removed": "chars_removed" },
  "context-sanitizer": { "chars-removed": "chars_removed" },
}

/** The v1 wire name of a declared attribute of a kind. */
export function v1AttrWireName(kindName: string, attr: string): string {
  return V1_ATTR_WIRE[kindName]?.[attr] ?? attr
}

/**
 * The declared attribute name for a v1 wire name, when the declaration uses
 * the declared name. A declaration that still names the wire form keeps it.
 */
export function v1AttrDeclName(kind: SidebandKind | undefined, wire: string): string {
  if (kind === undefined) return wire
  const map = V1_ATTR_WIRE[kind.kind]
  if (map === undefined || Object.hasOwn(kind.attrs, wire)) return wire
  for (const [decl, w] of Object.entries(map)) {
    if (w === wire && Object.hasOwn(kind.attrs, decl)) return decl
  }
  return wire
}
