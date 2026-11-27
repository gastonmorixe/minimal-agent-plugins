/**
 * Gate: a prompt fragment handler holds no fixed prose of its own.
 *
 * The STE gate reads `PROMPT.md`, `prompts/*.md`, manifest strings and TS
 * literals after a `description:` or `systemPrompt:` key. A `promptFragments`
 * handler that builds system text from a plain string literal is not read, so
 * its words reach the model with no STE check (D25, 2026-11-27).
 *
 * This test reads every handler file that a manifest names in
 * `headless.promptFragments` (or `promptFragments`): a TS module or a shell
 * subprocess. It fails on a string literal (TS) or an `echo` / `printf`
 * literal (shell) of 4 or more words. Put that prose in a `prompts/*.md` file
 * of the plugin and load it with a text import. Dynamic values go in as
 * `%%name%%` template vars.
 *
 * A shell handler cannot read a prompts file in the compiled binary (core
 * extracts only the run file), so its echo text stays in the script. The STE
 * gate reads it as a `shell-echo` surface, and the allowlist names it.
 *
 * A literal that must stay goes in {@link ALLOWLIST} with a reason. A stale
 * entry also fails, so the list cannot rot.
 *
 * @module tests/ste/ste-fragment-prose.test
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { allSurfaces, PLUGINS_ROOT, shellEchoLiterals } from "./surfaces.ts"

/** The word count from which a literal is prose. */
const MIN_WORDS = 4

/** One handler file of a prompt fragment. */
interface HandlerFile {
  /** Repo-relative path, for example `ma-skills-plugin/handlers/prompt-fragment.ts`. */
  file: string
  /** `ts` for a module handler, `sh` for a shell subprocess. */
  lang: "ts" | "sh"
}

/** One prose literal in a handler file. */
interface Hit {
  file: string
  line: number
  text: string
}

/** One allowed literal and why it can stay in the handler. */
interface AllowEntry {
  file: string
  /** A distinctive substring of the literal. */
  text: string
  reason: string
}

const ALLOWLIST: readonly AllowEntry[] = [
  {
    file: "ma-env-info-plugin/gather.sh",
    text: "The values below are from the start of the session",
    reason:
      "A subprocess cannot read prompts/*.md in the compiled binary: core extracts only the run " +
      "file (materializeEmbedded in core src/plugins/source.ts). The STE gate reads this echo " +
      "text as a `shell-echo` surface (tests/ste/surfaces.ts).",
  },
]

/** Words of a literal: whitespace tokens that hold a letter. */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter((token) => /[A-Za-z]/.test(token)).length
}

/** Blank out comments, keep the line breaks so line numbers stay true. */
function stripTsComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
}

/**
 * Every string literal of a TS source with its words. A template literal
 * counts its fixed text only: each `${...}` part is removed.
 *
 * @param src - TS source text.
 * @returns Each literal with its 1-based line.
 */
export function tsLiterals(src: string): Array<{ text: string; line: number }> {
  const code = stripTsComments(src)
  const out: Array<{ text: string; line: number }> = []
  const re = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g
  for (const match of code.matchAll(re)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? ""
    const text = match[3] !== undefined ? raw.replace(/\$\{[^}]*\}/g, "") : raw
    out.push({ text, line: code.slice(0, match.index ?? 0).split("\n").length })
  }
  return out
}

/** The prose literals of one handler source. */
export function proseHits(file: string, lang: "ts" | "sh", src: string): Hit[] {
  const literals = lang === "ts" ? tsLiterals(src) : shellEchoLiterals(src)
  return literals
    .filter((literal) => wordCount(literal.text) >= MIN_WORDS)
    .map((literal) => ({ file, line: literal.line, text: literal.text }))
}

/** Every prompt fragment handler file of every manifest, sorted. */
function fragmentHandlers(root: string): HandlerFile[] {
  const out = new Map<string, HandlerFile>()
  for (const dir of readdirSync(root).sort()) {
    if (!dir.startsWith("ma-") || !statSync(join(root, dir)).isDirectory()) continue
    let manifest: Record<string, unknown>
    try {
      manifest = JSON.parse(readFileSync(join(root, dir, "manifest.json"), "utf8"))
    } catch {
      continue
    }
    const headless = (manifest.headless ?? {}) as Record<string, unknown>
    const frags = [
      ...((headless.promptFragments as unknown[]) ?? []),
      ...((manifest.promptFragments as unknown[]) ?? []),
    ] as Array<{ handler?: { type?: string; path?: string; command?: string[] } }>
    for (const frag of frags) {
      const h = frag.handler ?? {}
      const rel =
        h.type === "module" ? h.path : h.type === "subprocess" ? h.command?.[0] : undefined
      if (typeof rel !== "string") continue
      const file = join(dir, rel.replace(/^\.\//, ""))
      out.set(file, { file, lang: /\.[cm]?[jt]sx?$/.test(rel) ? "ts" : "sh" })
    }
  }
  return [...out.values()].sort((a, b) => a.file.localeCompare(b.file))
}

const allowed = (h: Hit): boolean =>
  ALLOWLIST.some((a) => a.file === h.file && h.text.includes(a.text))

describe("prompt fragment handlers hold no fixed prose", () => {
  const handlers = fragmentHandlers(PLUGINS_ROOT)
  const hits = handlers.flatMap((h) =>
    proseHits(h.file, h.lang, readFileSync(join(PLUGINS_ROOT, h.file), "utf8")),
  )

  test("finds the fragment handlers (TS and shell)", () => {
    expect(handlers.length).toBeGreaterThanOrEqual(5)
    expect(handlers.some((h) => h.lang === "sh")).toBe(true)
    expect(handlers.map((h) => h.file)).toContain("ma-agent-identity-plugin/handlers/identity.ts")
  })

  test("no handler literal of 4 or more words outside prompts/*.md", () => {
    const bad = hits.filter((h) => !allowed(h)).map((h) => `${h.file}:${h.line} ${h.text}`)
    expect(bad).toEqual([])
  })

  test("every allowlist entry still matches (no stale entries)", () => {
    const stale = ALLOWLIST.filter(
      (a) => !hits.some((h) => h.file === a.file && h.text.includes(a.text)),
    )
    expect(stale.map((a) => `${a.file}: ${a.text}`)).toEqual([])
  })

  test("every allowlist entry gives its reason", () => {
    for (const a of ALLOWLIST) expect(a.reason.length).toBeGreaterThan(40)
  })

  test("the STE gate reads each allowed shell literal as a shell-echo surface", () => {
    const echo = allSurfaces().filter((s) => s.kind === "shell-echo")
    for (const a of ALLOWLIST.filter((entry) => entry.file.endsWith(".sh"))) {
      expect(echo.some((s) => s.file === a.file && s.text.includes(a.text))).toBe(true)
    }
  })
})

describe("the scanner catches the forms it targets", () => {
  test("the old identity line is a hit", () => {
    const src = "export default (n: string) => `You are working as ${n}. Answer to this name.`\n"
    expect(proseHits("x.ts", "ts", src).map((h) => h.line)).toEqual([1])
  })

  test("a quoted prose literal is a hit, a comment and a short literal are not", () => {
    const src = [
      '// "this comment has five words"',
      "/* 'a block comment with words' */",
      'const a = "one two three"',
      "const b = 'one two three four'",
      'import t from "../prompts/a-long-file-name.md" with { type: "text" }',
    ].join("\n")
    expect(proseHits("x.ts", "ts", src).map((h) => h.line)).toEqual([4])
  })

  test("a template part does not count as words", () => {
    expect(
      proseHits("x.ts", "ts", "const r = `### ${a} (latest ${b} of ${c}, \\`${d}\\`)`"),
    ).toEqual([])
  })

  test("a shell echo of prose is a hit, a value echo and a comment are not", () => {
    const src = [
      "# echo 'a comment line with words'",
      "echo 'Host values from the start of the session.'",
      'echo "$HOME"',
      'printf \'%s=%s\\n\' "$key" "$val"',
    ].join("\n")
    expect(proseHits("x.sh", "sh", src).map((h) => h.line)).toEqual([2])
  })
})
