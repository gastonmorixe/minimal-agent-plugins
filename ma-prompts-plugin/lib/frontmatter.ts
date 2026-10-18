/**
 * Prompt file frontmatter: parse + serialize.
 *
 * Format (the `SKILL.md` shape minus skill-specific fields):
 *
 * ```
 * ---
 * name: review-pr
 * description: Review a pull request
 * metadata:
 *   team: platform
 * ---
 * The body, verbatim.
 * ```
 *
 * Tolerant parser: missing fence, unterminated fence, and wrong types are
 * reported as errors rather than thrown, so one bad file never crashes the
 * agent at startup.
 *
 * @module lib/frontmatter
 */

export interface PromptFrontmatter {
  name: string
  description: string
  metadata?: Record<string, string>
}

export interface ParsedPromptFile {
  /** null when the frontmatter is unusable. */
  front: PromptFrontmatter | null
  /** Body after the closing fence, verbatim. Empty string when absent. */
  body: string
  /** Non-empty when the file is broken. */
  errors: string[]
}

/** Strip a leading BOM. */
function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

/** Parse a prompt file body into frontmatter + verbatim body. */
export function parsePromptFile(raw: string): ParsedPromptFile {
  const text = stripBom(raw)
  const errors: string[] = []

  const firstLf = text.indexOf("\n")
  if (firstLf === -1 || text.slice(0, firstLf).trimEnd() !== "---") {
    return { front: null, body: text, errors: ["missing frontmatter (file must start with ---)"] }
  }

  // Walk to the closing fence.
  let scan = firstLf + 1
  let closeStart = -1
  let bodyStart = -1
  while (scan <= text.length) {
    const next = text.indexOf("\n", scan)
    const line = next === -1 ? text.slice(scan) : text.slice(scan, next)
    if (line.trimEnd() === "---") {
      closeStart = scan
      bodyStart = next === -1 ? text.length : next + 1
      break
    }
    if (next === -1) break
    scan = next + 1
  }
  if (closeStart === -1) {
    return { front: null, body: "", errors: ["unterminated frontmatter (missing closing ---)"] }
  }

  const block = text.slice(firstLf + 1, closeStart)
  const body = text.slice(bodyStart)
  const front = parseBlock(block, errors)
  return { front: errors.length > 0 ? null : front, body, errors }
}

/** Parse the indent-0 keys we care about. Tolerant of quotes and block scalars. */
function parseBlock(block: string, errors: string[]): PromptFrontmatter {
  const lines = block.split("\n")
  let name: string | undefined
  let description: string | undefined
  const metadata: Record<string, string> = {}
  let inMetadata = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue

    // Indented line: only meaningful inside `metadata`.
    if (/^\s/.test(line)) {
      if (inMetadata) {
        const m = /^\s+([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line)
        if (m) metadata[m[1]!] = unquote(m[2]!.trim())
      }
      continue
    }

    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1]!
    let value = m[2]!.trim()
    inMetadata = key === "metadata"

    if (key === "metadata") continue
    if (key !== "name" && key !== "description") continue

    // Block scalar continuation.
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const parts: string[] = []
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j]!
        if (/^\S/.test(next)) break
        parts.push(next.trim())
        i = j
      }
      value = parts.join(value.startsWith(">") ? " " : "\n").trim()
    } else {
      value = unquote(value)
    }

    if (key === "name") name = value
    else description = value
  }

  if (!name) errors.push("frontmatter is missing `name`")
  if (description === undefined) description = ""
  return {
    name: name ?? "",
    description,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  }
}

function unquote(v: string): string {
  const q = v[0]
  if ((q === '"' || q === "'") && v.length >= 2 && v.endsWith(q)) return v.slice(1, -1)
  return v
}

/** Quote a scalar only when it needs it. */
function quoteIfNeeded(s: string): string {
  if (s !== "" && /^[A-Za-z0-9._/\- ]+$/.test(s) && s.trim() === s) return s
  const escaped = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")
  return `"${escaped}"`
}

/** Serialize frontmatter + body into the on-disk file text. */
export function serializePromptFile(front: PromptFrontmatter, body: string): string {
  const lines: string[] = ["---"]
  lines.push(`name: ${quoteIfNeeded(front.name)}`)
  lines.push(`description: ${quoteIfNeeded(front.description)}`)
  if (front.metadata && Object.keys(front.metadata).length > 0) {
    lines.push("metadata:")
    for (const [k, v] of Object.entries(front.metadata)) {
      lines.push(`  ${k}: ${quoteIfNeeded(v)}`)
    }
  }
  lines.push("---")
  const trimmed = body.replace(/\s+$/, "")
  return `${lines.join("\n")}\n${trimmed}\n`
}
