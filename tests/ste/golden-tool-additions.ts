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
 */
export const TOOL_ADDITIONS: readonly ToolAddition[] = [
  {
    name: "SessionTitle",
    reason: "ma-title-plugin: new tool that sets the title of the live session",
    date: "2026-11-23",
  },
]

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
