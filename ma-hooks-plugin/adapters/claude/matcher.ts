/**
 * Claude Code matcher rules and the handler-level `if` filter.
 *
 * Facts come from `research/hooks-claude-vs-codex/raw/claude/hooks-reference.md`
 * (cited below as `raw:<line>`). This file imports nothing from the engine
 * runtime, from native, or from another adapter.
 *
 * @module adapters/claude/matcher
 */

/** Characters that keep a matcher on the exact-match path (raw:286). */
const EXACT_CHARS = /^[A-Za-z0-9_\- ,|]*$/

/** A compiled Claude matcher. */
export interface ClaudeMatcher {
  /** Test one value (tool name, source, agent type, ...). */
  test(value: string | undefined): boolean
  /** Set when the regex path failed to compile. */
  error?: string
}

/**
 * Compile a Claude matcher (raw:283-289).
 *
 * `*`, empty or omitted matches all. Only letters, digits, `_`, `-`, space,
 * `,` and `|`: an exact string or a list split on `|` or `,`. Anything else:
 * an unanchored, case-sensitive JavaScript RegExp. A regex that does not
 * compile matches nothing (Unverified: the docs do not say what Claude does).
 */
export function compileClaudeMatcher(matcher: string | undefined): ClaudeMatcher {
  if (matcher === undefined || matcher === "" || matcher === "*") return { test: () => true }
  if (EXACT_CHARS.test(matcher)) {
    const names = new Set(
      matcher
        .split(/[|,]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    )
    return { test: (v) => v !== undefined && names.has(v) }
  }
  let re: RegExp
  try {
    re = new RegExp(matcher)
  } catch (e) {
    return { test: () => false, error: e instanceof Error ? e.message : String(e) }
  }
  // RegExp.prototype.test, unanchored (raw:289).
  return { test: (v) => v !== undefined && re.test(v) }
}

/** A parsed `if` permission rule: `Tool` or `Tool(pattern)` (raw:428, raw:433). */
export interface IfRule {
  tool: string
  pattern?: string
}

/** Parse one `if` rule. Returns undefined when the text is not a rule. */
export function parseIfRule(text: string): IfRule | undefined {
  const m = /^\s*([^()\s]+)\s*(?:\(([\s\S]*)\))?\s*$/.exec(text)
  if (!m?.[1]) return undefined
  return m[2] === undefined ? { tool: m[1] } : { tool: m[1], pattern: m[2] }
}

function escapeRe(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
}

/** Glob for a Bash pattern: `*` matches any run of characters, anchored. */
function bashGlob(pattern: string): RegExp {
  // Legacy `prefix:*` form. Unverified: not in the saved research files.
  if (pattern.endsWith(":*")) {
    const prefix = escapeRe(pattern.slice(0, -2))
    return new RegExp(`^${prefix}(\\s.*)?$`, "s")
  }
  return new RegExp(`^${pattern.split("*").map(escapeRe).join(".*")}$`, "s")
}

/** Strip leading `VAR=value` assignments (raw:439). */
function stripAssignments(cmd: string): string {
  let s = cmd.trim()
  for (;;) {
    const m = /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S)*\s+/.exec(s)
    if (!m) return s
    s = s.slice(m[0].length)
  }
}

/**
 * Split a Bash command into subcommands, best effort (raw:441-449).
 *
 * Splits at top-level `&&`, `||`, `;`, `|`, `&` and newlines, outside quotes.
 * The bodies of `$(...)` and backticks are added as subcommands too.
 * Returns undefined when the input cannot be split (unbalanced quotes).
 */
export function splitBashSubcommands(cmd: string): string[] | undefined {
  const out: string[] = []
  const subs: string[] = []
  let cur = ""
  let quote: "'" | '"' | null = null
  let i = 0
  const push = () => {
    const s = stripAssignments(cur)
    if (s) out.push(s)
    cur = ""
  }
  while (i < cmd.length) {
    const c = cmd[i] as string
    const next = cmd[i + 1]
    if (quote === "'") {
      if (c === "'") quote = null
      cur += c
      i++
      continue
    }
    if (c === "\\" && next !== undefined) {
      cur += c + next
      i += 2
      continue
    }
    if (c === "$" && next === "(") {
      let depth = 1
      let j = i + 2
      while (j < cmd.length && depth > 0) {
        if (cmd[j] === "(") depth++
        else if (cmd[j] === ")") depth--
        j++
      }
      if (depth !== 0) return undefined
      subs.push(cmd.slice(i + 2, j - 1))
      cur += cmd.slice(i, j)
      i = j
      continue
    }
    if (c === "`") {
      const j = cmd.indexOf("`", i + 1)
      if (j < 0) return undefined
      subs.push(cmd.slice(i + 1, j))
      cur += cmd.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (quote === '"') {
      if (c === '"') quote = null
      cur += c
      i++
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      cur += c
      i++
      continue
    }
    if (c === ";" || c === "\n" || c === "|" || c === "&") {
      push()
      i += (c === "|" || c === "&") && next === c ? 2 : 1
      continue
    }
    cur += c
    i++
  }
  if (quote) return undefined
  push()
  for (const s of subs) {
    const inner = splitBashSubcommands(s)
    if (!inner) return undefined
    out.push(...inner)
  }
  return out
}

/** True when a Bash `if` pattern names more than the command (raw:447). */
function specifiesMoreThanName(pattern: string): boolean {
  const words = pattern.trim().split(/\s+/)
  return words.length > 1 && !(words.length === 2 && words[1] === "*")
}

/** Match a Bash `if` pattern against a command (raw:437-449). */
export function bashIfMatches(pattern: string, command: string): boolean {
  if (specifiesMoreThanName(pattern) && /\$\(|`|\$[A-Za-z_{]/.test(command)) return true
  const parts = splitBashSubcommands(command)
  // "When Claude Code can't split the Bash input ... it runs your hook" (raw:449).
  if (!parts) return true
  const re = bashGlob(pattern.trim())
  return parts.some((p) => re.test(p))
}

/** Glob for a file pattern: `**` crosses `/`, `*` does not. */
function fileGlob(pattern: string): RegExp {
  let re = ""
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string
    if (c === "*" && pattern[i + 1] === "*") {
      const slash = pattern[i + 2] === "/"
      re += slash ? "(?:.*/)?" : ".*"
      i += slash ? 2 : 1
    } else if (c === "*") re += "[^/]*"
    else if (c === "?") re += "[^/]"
    else re += escapeRe(c)
  }
  return new RegExp(`^${re}$`, "s")
}

/**
 * Match a file-tool `if` pattern (raw:345, raw:435). Best effort and
 * Unverified beyond the two documented examples: a pattern with no `/`
 * tests the file name, `//abs` is absolute, anything else is relative to
 * the cwd.
 */
export function fileIfMatches(pattern: string, filePath: string, cwd: string): boolean {
  if (!pattern.includes("/")) {
    const base = filePath.slice(filePath.lastIndexOf("/") + 1)
    return fileGlob(pattern).test(base)
  }
  if (pattern.startsWith("//")) return fileGlob(pattern.slice(1)).test(filePath)
  const root = cwd.endsWith("/") ? cwd : `${cwd}/`
  if (!filePath.startsWith(root)) return false
  return fileGlob(pattern.replace(/^\.\//, "")).test(filePath.slice(root.length))
}

const FILE_TOOLS = new Set(["Edit", "Write", "Read", "MultiEdit", "NotebookEdit"])

/** Inputs of {@link ifRuleMatches}. */
export interface IfSubject {
  tool: string | undefined
  input: Record<string, unknown>
  cwd: string
}

/** Test an `if` rule against a tool call. */
export function ifRuleMatches(rule: IfRule, subject: IfSubject): boolean {
  if (subject.tool !== rule.tool) return false
  if (rule.pattern === undefined || rule.pattern === "" || rule.pattern === "*") return true
  if (rule.tool === "Bash") {
    const cmd = subject.input.command
    return typeof cmd === "string" ? bashIfMatches(rule.pattern, cmd) : true
  }
  if (FILE_TOOLS.has(rule.tool)) {
    const p = subject.input.file_path ?? subject.input.path ?? subject.input.notebook_path
    return typeof p === "string" ? fileIfMatches(rule.pattern, p, subject.cwd) : false
  }
  // Other tools (WebFetch domain rules, MCP, ...): Unverified, run the hook.
  return true
}
