/**
 * SKILL.md parser and validator.
 *
 * Implements the Agent Skills spec frontmatter rules:
 * https://agentskills.io/specification#frontmatter
 *
 * The frontmatter is a small, constrained subset of YAML — strings, a
 * nested string→string map under `metadata`, and the `allowed-tools`
 * space-separated string. We hand-roll a parser instead of pulling in a
 * full YAML lib to keep this plugin dependency-light.
 *
 * Supported frontmatter shapes:
 *
 *   ---
 *   name: my-skill
 *   description: One-line description ending here.
 *   description: |
 *     Multi-line literal block-scalar
 *     description (newlines preserved).
 *   description: |-
 *     As above, with strip chomping
 *     (`-`/`+` chomping indicators honoured).
 *   description: >
 *     Multi-line folded block-scalar
 *     (joined with spaces).
 *   description: >-
 *     As above, with strip chomping.
 *   description:
 *     Implicit folded plain scalar across
 *     multiple indented lines (joined with
 *     spaces, like `>`). Widely used by
 *     third-party skills (e.g. Vercel).
 *   license: Apache-2.0
 *   compatibility: Requires Python 3.14+
 *   metadata:
 *     author: example-org
 *     version: "1.0"
 *   allowed-tools: Bash(git:*) Read
 *   ---
 *
 * NOT supported (rejected with a clear error): flow sequences/mappings
 * (`[a, b]`, `{k: v}`), anchors/aliases (`&x`, `*x`), document
 * separators inside frontmatter, complex nested structures.
 *
 * @module lib/skill-md
 */

import type { SkillFrontmatter } from "./types.ts"

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ParseResult {
  /** Successfully validated frontmatter. */
  front: SkillFrontmatter
  /** Markdown body (everything after the closing `---`), preserved verbatim. */
  body: string
}

export interface ParseError {
  /** Human-readable explanation; safe to surface to the user. */
  message: string
  /** Line number in the SKILL.md (1-indexed) when known. */
  line?: number
}

export type ParseOutcome = { ok: true; value: ParseResult } | { ok: false; errors: ParseError[] }

/**
 * Options that vary by call site (discovery validates name===dir,
 * the `Skill read` action does not always need that, etc.).
 */
export interface ParseOptions {
  /**
   * If set, validate that `front.name` equals this string. The spec
   * mandates that `name` must match the parent directory name; the
   * caller passes that here.
   */
  expectedDirName?: string
  /**
   * If true, permit `name` to contain reserved substrings `anthropic`
   * and `claude`. Anthropic's API enforces this rule; we expose an
   * escape hatch for users who want their own skill called
   * `claude-helper` etc. Default false.
   */
  allowReservedNames?: boolean
}

const RESERVED_SUBSTRINGS = ["anthropic", "claude"]

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * Parse a SKILL.md file (frontmatter + body) and validate per spec.
 *
 * Pure: takes the file text plus options, returns a structured outcome.
 * Multiple errors are collected and returned together so the caller can
 * present a full diagnostic at once instead of fix-one-at-a-time.
 */
export function parseSkillMd(text: string, opts: ParseOptions = {}): ParseOutcome {
  const errors: ParseError[] = []

  const split = splitFrontmatter(text)
  if (!split.ok) {
    return { ok: false, errors: [{ message: split.error }] }
  }

  const fm = parseFrontmatterYaml(split.frontmatter)
  if (!fm.ok) {
    return { ok: false, errors: fm.errors }
  }

  const front = validateFrontmatter(fm.value, opts, errors)
  if (errors.length > 0) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    value: { front: front as SkillFrontmatter, body: split.body },
  }
}

// ---------------------------------------------------------------------------
// Step 1: frontmatter / body split
// ---------------------------------------------------------------------------

interface SplitOk {
  ok: true
  frontmatter: string
  body: string
}

interface SplitErr {
  ok: false
  error: string
}

/**
 * Find the `---` delimiters and split frontmatter from body.
 *
 * The opening `---` must be the very first non-empty line (we tolerate a
 * leading UTF-8 BOM but not blank lines before it — Anthropic's reference
 * tooling is strict here). The closing `---` is the next standalone
 * `---` line.
 */
export function splitFrontmatter(text: string): SplitOk | SplitErr {
  let src = text
  // Strip UTF-8 BOM.
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1)

  // Normalise CRLF → LF for delimiter detection. We keep the body's
  // original line endings preserved via a separate slice.
  const lines = src.split("\n")

  if (lines.length === 0 || lines[0].trimEnd() !== "---") {
    return {
      ok: false,
      error: "SKILL.md must start with a frontmatter delimiter `---` on line 1",
    }
  }

  // Find closing delimiter.
  let closeIdx = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trimEnd() === "---") {
      closeIdx = i
      break
    }
  }
  if (closeIdx === -1) {
    return {
      ok: false,
      error: "SKILL.md frontmatter is missing the closing `---` delimiter",
    }
  }

  const frontmatter = lines.slice(1, closeIdx).join("\n")
  // Body = everything after the closing `---` line. Preserve the original
  // separator (always `\n` here since we already split on `\n`).
  const body = lines.slice(closeIdx + 1).join("\n")
  return { ok: true, frontmatter, body }
}

// ---------------------------------------------------------------------------
// Step 2: YAML subset parser
// ---------------------------------------------------------------------------

/**
 * Raw key/value pairs as the YAML subset produces them. Values can be
 * strings or, for `metadata`, nested string→string maps.
 */
export type RawYamlValue = string | Record<string, string>

interface YamlOk {
  ok: true
  value: Record<string, RawYamlValue>
}

interface YamlErr {
  ok: false
  errors: ParseError[]
}

/**
 * Parse the constrained YAML subset our frontmatter uses.
 *
 * Grammar (informal):
 *   document      := entry*
 *   entry         := key ':' (inline_value | block_scalar | nested_map | folded_plain)
 *   key           := [A-Za-z0-9_-]+
 *   inline_value  := <rest of line, optionally quoted>
 *   block_scalar  := ('|' | '>') newline (indented lines)+
 *   nested_map    := newline (indented `key: value`)+        -- e.g. `metadata`
 *   folded_plain  := newline (indented plain text)+          -- folds to one string
 *
 * Disambiguation of the empty-value cases (`key:` with no inline value):
 *   - The next non-blank line dictates the shape.
 *   - Zero indentation (or EOF) → empty string.
 *   - Indented and looks like `subkey: …` → nested map.
 *   - Indented plain text       → folded plain scalar (YAML 1.2 default;
 *                                 joined with single spaces, like `>`).
 *
 * Comments (`# ...`) and blank lines are skipped. Quoted strings honor
 * `\"` / `\'` and `\\` escapes; unquoted strings are trimmed.
 */
export function parseFrontmatterYaml(text: string): YamlOk | YamlErr {
  const errors: ParseError[] = []
  const out: Record<string, RawYamlValue> = {}
  const lines = text.split("\n")
  let i = 0

  while (i < lines.length) {
    const lineNo = i + 1
    const raw = lines[i]

    // Skip blanks and comments.
    if (raw.trim().length === 0 || raw.trimStart().startsWith("#")) {
      i++
      continue
    }

    // Top-level entries must start at column 0 (no leading whitespace).
    if (/^\s/.test(raw)) {
      errors.push({
        message: `unexpected indentation at top level (line ${lineNo})`,
        line: lineNo,
      })
      i++
      continue
    }

    const m = raw.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:(.*)$/)
    if (!m) {
      errors.push({ message: `expected "key: value" (line ${lineNo})`, line: lineNo })
      i++
      continue
    }

    const key = m[1]
    const rest = m[2]
    if (key in out) {
      errors.push({ message: `duplicate key "${key}" (line ${lineNo})`, line: lineNo })
    }

    const valuePart = stripInlineComment(rest).trim()

    // Block scalar header: `|` (literal) or `>` (folded), with an
    // optional chomping indicator (`-` strip, `+` keep) per YAML 1.2.
    // We honour the style but ignore the chomping subtlety — our
    // `consumeBlockScalar` already strips trailing empties, which is
    // close enough for `description:`-style string fields. Indent
    // indicators (`|2`, `>3`, …) are not supported.
    const blockHeader = valuePart.match(/^([|>])([-+])?$/)
    if (blockHeader) {
      const style = blockHeader[1]
      const block = consumeBlockScalar(lines, i + 1)
      if (style === "|") {
        // Literal: preserve newlines as-is.
        out[key] = block.value
      } else {
        // Folded: join non-empty lines with single spaces.
        out[key] = block.value
          .split("\n")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .join(" ")
      }
      i = block.nextIndex
      continue
    }

    if (valuePart === "") {
      // An empty inline value can mean three things in YAML, and we must
      // peek the following content to disambiguate:
      //   1. EOF / next line at column 0           → empty string
      //   2. Indented `subkey: value` block        → nested map
      //   3. Indented plain text                   → folded plain scalar
      //
      // Case (3) is the YAML 1.2 default when an indented plain-text
      // block follows an empty mapping value. It is widely used by
      // third-party skills to wrap long `description:` strings across
      // several lines without quotes or block-scalar indicators.
      let peekIdx = i + 1
      while (peekIdx < lines.length) {
        const pl = lines[peekIdx]
        if (pl.trim().length === 0 || pl.trimStart().startsWith("#")) {
          peekIdx++
          continue
        }
        break
      }

      if (peekIdx >= lines.length || !/^\s/.test(lines[peekIdx])) {
        // Case 1: no indented continuation.
        out[key] = ""
        i++
        continue
      }

      // First indented non-blank line — decide between map and folded
      // scalar based on whether it looks like a `subkey:` entry. Real
      // YAML uses richer context here (presence of a colon at the
      // appropriate position), but our keys-as-identifiers grammar
      // makes the simple regex check unambiguous for spec-conformant
      // skills. Authors who need a literal `Word:` at the start of a
      // plain scalar should quote the value.
      const peekTrim = lines[peekIdx].trimStart()
      const looksLikeMapEntry = /^[A-Za-z][A-Za-z0-9_-]*\s*:/.test(peekTrim)

      if (looksLikeMapEntry) {
        const nested = consumeNestedMap(lines, i + 1)
        if (nested.entries.size > 0) {
          const m: Record<string, string> = {}
          for (const [k, v] of nested.entries) m[k] = v
          out[key] = m
          i = nested.nextIndex
          continue
        }
        // Defensive fall-through: the lookahead said "map-like" but
        // consumeNestedMap returned nothing (e.g. mixed
        // indentation). Treat as folded scalar so we don't lose the
        // content with a confusing "unexpected indentation" error.
      }

      // Case 3: indented plain scalar. Reuse the block-scalar consumer
      // and apply `>`-style folding (trim each line, drop empties,
      // join with single spaces).
      const block = consumeBlockScalar(lines, i + 1)
      out[key] = block.value
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .join(" ")
      i = block.nextIndex
      continue
    }

    // Inline scalar value.
    const parsed = parseScalar(valuePart)
    if (parsed.error) {
      errors.push({ message: `${parsed.error} (line ${lineNo})`, line: lineNo })
      i++
      continue
    }
    out[key] = parsed.value
    i++
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: out }
}

/** Strip an unescaped `# ...` trailing comment from a value. */
function stripInlineComment(s: string): string {
  // Comments only count if preceded by whitespace (so `https://x#y` is
  // not a comment). YAML's actual rule is similar.
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === "\\" && (inSingle || inDouble)) {
      i++
      continue
    }
    if (c === "'" && !inDouble) inSingle = !inSingle
    else if (c === '"' && !inSingle) inDouble = !inDouble
    else if (c === "#" && !inSingle && !inDouble) {
      if (i === 0 || /\s/.test(s[i - 1])) return s.slice(0, i)
    }
  }
  return s
}

interface ScalarResult {
  value: string
  error?: string
}

/**
 * Parse a single inline scalar value. Supports double-quoted, single-
 * quoted, or bare strings. Returns the unquoted text (escapes applied).
 */
function parseScalar(text: string): ScalarResult {
  if (text.length === 0) return { value: "" }

  if (text.startsWith('"')) {
    // Double-quoted: must end with unescaped `"`.
    let out = ""
    let i = 1
    while (i < text.length) {
      const c = text[i]
      if (c === "\\" && i + 1 < text.length) {
        const next = text[i + 1]
        switch (next) {
          case "n":
            out += "\n"
            break
          case "t":
            out += "\t"
            break
          case "r":
            out += "\r"
            break
          case '"':
            out += '"'
            break
          case "\\":
            out += "\\"
            break
          case "/":
            out += "/"
            break
          default:
            out += next
            break
        }
        i += 2
        continue
      }
      if (c === '"') {
        // Must be at end of string (no trailing data allowed).
        if (i !== text.length - 1) {
          return { value: "", error: "unexpected text after closing double-quote" }
        }
        return { value: out }
      }
      out += c
      i++
    }
    return { value: "", error: "unterminated double-quoted string" }
  }

  if (text.startsWith("'")) {
    // Single-quoted: YAML rule is that `''` represents a literal single
    // quote, and no other escapes apply.
    let out = ""
    let i = 1
    while (i < text.length) {
      const c = text[i]
      if (c === "'") {
        if (text[i + 1] === "'") {
          out += "'"
          i += 2
          continue
        }
        if (i !== text.length - 1) {
          return { value: "", error: "unexpected text after closing single-quote" }
        }
        return { value: out }
      }
      out += c
      i++
    }
    return { value: "", error: "unterminated single-quoted string" }
  }

  // Bare string. Reject flow-style sequences/mappings up front so users
  // get a clear error instead of a confusing one-string blob.
  if (text.startsWith("[") || text.startsWith("{")) {
    return {
      value: "",
      error: "flow-style sequences/mappings are not supported in frontmatter",
    }
  }
  if (text.startsWith("&") || text.startsWith("*")) {
    return {
      value: "",
      error: "YAML anchors/aliases are not supported in frontmatter",
    }
  }
  return { value: text }
}

/**
 * Consume a block scalar (`|` or `>`) starting at `start`. Returns the
 * dedented text and the index of the next unconsumed line.
 */
function consumeBlockScalar(lines: string[], start: number): { value: string; nextIndex: number } {
  // Determine indentation from the first non-empty line.
  let baseIndent = -1
  const block: string[] = []
  let i = start
  for (; i < lines.length; i++) {
    const ln = lines[i]
    if (ln.trim().length === 0) {
      block.push("")
      continue
    }
    const indent = ln.length - ln.trimStart().length
    if (baseIndent === -1) {
      if (indent === 0) break // back to top-level
      baseIndent = indent
    }
    if (indent < baseIndent) break // de-dented out
    block.push(ln.slice(baseIndent))
  }
  // Trim trailing empties.
  while (block.length > 0 && block[block.length - 1].length === 0) block.pop()
  return { value: block.join("\n"), nextIndex: i }
}

/**
 * Consume an indented `key: value` block as a nested map. Returns the
 * map and the index of the next unconsumed line.
 */
function consumeNestedMap(
  lines: string[],
  start: number,
): { entries: Map<string, string>; nextIndex: number } {
  const entries = new Map<string, string>()
  let baseIndent = -1
  let i = start
  for (; i < lines.length; i++) {
    const ln = lines[i]
    if (ln.trim().length === 0 || ln.trimStart().startsWith("#")) continue
    const indent = ln.length - ln.trimStart().length
    if (indent === 0) break // top-level entry follows
    if (baseIndent === -1) baseIndent = indent
    if (indent < baseIndent) break

    const m = ln.slice(baseIndent).match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:(.*)$/)
    if (!m) break
    const k = m[1]
    const rest = stripInlineComment(m[2]).trim()
    const parsed = parseScalar(rest)
    // For nested maps we coerce to string regardless of inner errors —
    // the strict path is the top-level scalar parser. If the value
    // failed, keep the raw text so downstream validation flags it.
    entries.set(k, parsed.error ? rest : parsed.value)
  }
  return { entries, nextIndex: i }
}

// ---------------------------------------------------------------------------
// Step 3: validation per spec
// ---------------------------------------------------------------------------

/**
 * Validate raw key/value frontmatter against the spec, returning a
 * partially-typed object. Errors are pushed onto `errors`. Caller checks
 * `errors.length` after — we don't short-circuit so multiple problems
 * surface in one pass.
 */
export function validateFrontmatter(
  raw: Record<string, RawYamlValue>,
  opts: ParseOptions,
  errors: ParseError[],
): Partial<SkillFrontmatter> {
  const out: Partial<SkillFrontmatter> = {}

  // Required: name
  if (!("name" in raw)) {
    errors.push({ message: "frontmatter field `name` is required" })
  } else if (typeof raw.name !== "string") {
    errors.push({ message: "frontmatter field `name` must be a string" })
  } else {
    const nameErr = validateName(raw.name, opts)
    if (nameErr) errors.push({ message: nameErr })
    else out.name = raw.name
    if (
      out.name !== undefined &&
      opts.expectedDirName !== undefined &&
      out.name !== opts.expectedDirName
    ) {
      errors.push({
        message: `frontmatter \`name\` ("${out.name}") must match parent directory name ("${opts.expectedDirName}")`,
      })
    }
  }

  // Required: description
  if (!("description" in raw)) {
    errors.push({ message: "frontmatter field `description` is required" })
  } else if (typeof raw.description !== "string") {
    errors.push({ message: "frontmatter field `description` must be a string" })
  } else {
    const descErr = validateDescription(raw.description)
    if (descErr) errors.push({ message: descErr })
    else out.description = raw.description
  }

  // Optional: license
  if ("license" in raw) {
    if (typeof raw.license !== "string") {
      errors.push({ message: "frontmatter field `license` must be a string" })
    } else if (raw.license.length > 0) {
      out.license = raw.license
    }
  }

  // Optional: compatibility
  if ("compatibility" in raw) {
    if (typeof raw.compatibility !== "string") {
      errors.push({ message: "frontmatter field `compatibility` must be a string" })
    } else if (raw.compatibility.length > 500) {
      errors.push({
        message: `frontmatter field \`compatibility\` exceeds 500 characters (got ${raw.compatibility.length})`,
      })
    } else if (raw.compatibility.length > 0) {
      out.compatibility = raw.compatibility
    }
  }

  // Optional: metadata (must be a nested map)
  if ("metadata" in raw) {
    const m = raw.metadata
    if (typeof m === "string") {
      errors.push({
        message: "frontmatter field `metadata` must be a nested map (string→string)",
      })
    } else {
      // Coerce every value to string (YAML may have produced numbers in a
      // future, more permissive variant; today our parser only emits
      // strings, but stay defensive).
      const norm: Record<string, string> = {}
      for (const [k, v] of Object.entries(m)) {
        norm[k] = typeof v === "string" ? v : String(v)
      }
      if (Object.keys(norm).length > 0) out.metadata = norm
    }
  }

  // Optional: allowed-tools (experimental)
  // We tolerate both kebab-case (per spec) and the legacy camelCase
  // `allowedTools` so users coming from various tooling can paste
  // either.
  const allowedToolsKey =
    "allowed-tools" in raw ? "allowed-tools" : "allowedTools" in raw ? "allowedTools" : null
  if (allowedToolsKey) {
    const v = raw[allowedToolsKey]
    if (typeof v !== "string") {
      errors.push({
        message: `frontmatter field \`${allowedToolsKey}\` must be a string`,
      })
    } else {
      const tokens = v.split(/\s+/).filter((t) => t.length > 0)
      if (tokens.length > 0) out.allowedTools = tokens
    }
  }

  return out
}

/** Validate `name` against the spec. Returns an error string or null. */
function validateName(name: string, opts: ParseOptions): string | null {
  if (name.length === 0) return "frontmatter field `name` must be non-empty"
  if (name.length > 64)
    return `frontmatter field \`name\` exceeds 64 characters (got ${name.length})`
  if (!NAME_RE.test(name)) {
    return `frontmatter field \`name\` must match ${NAME_RE} (lowercase letters, digits, single hyphens; no leading/trailing hyphen; no consecutive hyphens)`
  }
  if (/<[^>]+>/.test(name)) {
    return "frontmatter field `name` must not contain XML tags"
  }
  if (!opts.allowReservedNames) {
    for (const reserved of RESERVED_SUBSTRINGS) {
      if (name.includes(reserved)) {
        return `frontmatter field \`name\` cannot contain reserved word "${reserved}" (set plugins["ma-skills"].allowReservedNames to override)`
      }
    }
  }
  return null
}

/** Validate `description` against the spec. Returns an error string or null. */
function validateDescription(desc: string): string | null {
  if (desc.length === 0) return "frontmatter field `description` must be non-empty"
  if (desc.length > 1024) {
    return `frontmatter field \`description\` exceeds 1024 characters (got ${desc.length})`
  }
  if (/<[^>]+>/.test(desc)) {
    return "frontmatter field `description` must not contain XML tags"
  }
  return null
}
