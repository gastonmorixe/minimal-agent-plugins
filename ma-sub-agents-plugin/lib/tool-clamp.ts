/**
 * Pure tool clamp (SPEC R6, R9). A worker never sees a tool the lead cannot
 * see. A role list MAY narrow the set, never widen it. The result-protocol
 * tools are always allowed, so a worker can always hand its work back.
 *
 * The output is a plain `--tools` allow-list. The clamp never asks for
 * `--no-tools`, because deny-all also blocks the report tool.
 *
 * @module sub-agents/lib/tool-clamp
 */

import type { StartupProfileTools } from "./host-types.ts"

/**
 * Tool names a worker needs to finish. The first is the canonical name the
 * host registers for this plugin's `ReportResult` tool (plugin "Sub-agents"
 * becomes the prefix "SubAgents"). The bare name is the migration alias. The
 * host tool filter matches canonical names, so the canonical name is required.
 */
export const RESULT_TOOLS: readonly string[] = ["SubAgentsReportResult", "ReportResult"]

/** Canonical names of this plugin's tools (manifest tools + host prefix). */
export const KNOWN_PLUGIN_TOOLS: readonly string[] = [
  "SubAgentsSpawnAgent",
  "SubAgentsListAgents",
  "SubAgentsAgentStatus",
  "SubAgentsAgentResult",
  "SubAgentsAgentOutput",
  "SubAgentsStopAgent",
  "SubAgentsMailbox",
  "SubAgentsReportResult",
]

/**
 * CamelCase prefixes the host puts on plugin tool names (core
 * `computeEffectiveName`: `deriveCamelName(manifest.name)` + tool name, e.g.
 * plugin "Sub-agents" gives `SubAgentsMailbox`). Only this plugin's prefix is
 * known here; other plugins' tools must be named canonically in a role list.
 */
const HOST_PREFIXES: readonly string[] = ["SubAgents"]

/**
 * Map a role tool name to its canonical name in `names`. An exact match wins.
 * Else `<prefix><name>` for a known {@link HOST_PREFIXES} prefix (a bare alias
 * such as `Mailbox` for `SubAgentsMailbox`). No other suffix match: `Grep`
 * never maps to `FastGrep`. Returns undefined when `names` does not hold it.
 */
export function canonicalIn(names: readonly string[], name: string): string | undefined {
  if (names.includes(name)) return name
  for (const prefix of HOST_PREFIXES) {
    const c = `${prefix}${name}`
    if (names.includes(c)) return c
  }
  return undefined
}

/**
 * A role name in canonical form when there is no lead list (lead `all`): a
 * bare name of this plugin's tools gets the host prefix, any other name is
 * kept as written.
 */
function canonicalName(name: string): string {
  return canonicalIn(KNOWN_PLUGIN_TOOLS, name) ?? name
}

/** Append `names` to `out` with no duplicates, in order. */
function addAll(out: string[], names: readonly string[]): void {
  for (const n of names) {
    const t = n.trim()
    if (t.length > 0 && !out.includes(t)) out.push(t)
  }
}

/**
 * Compute the worker `--tools` allow-list.
 *
 * 1. Lead `all` and no role list: undefined (emit nothing, child sees all).
 * 2. Lead `all` and a role list: role list (canonical names) plus
 *    {@link RESULT_TOOLS}.
 * 3. Lead `list L`: `L` (narrowed by the role list, canonical names) plus
 *    {@link RESULT_TOOLS}.
 * 4. Lead `none`: {@link RESULT_TOOLS} only.
 */
export function clampTools(
  lead: StartupProfileTools,
  role?: readonly string[],
): readonly string[] | undefined {
  const out: string[] = []
  if (lead.kind === "all") {
    if (!role) return undefined
    addAll(
      out,
      role.map((r) => canonicalName(r.trim())),
    )
  } else if (lead.kind === "list") {
    if (role) {
      const kept: string[] = []
      for (const r of role) {
        const c = canonicalIn(lead.names, r.trim())
        if (c) kept.push(c)
      }
      addAll(out, kept)
    } else {
      addAll(out, lead.names)
    }
  }
  addAll(out, RESULT_TOOLS)
  return out
}
