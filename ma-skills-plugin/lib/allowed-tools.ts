/**
 * Parser for the experimental `allowed-tools` frontmatter field.
 *
 * Spec (https://agentskills.io/specification#allowed-tools-field):
 *   > A space-separated string of tools that are pre-approved to run.
 *   > Experimental. Support for this field may vary between agent
 *   > implementations.
 *
 * The spec doesn't pin the token grammar. We model after Claude Code's
 * convention, which the user is most likely to copy-paste:
 *
 *   Bash(git:*)        — `Bash`, restricted to `git:*` invocations
 *   Bash(jq:*)         — `Bash`, restricted to `jq:*`
 *   Read               — `Read`, unrestricted
 *   WebSearch          — `WebSearch`, unrestricted
 *
 * Tokens are split on whitespace. Each token is then parsed into:
 *
 *   { tool: string; constraint?: string }
 *
 * Constraints inside `(...)` are preserved verbatim — the spec doesn't
 * give them semantics, and enforcement is advisory in this plugin (see
 * PROMPT.md). Future work can interpret `git:*`-style patterns.
 *
 * @module lib/allowed-tools
 */

export interface AllowedToolEntry {
  /** Tool name (e.g. `Bash`, `Read`). Non-empty. */
  tool: string
  /** Optional constraint pattern inside `(...)` when present. */
  constraint?: string
  /** Raw token verbatim (for diagnostics / display). */
  raw: string
}

/**
 * Tokenize a raw `allowed-tools` string into structured entries.
 *
 * Lenient: malformed tokens (e.g. `Bash(unclosed`) are kept with the
 * raw form intact so a downstream surface can show them to the user;
 * `constraint` is omitted for those entries. Truly empty input yields
 * an empty array.
 */
export function parseAllowedTools(raw: string): AllowedToolEntry[] {
  if (!raw || raw.trim().length === 0) return []
  const tokens = raw.split(/\s+/).filter((t) => t.length > 0)
  const out: AllowedToolEntry[] = []
  for (const tok of tokens) {
    out.push(parseToken(tok))
  }
  return out
}

/** Parse one token. Exported for granular unit tests. */
export function parseToken(tok: string): AllowedToolEntry {
  const openIdx = tok.indexOf("(")
  if (openIdx === -1) {
    return { tool: tok, raw: tok }
  }
  // Must end with closing paren matching the (first) opener.
  if (!tok.endsWith(")")) {
    return { tool: tok, raw: tok } // malformed — keep raw, drop constraint
  }
  const tool = tok.slice(0, openIdx)
  const constraint = tok.slice(openIdx + 1, -1)
  if (tool.length === 0) return { tool: tok, raw: tok }
  return { tool, constraint, raw: tok }
}

/**
 * Render entries back to a stable display string (space-separated raw
 * tokens). Useful for round-trip in `Skill info` output.
 */
export function formatAllowedTools(entries: AllowedToolEntry[]): string {
  return entries.map((e) => e.raw).join(" ")
}
