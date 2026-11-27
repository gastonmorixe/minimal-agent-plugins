/**
 * Intended new tools for the golden leaf diff of `ste-golden-shape.test.ts`.
 * The list is temporary: remove each entry when main has the new goldens, as
 * for `SCHEMA_ADDITIONS` and `golden-removals.ts`.
 *
 * @module tests/ste/golden-tool-additions
 */

/**
 * One intended new TOOL: a whole tool entry that the goldens gain. It is not
 * prose, and `SCHEMA_ADDITIONS` (`ste-golden-shape.test.ts`) allows only one key of one property, so
 * neither can allow it. Each entry names the tool and gives the reason.
 *
 * The same rules as `SCHEMA_ADDITIONS` apply. The list is temporary.
 * Remove an entry when main has the new goldens: the guard compares with the
 * merge base, so after the change lands the entry matches nothing. Do not add
 * a check that fails on a stale entry: on the push run to main the merge base
 * is HEAD, and that check would turn main red.
 */
export interface ToolAddition {
  /** Tool name (`tools[i].name`). */
  name: string
  /** Why the tool is new. */
  reason: string
  /** The date of the change (`YYYY-MM-DD`). */
  date: string
}

/**
 * Intended new tools. Keep it narrow: each entry needs a reason. Remove each
 * entry in a follow-up after its change is on main.
 *
 * Empty today. The `SessionTitle` tool (`ma-title-plugin`, plugins 564fbbe)
 * used it until it landed on main. The merge base now has its goldens. Add an
 * entry here for the next intended new tool. The unit tests of
 * {@link withoutAddedTools} are in `golden-tool-additions.test.ts`.
 */
export const TOOL_ADDITIONS: readonly ToolAddition[] = []

/**
 * Intended removed tools: a whole tool entry that a golden loses on purpose.
 * The same rules as {@link TOOL_ADDITIONS} apply. Each entry names the tool,
 * the golden that loses it, and the reason. The list is temporary: remove the
 * entries when main has the new goldens.
 */
export interface ToolRemoval {
  /** Tool name (`tools[i].name`). */
  name: string
  /** The golden file that loses the tool (`<name>.json`). */
  golden: string
  /** Why the tool is gone. */
  reason: string
  /** The date of the change (`YYYY-MM-DD`). */
  date: string
}

const LEAD_ONLY_REASON =
  "sub-agents: lead-only tools are hidden in a worker (available gate), to cut worker tool tokens"

/** Intended removed tools. Remove each entry after its change is on main. */
export const TOOL_REMOVALS: readonly ToolRemoval[] = [
  "SubAgentsSpawnAgent",
  "SubAgentsListAgents",
  "SubAgentsAgentStatus",
  "SubAgentsAgentResult",
  "SubAgentsAgentOutput",
  "SubAgentsStopAgent",
].map((name) => ({
  name,
  golden: "subagent-budget-warn.json",
  reason: LEAD_ONLY_REASON,
  date: "2026-11-27",
}))

/**
 * A copy of `before` with no removed listed tool: in each `tools` array of
 * `before`, remove each tool that a {@link TOOL_REMOVALS} entry lists for
 * `golden` and that the `tools` array at the same path of `after` does not
 * have. All other tools stay, in the same order.
 *
 * @param golden - Golden file name.
 * @param before - The merge-base golden.
 * @param after - The current golden.
 * @param removals - The allowlist (a test passes its own).
 * @returns `before`, or a copy of it with the removed listed tools gone.
 */
export function withoutRemovedTools(
  golden: string,
  before: unknown,
  after: unknown,
  removals: readonly ToolRemoval[] = TOOL_REMOVALS,
): unknown {
  const listed = new Set(removals.filter((r) => r.golden === golden).map((r) => r.name))
  if (listed.size === 0) return before
  const walk = (b: unknown, a: unknown, key: string | undefined): unknown => {
    if (Array.isArray(b)) {
      const aArr = Array.isArray(a) ? a : []
      let items = b
      if (key === "tools") {
        const kept = toolNames(a)
        items = b.filter((t) => {
          const name = (t as { name?: unknown } | null)?.name
          return !(typeof name === "string" && listed.has(name) && !kept.has(name))
        })
      }
      return items.map((x, i) => walk(x, aArr[i], undefined))
    }
    if (b === null || typeof b !== "object") return b
    const aObj = a !== null && typeof a === "object" ? (a as Record<string, unknown>) : {}
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(b)) out[k] = walk(v, aObj[k], k)
    return out
  }
  return walk(before, after, undefined)
}

/**
 * Both goldens with the listed tool changes removed: the merge-base golden
 * loses each listed removed tool ({@link withoutRemovedTools}), and the current
 * golden loses each listed added tool ({@link withoutAddedTools}).
 *
 * @param golden - Golden file name.
 * @param before - The merge-base golden.
 * @param current - The current golden.
 * @param additions - The added-tool allowlist (a test passes its own).
 * @returns `[before, after]`, ready for the leaf diff.
 */
export function toolChangePair(
  golden: string,
  before: unknown,
  current: unknown,
  additions: readonly ToolAddition[] = TOOL_ADDITIONS,
): readonly [unknown, unknown] {
  const after = withoutAddedTools(before, current, additions)
  return [withoutRemovedTools(golden, before, after), after]
}

/** The names of the tools of a `tools` array. */
function toolNames(tools: unknown): Set<unknown> {
  if (!Array.isArray(tools)) return new Set()
  return new Set(tools.map((t) => (t as { name?: unknown } | null)?.name))
}

/**
 * A copy of `after` with no added listed tool: in each `tools` array, remove
 * each tool whose name a {@link TOOL_ADDITIONS} entry lists and that the
 * `tools` array at the same path of `before` does not have. All other tools
 * stay, in the same order, so a change to another tool, a new order or a new
 * length is still a difference.
 *
 * @param before - The merge-base golden.
 * @param after - The current golden.
 * @param additions - The allowlist (a test passes its own).
 * @returns `after`, or a copy of it with the added listed tools removed.
 */
export function withoutAddedTools(
  before: unknown,
  after: unknown,
  additions: readonly ToolAddition[] = TOOL_ADDITIONS,
): unknown {
  if (additions.length === 0) return after
  const listed = new Set(additions.map((a) => a.name))
  const walk = (b: unknown, a: unknown, key: string | undefined): unknown => {
    if (Array.isArray(a)) {
      const bArr = Array.isArray(b) ? b : []
      let items = a
      if (key === "tools") {
        const had = toolNames(b)
        items = a.filter((t) => {
          const name = (t as { name?: unknown } | null)?.name
          return !(typeof name === "string" && listed.has(name) && !had.has(name))
        })
      }
      return items.map((x, i) => walk(bArr[i], x, undefined))
    }
    if (a === null || typeof a !== "object") return a
    const bObj = b !== null && typeof b === "object" ? (b as Record<string, unknown>) : {}
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(a)) out[k] = walk(bObj[k], v, k)
    return out
  }
  return walk(before, after, undefined)
}
