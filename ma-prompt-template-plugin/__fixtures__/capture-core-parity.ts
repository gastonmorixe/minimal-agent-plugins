/**
 * One-off capture of the core prompt engine outputs for parity.test.ts.
 *
 * HISTORY ONLY. This script needs the core engine
 * (`minimal-agent-core/src/prompts/prompts.ts`), which core removes in the
 * zero-prompts decouple. It was run once, before that removal, to write
 * `core-engine-parity.json`. It is kept only to show how the fixture was made.
 * It will not run once the core engine is gone.
 *
 * Run (from minimal-agent-plugins): bun run ma-prompt-template-plugin/__fixtures__/capture-core-parity.ts
 *
 * Cases, per prompt asset (same as the old live parity test):
 * - A: every placeholder set to `v:<name>`.
 * - B: only required placeholders set.
 * - C: every placeholder set except the first required one (only when the
 *   asset has a required placeholder).
 *
 * Each case stores the template text, the vars and either the rendered text or
 * the error (`missing` names and `message`). The absolute source path inside
 * the error message is replaced with the repo-relative path, so the fixture
 * has no machine path.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"

import { PLACEHOLDER_RE } from "../template.ts"

const HERE = import.meta.dir
const PLUGIN_DIR = join(HERE, "..")
const PLUGINS_ROOT = join(PLUGIN_DIR, "..")
const REPO_ROOT = join(PLUGINS_ROOT, "..")
const CORE_PROMPTS = join(REPO_ROOT, "minimal-agent-core", "src", "prompts")

// A computed path, so the typecheck does not need the core file to exist.
const coreEngine = join(CORE_PROMPTS, "prompts.ts")
const core = (await import(coreEngine)) as {
  renderPrompt: (abs: string, vars: Record<string, string>) => string
  clearPromptCache: () => void
}

const SKIP = new Set(["README.md", "PROMPT.md"])

function scan(cwd: string, pattern: string): string[] {
  const out: string[] = []
  for (const rel of new Bun.Glob(pattern).scanSync({ cwd, onlyFiles: true })) {
    if (rel.split("/").includes("node_modules")) continue
    if (SKIP.has(basename(rel))) continue
    out.push(join(cwd, rel))
  }
  return out
}

const assets = [
  ...scan(CORE_PROMPTS, "**/*.md"),
  ...scan(PLUGINS_ROOT, "ma-*/prompts/**/*.md"),
  ...scan(join(PLUGIN_DIR, "__fixtures__"), "prompts/**/*.md"),
].sort()

function names(text: string): { required: string[]; optional: string[] } {
  const required = new Set<string>()
  const optionalSeen = new Set<string>()
  for (const m of text.matchAll(new RegExp(PLACEHOLDER_RE.source, "g"))) {
    const name = m[1] ?? ""
    if (m[2]) optionalSeen.add(name)
    else required.add(name)
  }
  return { required: [...required], optional: [...optionalSeen].filter((n) => !required.has(n)) }
}

function fixed(list: string[]): Record<string, string> {
  return Object.fromEntries(list.map((n) => [n, `v:${n}`]))
}

interface Case {
  name: string
  input: { path: string; text: string }
  vars: Record<string, string>
  output?: string
  error?: { missing: string[]; message: string }
}

const cases: Case[] = []

for (const abs of assets) {
  const path = abs.slice(REPO_ROOT.length + 1)
  const text = readFileSync(abs, "utf-8")
  const { required, optional } = names(text)
  const variants: [string, Record<string, string>][] = [
    ["A", fixed([...required, ...optional])],
    ["B", fixed(required)],
  ]
  if (required.length > 0) {
    const absent = required[0] ?? ""
    variants.push(["C", fixed([...required, ...optional].filter((n) => n !== absent))])
  }
  for (const [variant, vars] of variants) {
    const c: Case = { name: `${variant}:${path}`, input: { path, text }, vars }
    core.clearPromptCache()
    try {
      c.output = core.renderPrompt(abs, vars)
    } catch (err) {
      const e = err as { missing: string[]; message: string }
      c.error = { missing: e.missing, message: e.message.split(abs).join(path) }
    }
    cases.push(c)
  }
}

const out = join(HERE, "core-engine-parity.json")
writeFileSync(out, `${JSON.stringify({ assets: assets.length, cases }, null, 2)}\n`)
console.log(`wrote ${cases.length} cases for ${assets.length} assets to ${out}`)
