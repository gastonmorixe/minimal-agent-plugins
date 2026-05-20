/**
 * Tests for the SKILL.md frontmatter parser + validator.
 *
 * Coverage strategy:
 *   - `splitFrontmatter` covers structural edge cases (missing `---`,
 *     CRLF, BOM, body preservation).
 *   - `parseFrontmatterYaml` covers the YAML subset (scalars, quoted
 *     strings, block scalars, nested map, comments).
 *   - `parseSkillMd` covers end-to-end + spec validation rules. The
 *     spec page lists explicit valid + invalid examples; each one has
 *     a positive or negative test here.
 *
 * @module lib/skill-md.test
 */

import { describe, expect, test } from "bun:test"
import {
  parseFrontmatterYaml,
  parseSkillMd,
  splitFrontmatter,
  validateFrontmatter,
} from "./skill-md.ts"

const MIN = `---
name: my-skill
description: One line.
---
`

// ===========================================================================
// splitFrontmatter
// ===========================================================================

describe("splitFrontmatter", () => {
  test("happy path: split frontmatter + body", () => {
    const r = splitFrontmatter("---\nname: a\n---\n# Body")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.frontmatter).toBe("name: a")
    expect(r.body).toBe("# Body")
  })

  test("rejects when first line is not ---", () => {
    const r = splitFrontmatter("# heading\n---\nname: a\n---\n")
    expect(r.ok).toBe(false)
  })

  test("rejects when closing --- is missing", () => {
    const r = splitFrontmatter("---\nname: a\nno close")
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/closing/i)
  })

  test("tolerates UTF-8 BOM at file start", () => {
    const r = splitFrontmatter("\ufeff---\nname: a\n---\nbody")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.frontmatter).toBe("name: a")
  })

  test("handles CRLF line endings", () => {
    const r = splitFrontmatter("---\r\nname: a\r\n---\r\nhi\r\n")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.frontmatter.trim()).toBe("name: a")
    expect(r.body.replace(/\r/g, "")).toBe("hi\n")
  })

  test("body preserves blank lines", () => {
    const r = splitFrontmatter("---\nname: a\n---\nL1\n\n\nL2")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.body).toBe("L1\n\n\nL2")
  })

  test("body absent (frontmatter-only file)", () => {
    const r = splitFrontmatter("---\nname: a\n---\n")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.body).toBe("")
  })
})

// ===========================================================================
// parseFrontmatterYaml — scalars
// ===========================================================================

describe("parseFrontmatterYaml — scalars", () => {
  test("bare string", () => {
    const r = parseFrontmatterYaml("name: my-skill")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.name).toBe("my-skill")
  })

  test("double-quoted string with escapes", () => {
    const r = parseFrontmatterYaml('description: "Line\\nbreak"')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.description).toBe("Line\nbreak")
  })

  test("single-quoted string with '' escape", () => {
    const r = parseFrontmatterYaml("name: 'it''s here'")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.name).toBe("it's here")
  })

  test("strips trailing # comment after whitespace", () => {
    const r = parseFrontmatterYaml("name: my-skill   # this is a note")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.name).toBe("my-skill")
  })

  test("does not treat # without whitespace as comment", () => {
    const r = parseFrontmatterYaml("description: foo#bar")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.description).toBe("foo#bar")
  })

  test("rejects flow-style sequence", () => {
    const r = parseFrontmatterYaml("name: [a, b]")
    expect(r.ok).toBe(false)
  })

  test("rejects flow-style mapping", () => {
    const r = parseFrontmatterYaml("name: {k: v}")
    expect(r.ok).toBe(false)
  })

  test("rejects unterminated quoted string", () => {
    const r = parseFrontmatterYaml('description: "no end')
    expect(r.ok).toBe(false)
  })

  test("rejects unexpected top-level indentation", () => {
    const r = parseFrontmatterYaml("  name: x")
    expect(r.ok).toBe(false)
  })

  test("skips blanks and comment-only lines", () => {
    const r = parseFrontmatterYaml(`# header comment\n\nname: a\n\n  \n# trailing`)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.name).toBe("a")
  })

  test("detects duplicate keys", () => {
    const r = parseFrontmatterYaml("name: a\nname: b")
    expect(r.ok).toBe(false)
  })
})

// ===========================================================================
// parseFrontmatterYaml — block scalars + nested maps
// ===========================================================================

describe("parseFrontmatterYaml — block scalars", () => {
  test("literal block scalar (|) preserves newlines", () => {
    const text = `description: |\n  Line one.\n  Line two.\nname: x`
    const r = parseFrontmatterYaml(text)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.description).toBe("Line one.\nLine two.")
    expect(r.value.name).toBe("x")
  })

  test("folded block scalar (>) joins lines with space", () => {
    const text = `description: >\n  Line one\n  Line two\nname: x`
    const r = parseFrontmatterYaml(text)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.description).toBe("Line one Line two")
  })

  test("block scalar trims trailing empty lines", () => {
    const text = `description: |\n  x\n\n\nname: y`
    const r = parseFrontmatterYaml(text)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.description).toBe("x")
    expect(r.value.name).toBe("y")
  })

  test("literal block scalar with strip chomping (|-)", () => {
    // YAML 1.2: `|-` strips trailing newlines. We already drop trailing
    // empties, so the practical result is identical to bare `|` here.
    const text = `description: |-\n  Line one.\n  Line two.\nname: x`
    const r = parseFrontmatterYaml(text)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.description).toBe("Line one.\nLine two.")
    expect(r.value.name).toBe("x")
  })

  test("literal block scalar with keep chomping (|+)", () => {
    const text = `description: |+\n  Hi.\nname: x`
    const r = parseFrontmatterYaml(text)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.description).toBe("Hi.")
    expect(r.value.name).toBe("x")
  })

  test("folded block scalar with strip chomping (>-)", () => {
    const text =
      `description: >-\n` +
      `  Read source code instead of\n` +
      `  relying on training data.\n` +
      `name: x`
    const r = parseFrontmatterYaml(text)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.description).toBe(
      "Read source code instead of relying on training data.",
    )
    expect(r.value.name).toBe("x")
  })

  test("folded block scalar with keep chomping (>+)", () => {
    const text = `description: >+\n  one two\n  three four\nname: x`
    const r = parseFrontmatterYaml(text)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.description).toBe("one two three four")
  })
})

describe("parseFrontmatterYaml — nested map (metadata)", () => {
  test("simple nested map", () => {
    const text = `name: x\nmetadata:\n  author: alice\n  version: "1.0"\n`
    const r = parseFrontmatterYaml(text)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.metadata).toEqual({ author: "alice", version: "1.0" })
  })

  test("nested map de-dents back to top level", () => {
    const text = `metadata:\n  k: v\nname: x`
    const r = parseFrontmatterYaml(text)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.metadata).toEqual({ k: "v" })
    expect(r.value.name).toBe("x")
  })

  test("empty value with no nested entries becomes empty string", () => {
    const text = `metadata:\nname: x`
    const r = parseFrontmatterYaml(text)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.metadata).toBe("")
    expect(r.value.name).toBe("x")
  })
})

// ===========================================================================
// parseFrontmatterYaml — implicit folded plain scalar (YAML 1.2 default
// when an empty `key:` is followed by an indented plain-text block).
// This is the form third-party skills (e.g. Vercel) use to wrap long
// `description:` values across multiple lines without `|` or `>`.
// ===========================================================================

describe("parseFrontmatterYaml — implicit folded plain scalar", () => {
  test("indented continuation after empty key: folds to single line", () => {
    const text =
      `description:\n` +
      `  Line one continuing\n` +
      `  on the second line.\n` +
      `name: x`
    const r = parseFrontmatterYaml(text)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.description).toBe("Line one continuing on the second line.")
    expect(r.value.name).toBe("x")
  })

  test("Vercel-style multi-line description parses cleanly", () => {
    // Exact shape used by vercel-react-native-skills SKILL.md.
    const text =
      `name: vercel-react-native-skills\n` +
      `description:\n` +
      `  React Native and Expo best practices for building performant mobile apps. Use\n` +
      `  when building React Native components, optimizing list performance,\n` +
      `  implementing animations, or working with native modules. Triggers on tasks\n` +
      `  involving React Native, Expo, mobile performance, or native platform APIs.\n` +
      `license: MIT\n` +
      `metadata:\n` +
      `  author: vercel\n` +
      `  version: '1.0.0'\n`
    const r = parseFrontmatterYaml(text)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.name).toBe("vercel-react-native-skills")
    expect(r.value.description).toBe(
      "React Native and Expo best practices for building performant mobile apps. Use " +
        "when building React Native components, optimizing list performance, " +
        "implementing animations, or working with native modules. Triggers on tasks " +
        "involving React Native, Expo, mobile performance, or native platform APIs.",
    )
    expect(r.value.license).toBe("MIT")
    expect(r.value.metadata).toEqual({ author: "vercel", version: "1.0.0" })
  })

  test("blank line between key and continuation tolerated", () => {
    const text = `description:\n\n  text after blank\n  line\nname: x`
    const r = parseFrontmatterYaml(text)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.description).toBe("text after blank line")
  })

  test("de-dents back to top-level key correctly", () => {
    const text =
      `description:\n` +
      `  first line\n` +
      `  second line\n` +
      `license: MIT\n` +
      `name: x`
    const r = parseFrontmatterYaml(text)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.description).toBe("first line second line")
    expect(r.value.license).toBe("MIT")
    expect(r.value.name).toBe("x")
  })

  test("ambiguous map-like first line still parses as nested map", () => {
    // Backwards-compatible: an indented `key: value` first line is
    // treated as a nested map (current behaviour for `metadata:`).
    const text = `metadata:\n  author: alice\n  topic: testing\nname: x`
    const r = parseFrontmatterYaml(text)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.metadata).toEqual({ author: "alice", topic: "testing" })
  })
})

// ===========================================================================
// validateFrontmatter — name rules (spec page valid + invalid examples)
// ===========================================================================

describe("validateFrontmatter — name rules", () => {
  const desc = "A non-empty description."

  for (const valid of ["pdf-processing", "data-analysis", "code-review", "a", "x-y-z", "v2-thing"]) {
    test(`accepts valid name: ${valid}`, () => {
      const errors: ReturnType<typeof validateFrontmatter>["arguments"] extends never ? never : Parameters<typeof validateFrontmatter>[2] = []
      const out = validateFrontmatter({ name: valid, description: desc }, {}, errors)
      expect(errors).toEqual([])
      expect(out.name).toBe(valid)
    })
  }

  test("rejects uppercase (PDF-Processing)", () => {
    const errors: Parameters<typeof validateFrontmatter>[2] = []
    validateFrontmatter({ name: "PDF-Processing", description: desc }, {}, errors)
    expect(errors.length).toBeGreaterThan(0)
  })

  test("rejects leading hyphen (-pdf)", () => {
    const errors: Parameters<typeof validateFrontmatter>[2] = []
    validateFrontmatter({ name: "-pdf", description: desc }, {}, errors)
    expect(errors.length).toBeGreaterThan(0)
  })

  test("rejects trailing hyphen (pdf-)", () => {
    const errors: Parameters<typeof validateFrontmatter>[2] = []
    validateFrontmatter({ name: "pdf-", description: desc }, {}, errors)
    expect(errors.length).toBeGreaterThan(0)
  })

  test("rejects consecutive hyphens (pdf--processing)", () => {
    const errors: Parameters<typeof validateFrontmatter>[2] = []
    validateFrontmatter({ name: "pdf--processing", description: desc }, {}, errors)
    expect(errors.length).toBeGreaterThan(0)
  })

  test("rejects underscores", () => {
    const errors: Parameters<typeof validateFrontmatter>[2] = []
    validateFrontmatter({ name: "my_skill", description: desc }, {}, errors)
    expect(errors.length).toBeGreaterThan(0)
  })

  test("rejects empty string", () => {
    const errors: Parameters<typeof validateFrontmatter>[2] = []
    validateFrontmatter({ name: "", description: desc }, {}, errors)
    expect(errors.length).toBeGreaterThan(0)
  })

  test("rejects > 64 chars", () => {
    const errors: Parameters<typeof validateFrontmatter>[2] = []
    validateFrontmatter({ name: "a".repeat(65), description: desc }, {}, errors)
    expect(errors.length).toBeGreaterThan(0)
  })

  test("accepts exactly 64 chars", () => {
    const errors: Parameters<typeof validateFrontmatter>[2] = []
    const n = "a".repeat(64)
    const out = validateFrontmatter({ name: n, description: desc }, {}, errors)
    expect(errors).toEqual([])
    expect(out.name).toBe(n)
  })

  test("rejects XML tag in name", () => {
    const errors: Parameters<typeof validateFrontmatter>[2] = []
    // This will fail the regex first, but the XML check stays defensive.
    validateFrontmatter({ name: "a<b>", description: desc }, {}, errors)
    expect(errors.length).toBeGreaterThan(0)
  })

  test("rejects reserved word 'anthropic' by default", () => {
    const errors: Parameters<typeof validateFrontmatter>[2] = []
    validateFrontmatter({ name: "anthropic-tools", description: desc }, {}, errors)
    expect(errors.length).toBeGreaterThan(0)
  })

  test("rejects reserved word 'claude' by default", () => {
    const errors: Parameters<typeof validateFrontmatter>[2] = []
    validateFrontmatter({ name: "claude-helper", description: desc }, {}, errors)
    expect(errors.length).toBeGreaterThan(0)
  })

  test("allowReservedNames opt-out permits reserved words", () => {
    const errors: Parameters<typeof validateFrontmatter>[2] = []
    const out = validateFrontmatter(
      { name: "claude-helper", description: desc },
      { allowReservedNames: true },
      errors,
    )
    expect(errors).toEqual([])
    expect(out.name).toBe("claude-helper")
  })

  test("expectedDirName mismatch reported", () => {
    const errors: Parameters<typeof validateFrontmatter>[2] = []
    validateFrontmatter(
      { name: "real-name", description: desc },
      { expectedDirName: "dir-name" },
      errors,
    )
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].message).toMatch(/parent directory/i)
  })

  test("expectedDirName match passes silently", () => {
    const errors: Parameters<typeof validateFrontmatter>[2] = []
    validateFrontmatter(
      { name: "same", description: desc },
      { expectedDirName: "same" },
      errors,
    )
    expect(errors).toEqual([])
  })
})

// ===========================================================================
// validateFrontmatter — description rules
// ===========================================================================

describe("validateFrontmatter — description rules", () => {
  test("rejects empty", () => {
    const errors: Parameters<typeof validateFrontmatter>[2] = []
    validateFrontmatter({ name: "ok", description: "" }, {}, errors)
    expect(errors.length).toBeGreaterThan(0)
  })

  test("rejects > 1024 chars", () => {
    const errors: Parameters<typeof validateFrontmatter>[2] = []
    validateFrontmatter({ name: "ok", description: "a".repeat(1025) }, {}, errors)
    expect(errors.length).toBeGreaterThan(0)
  })

  test("accepts exactly 1024", () => {
    const errors: Parameters<typeof validateFrontmatter>[2] = []
    const d = "a".repeat(1024)
    const out = validateFrontmatter({ name: "ok", description: d }, {}, errors)
    expect(errors).toEqual([])
    expect(out.description).toBe(d)
  })

  test("rejects XML tags inside description", () => {
    const errors: Parameters<typeof validateFrontmatter>[2] = []
    validateFrontmatter(
      { name: "ok", description: "has <tag> inside" },
      {},
      errors,
    )
    expect(errors.length).toBeGreaterThan(0)
  })
})

// ===========================================================================
// validateFrontmatter — optional fields
// ===========================================================================

describe("validateFrontmatter — license / compatibility / metadata / allowed-tools", () => {
  const desc = "Hello."
  const okBase = () => ({ name: "ok", description: desc })

  test("license preserved as-is", () => {
    const errors: Parameters<typeof validateFrontmatter>[2] = []
    const out = validateFrontmatter({ ...okBase(), license: "Apache-2.0" }, {}, errors)
    expect(errors).toEqual([])
    expect(out.license).toBe("Apache-2.0")
  })

  test("empty license dropped (no error)", () => {
    const errors: Parameters<typeof validateFrontmatter>[2] = []
    const out = validateFrontmatter({ ...okBase(), license: "" }, {}, errors)
    expect(errors).toEqual([])
    expect(out.license).toBeUndefined()
  })

  test("compatibility ≤500 chars preserved", () => {
    const errors: Parameters<typeof validateFrontmatter>[2] = []
    const out = validateFrontmatter(
      { ...okBase(), compatibility: "Requires Python 3.14+" },
      {},
      errors,
    )
    expect(errors).toEqual([])
    expect(out.compatibility).toBe("Requires Python 3.14+")
  })

  test("compatibility > 500 chars rejected", () => {
    const errors: Parameters<typeof validateFrontmatter>[2] = []
    validateFrontmatter(
      { ...okBase(), compatibility: "x".repeat(501) },
      {},
      errors,
    )
    expect(errors.length).toBeGreaterThan(0)
  })

  test("metadata as nested map accepted", () => {
    const errors: Parameters<typeof validateFrontmatter>[2] = []
    const out = validateFrontmatter(
      { ...okBase(), metadata: { author: "alice", version: "1.0" } },
      {},
      errors,
    )
    expect(errors).toEqual([])
    expect(out.metadata).toEqual({ author: "alice", version: "1.0" })
  })

  test("metadata as string rejected", () => {
    const errors: Parameters<typeof validateFrontmatter>[2] = []
    validateFrontmatter({ ...okBase(), metadata: "oops" }, {}, errors)
    expect(errors.length).toBeGreaterThan(0)
  })

  test("metadata empty map dropped", () => {
    const errors: Parameters<typeof validateFrontmatter>[2] = []
    const out = validateFrontmatter({ ...okBase(), metadata: {} }, {}, errors)
    expect(errors).toEqual([])
    expect(out.metadata).toBeUndefined()
  })

  test("allowed-tools tokenised", () => {
    const errors: Parameters<typeof validateFrontmatter>[2] = []
    const out = validateFrontmatter(
      { ...okBase(), "allowed-tools": "Bash(git:*) Bash(jq:*) Read" },
      {},
      errors,
    )
    expect(errors).toEqual([])
    expect(out.allowedTools).toEqual(["Bash(git:*)", "Bash(jq:*)", "Read"])
  })

  test("camelCase allowedTools also accepted", () => {
    const errors: Parameters<typeof validateFrontmatter>[2] = []
    const out = validateFrontmatter(
      { ...okBase(), allowedTools: "Read Write" },
      {},
      errors,
    )
    expect(errors).toEqual([])
    expect(out.allowedTools).toEqual(["Read", "Write"])
  })

  test("allowed-tools empty string → dropped", () => {
    const errors: Parameters<typeof validateFrontmatter>[2] = []
    const out = validateFrontmatter(
      { ...okBase(), "allowed-tools": "   " },
      {},
      errors,
    )
    expect(errors).toEqual([])
    expect(out.allowedTools).toBeUndefined()
  })
})

// ===========================================================================
// parseSkillMd — end-to-end
// ===========================================================================

describe("parseSkillMd — end-to-end", () => {
  test("minimal happy path", () => {
    const r = parseSkillMd(MIN)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.front.name).toBe("my-skill")
    expect(r.value.front.description).toBe("One line.")
    expect(r.value.body).toBe("")
  })

  test("full happy path with all fields", () => {
    const text = `---
name: pdf-processing
description: Extract PDF text, fill forms, merge files. Use when handling PDFs.
license: Apache-2.0
compatibility: Requires Python 3.14+ and uv
metadata:
  author: example-org
  version: "1.0"
allowed-tools: Bash(pdftotext:*) Read
---
# PDF Processing
Use \`pdftotext\` to extract text.
`
    const r = parseSkillMd(text, { expectedDirName: "pdf-processing" })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.front.name).toBe("pdf-processing")
    expect(r.value.front.license).toBe("Apache-2.0")
    expect(r.value.front.compatibility).toBe("Requires Python 3.14+ and uv")
    expect(r.value.front.metadata).toEqual({ author: "example-org", version: "1.0" })
    expect(r.value.front.allowedTools).toEqual(["Bash(pdftotext:*)", "Read"])
    expect(r.value.body).toContain("# PDF Processing")
  })

  test("reports missing required fields", () => {
    const r = parseSkillMd("---\n---\n")
    expect(r.ok).toBe(false)
    if (r.ok) return
    const msgs = r.errors.map((e) => e.message).join(" | ")
    expect(msgs).toMatch(/name/i)
    expect(msgs).toMatch(/description/i)
  })

  test("collects multiple errors at once", () => {
    const r = parseSkillMd("---\nname: BAD\ndescription:\n---\n")
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors.length).toBeGreaterThanOrEqual(2)
  })

  test("malformed frontmatter delimiter surfaces split error", () => {
    const r = parseSkillMd("no frontmatter here")
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].message).toMatch(/frontmatter delimiter/i)
  })

  test("body preserved verbatim including code fences", () => {
    const text = `---
name: x
description: x
---
\`\`\`python
print("hi")
\`\`\`
`
    const r = parseSkillMd(text)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.body).toContain('print("hi")')
  })
})
