/**
 * Embed-safety gate: no plugin may locate its OWN files at runtime.
 *
 * A compiled minimal-agent binary embeds every first-party plugin. Inside it,
 * `import.meta.dir` of every module is `/$bunfs/root` and the plugin's files
 * (prompts, templates, JSON) are not on disk. So a plugin that finds a sibling
 * file through `import.meta.dir` / `import.meta.url`, a `promptPath(...)`
 * helper, or `readFileSync(join(packageDir, ...))` works from the checkout and
 * breaks in the binary. Load such files with a static text import instead
 * (`import text from "./prompts/foo.md"` plus the `type: "text"` import
 * attribute). Bun inlines the text, so the same code path works in both modes. Use one
 * import style per file (a `text` + `file` import of the same file collapses
 * to text).
 *
 * The scan covers every non-test `.ts` file under `ma-*`. Legitimate uses go
 * in {@link ALLOWLIST} with a reason. A stale allowlist entry (one that no
 * longer matches) also fails, so the list cannot rot.
 *
 * @module tests/embed-safety
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { isAbsolute, join, posix, relative } from "node:path"

import { describe, expect, it } from "bun:test"

import anthropicBilling from "../ma-llm-anthropic-plugin/prompts/billing.tmpl.md" with {
  type: "text",
}
import anthropicIdentity from "../ma-llm-anthropic-plugin/prompts/identity.claude-code.md" with {
  type: "text",
}
import cursorToolCatalog from "../ma-llm-cursor-plugin/prompts/tool-catalog.md" with {
  type: "text",
}
import memoryFramingGlobal from "../ma-memory-plugin/prompts/framing.global.md" with {
  type: "text",
}
import memoryFramingProject from "../ma-memory-plugin/prompts/framing.project.md" with {
  type: "text",
}
import memorySummarize from "../ma-memory-plugin/prompts/summarize.tmpl.md" with { type: "text" }
import subAgentsLeaf from "../ma-sub-agents-plugin/prompts/leaf-discipline.md" with { type: "text" }
import subAgentsResult from "../ma-sub-agents-plugin/prompts/result-protocol.tmpl.md" with {
  type: "text",
}
import tasksPlanning from "../ma-tasks-plugin/prompts/planning.md" with { type: "text" }
import tasksCompact from "../ma-tasks-plugin/prompts/results-compact.md" with { type: "text" }
import tasksFull from "../ma-tasks-plugin/prompts/results-full.md" with { type: "text" }

const ROOT = join(import.meta.dir, "..")

/** A forbidden self-location pattern. */
interface Rule {
  id: string
  re: RegExp
}

const RULES: readonly Rule[] = [
  // Any module-relative self-location. Embedded, these all point at /$bunfs.
  { id: "import-meta-path", re: /import\.meta\.(dir|dirname|url|filename|path)\b/ },
  // The vendored prompt helpers took `import.meta` and joined a path.
  { id: "prompt-path-helper", re: /\bpromptPath\s*\(/ },
  // Reading a file under the plugin's own package dir.
  {
    id: "read-under-package-dir",
    re: /\b(readFileSync|readFile|Bun\.file)\s*\(\s*(join|resolve)\s*\(\s*(ctx\.)?packageDir\b/,
  },
  // Building a prompts/templates dir under the package dir to read from.
  {
    id: "package-dir-prompts",
    re: /\b(join|resolve)\s*\(\s*(ctx\.)?packageDir\s*,\s*["'](prompts|templates)\b/,
  },
]

/** One allowed (file, rule) pair and why it is safe. `line` is a distinctive
 * substring of the offending line; when the line moves or changes without the
 * entry changing, the entry is stale and the gate fails. */
interface AllowEntry {
  file: string
  rule: string
  reason: string
  line: string
}

const ALLOWLIST: readonly AllowEntry[] = [
  {
    file: "ma-diagnostics-plugin/lib/tsconfig-scope.ts",
    rule: "import-meta-path",
    line: "createRequire(import.meta.url)",
    reason:
      "createRequire(import.meta.url) resolves the optional `typescript` package, not a plugin " +
      "file. It sits in a try/catch and degrades when absent (embedded or not).",
  },
  {
    file: "ma-config-plugin/handlers/cmd_config.ts",
    rule: "import-meta-path",
    line: 'new URL("..", import.meta.url)',
    reason:
      "Fallback only, used while the host CommandContext lacks packageDir (older core). " +
      "ctx.packageDir wins when present. Delete once core passes it (W2 step 4).",
  },
  {
    file: "ma-chrome-cdp-plugin/bin/cdpd.ts",
    rule: "import-meta-path",
    line: "fileURLToPath(import.meta.url)",
    reason:
      "Derives the package dir only as the SOURCE-run devPath of cdp-server.ts for " +
      'selfSpawn().script("ma-chrome-cdp/cdp-server", ...). Compiled, the helper ignores ' +
      "it and spawns `<binary> __run`. No file is read from it.",
  },
  {
    file: "ma-computer-use-plugin/bin/cud.ts",
    rule: "import-meta-path",
    line: "fileURLToPath(import.meta.url)",
    reason:
      "macOS developer tool (xcodegen/xcodebuild of the helper app), never a runtime path. " +
      "W2 section 5 leaves it as is.",
  },
  {
    file: "ma-security-plugin/src/test-support.ts",
    rule: "import-meta-path",
    line: "dirname(import.meta.dir)",
    reason: "Test support module, imported by tests only.",
  },
  {
    file: "ma-llm-openai-plugin/openai.test-helpers.ts",
    rule: "import-meta-path",
    line: 'join(import.meta.dir, "__fixtures__"',
    reason: "Test helper reading __fixtures__, imported by tests only.",
  },
  {
    file: "ma-llm-cursor-plugin/scripts/generate-static-catalog.ts",
    rule: "import-meta-path",
    line: 'join(import.meta.dir, "..")',
    reason: "Developer script run from the checkout, not part of the plugin runtime.",
  },
  {
    file: "ma-llm-cursor-plugin/scripts/probe-carry.ts",
    rule: "import-meta-path",
    line: "import.meta.dir,",
    reason: "Developer probe run from the checkout, not part of the plugin runtime.",
  },
  {
    file: "ma-llm-cursor-plugin/scripts/probe-run-encode.ts",
    rule: "import-meta-path",
    line: "import.meta.dir,",
    reason: "Developer probe run from the checkout, not part of the plugin runtime.",
  },
]

const SKIP_DIRS = new Set(["node_modules", "__fixtures__", ".net-dbg", "dist", "build"])

function isTestFile(name: string): boolean {
  return /\.(test|spec)\.tsx?$/.test(name)
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue
    const abs = join(dir, name)
    const st = statSync(abs)
    if (st.isDirectory()) walk(abs, out)
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !name.endsWith(".d.ts") && !isTestFile(name)) {
      out.push(abs)
    }
  }
}

function pluginSources(): string[] {
  const out: string[] = []
  for (const name of readdirSync(ROOT)) {
    if (!name.startsWith("ma-")) continue
    const abs = join(ROOT, name)
    if (statSync(abs).isDirectory()) walk(abs, out)
  }
  return out.sort()
}

/** Strip `//` line comments and block comments so prose mentions don't trip the scan. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
}

interface Hit {
  file: string
  rule: string
  line: number
  text: string
}

function scan(): Hit[] {
  const hits: Hit[] = []
  for (const abs of pluginSources()) {
    const rel = relative(ROOT, abs)
    const lines = stripComments(readFileSync(abs, "utf8")).split("\n")
    for (let i = 0; i < lines.length; i++) {
      for (const rule of RULES) {
        if (rule.re.test(lines[i])) {
          hits.push({ file: rel, rule: rule.id, line: i + 1, text: lines[i].trim() })
        }
      }
    }
  }
  return hits
}

const allowed = (h: Hit): boolean => ALLOWLIST.some((a) => a.file === h.file && a.rule === h.rule)

describe("embed safety", () => {
  const hits = scan()

  it("scans a real tree", () => {
    expect(pluginSources().length).toBeGreaterThan(100)
  })

  it("no plugin locates its own files via import.meta, promptPath or packageDir reads", () => {
    const bad = hits
      .filter((h) => !allowed(h))
      .map((h) => `${h.file}:${h.line} [${h.rule}] ${h.text}`)
    expect(bad).toEqual([])
  })

  it("every allowlist entry still matches (no stale entries)", () => {
    const stale = ALLOWLIST.filter((a) => !hits.some((h) => h.file === a.file && h.rule === a.rule))
    expect(stale.map((a) => `${a.file} [${a.rule}]`)).toEqual([])
  })

  it("every allowlist entry still matches the recorded line (no drifted entries)", () => {
    const drifted = ALLOWLIST.filter(
      (a) => !hits.some((h) => h.file === a.file && h.rule === a.rule && h.text.includes(a.line)),
    )
    expect(drifted.map((a) => `${a.file} [${a.rule}] line ${JSON.stringify(a.line)}`)).toEqual([])
  })

  it("every allowlist entry documents its reason", () => {
    for (const a of ALLOWLIST) expect(a.reason.length).toBeGreaterThan(20)
  })

  it("the rules catch the patterns they target", () => {
    const probe = (s: string) => RULES.filter((r) => r.re.test(s)).map((r) => r.id)
    expect(probe('readFileSync(new URL("./p.md", import.meta.url))')).toContain("import-meta-path")
    expect(probe("join(import.meta.dir, 'prompts')")).toContain("import-meta-path")
    expect(probe('promptPath(import.meta, "..", "prompts", "x.md")')).toContain(
      "prompt-path-helper",
    )
    expect(probe('readFileSync(join(ctx.packageDir, "prompts", "a.md"))')).toContain(
      "read-under-package-dir",
    )
    expect(probe('const d = join(ctx.packageDir, "prompts")')).toContain("package-dir-prompts")
    expect(probe('import t from "./prompts/a.md" with { type: "text" }')).toEqual([])
  })

  it("negative fixtures trip their rule and only their rule", () => {
    const cases: [string, string[]][] = [
      ["rule-import-meta-path.ts.txt", ["import-meta-path"]],
      ["rule-prompt-path-helper.ts.txt", ["prompt-path-helper"]],
      ["rule-read-under-package-dir.ts.txt", ["read-under-package-dir"]],
      ["rule-package-dir-prompts.ts.txt", ["package-dir-prompts"]],
    ]
    const fixtures = join(ROOT, "tests", "__fixtures__", "embed-safety")
    let covered = 0
    for (const [name, want] of cases) {
      const lines = stripComments(readFileSync(join(fixtures, name), "utf8")).split("\n")
      let fired = 0
      for (const raw of lines) {
        const line = raw.trim()
        // Comment header and blank lines carry no pattern; every code line must trip.
        if (line === "" || line.startsWith("//")) continue
        const got = RULES.filter((r) => r.re.test(raw)).map((r) => r.id)
        expect(got.sort()).toEqual([...want].sort())
        fired++
      }
      expect(fired).toBeGreaterThan(0)
      covered += fired
    }
    expect(covered).toBeGreaterThanOrEqual(cases.length)
  })

  it("static text imports trip no rule", () => {
    const src = readFileSync(
      join(ROOT, "tests", "__fixtures__", "embed-safety", "negative-text-import.ts.txt"),
      "utf8",
    )
    for (const raw of stripComments(src).split("\n")) {
      if (raw.trim() === "" || raw.trim().startsWith("//")) continue
      expect(RULES.filter((r) => r.re.test(raw)).map((r) => r.id)).toEqual([])
    }
  })
})

describe("migrated prompt text imports are byte-identical to the files", () => {
  const cases: [string, string][] = [
    ["ma-llm-anthropic-plugin/prompts/billing.tmpl.md", anthropicBilling],
    ["ma-llm-anthropic-plugin/prompts/identity.claude-code.md", anthropicIdentity],
    ["ma-llm-cursor-plugin/prompts/tool-catalog.md", cursorToolCatalog],
    ["ma-memory-plugin/prompts/framing.global.md", memoryFramingGlobal],
    ["ma-memory-plugin/prompts/framing.project.md", memoryFramingProject],
    ["ma-memory-plugin/prompts/summarize.tmpl.md", memorySummarize],
    ["ma-sub-agents-plugin/prompts/leaf-discipline.md", subAgentsLeaf],
    ["ma-sub-agents-plugin/prompts/result-protocol.tmpl.md", subAgentsResult],
    ["ma-tasks-plugin/prompts/planning.md", tasksPlanning],
    ["ma-tasks-plugin/prompts/results-compact.md", tasksCompact],
    ["ma-tasks-plugin/prompts/results-full.md", tasksFull],
  ]
  for (const [rel, imported] of cases) {
    it(rel, () => {
      expect(imported).toBe(readFileSync(join(ROOT, rel), "utf8"))
    })
  }
})

/**
 * Asset enumeration: every first-party plugin asset reachable at runtime must
 * exist on disk and is therefore covered by the embedding contract.
 *
 * Mirrors the ref kinds `scripts/gen-embedded-plugins.ts` (minimal-agent-cli,
 * READ ONLY: never edited from here) consumes per package: any module-type
 * handler object with a path anywhere in the manifest (tools, hooks, setup,
 * ui.setup, liveAreaSlots, and so on), any subprocess-type handler command
 * exe, the promptTemplate / sidebandCodec / errorRenderers entry fields,
 * every `scripts` value, `manifest.prompt`, and the provider entry.
 *
 * Gap note: the generator doc also names `cli.commands` handlers, but no
 * manifest ships a `cli` key today, so the generic module walk covers that
 * kind vacuously. If a `cli` key ever appears with module handlers, this
 * block picks them up with no change.
 */
describe("every manifest asset resolves on disk (embedding contract)", () => {
  /** Local mirror of core `normalizePackagePath` (src/plugins/source.ts). */
  function normalizePackagePath(rel: string): string | null {
    if (rel.length === 0 || rel.includes("\0") || rel.includes("\\")) return null
    if (isAbsolute(rel) || rel.startsWith("/")) return null
    if (rel.endsWith("/")) return null
    const n = posix.normalize(rel)
    if (n === "." || n === ".." || n.startsWith("../") || n.startsWith("/")) return null
    return n
  }

  /** Module file extensions, same set the generator uses for run files. */
  const MODULE_EXT_RE = /\.(?:[cm]?[jt]sx?)$/

  function isObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === "object" && !Array.isArray(v)
  }

  interface AssetRef {
    pkg: string
    kind: string
    rel: string
  }

  function collectRefs(): { modules: AssetRef[]; files: AssetRef[]; packages: string[] } {
    const modules: AssetRef[] = []
    const files: AssetRef[] = []
    const packages: string[] = []
    const walk = (pkg: string, node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) walk(pkg, item)
        return
      }
      if (!isObject(node)) return
      if (node.type === "module" && typeof node.path === "string") {
        modules.push({ pkg, kind: "module path", rel: node.path })
      }
      if (node.type === "subprocess" && Array.isArray(node.command)) {
        const exe = node.command[0]
        if (typeof exe === "string" && normalizePackagePath(exe) !== null) {
          const ref = { pkg, kind: "subprocess command", rel: exe }
          if (MODULE_EXT_RE.test(exe)) modules.push(ref)
          else files.push(ref)
        }
      }
      for (const value of Object.values(node)) walk(pkg, value)
    }
    for (const name of readdirSync(ROOT).sort()) {
      if (!name.startsWith("ma-")) continue
      const dir = join(ROOT, name)
      if (!statSync(dir).isDirectory()) continue
      const manifestPath = join(dir, "manifest.json")
      const providerPath = join(dir, "provider.json")
      let isPackage = false
      const readJson = (p: string): unknown => JSON.parse(readFileSync(p, "utf8"))
      const entryOf = (v: unknown, kind: string): void => {
        if (isObject(v) && typeof v.entry === "string")
          modules.push({ pkg: name, kind, rel: v.entry })
      }
      try {
        if (statSync(manifestPath).isFile()) {
          isPackage = true
          const manifest = readJson(manifestPath)
          walk(name, manifest)
          if (isObject(manifest)) {
            entryOf(manifest.promptTemplate, "promptTemplate entry")
            entryOf(manifest.sidebandCodec, "sidebandCodec entry")
            if (Array.isArray(manifest.errorRenderers)) {
              for (const er of manifest.errorRenderers) entryOf(er, "errorRenderers entry")
            }
            if (isObject(manifest.scripts)) {
              for (const v of Object.values(manifest.scripts)) {
                if (typeof v === "string")
                  modules.push({ pkg: name, kind: "scripts value", rel: v })
              }
            }
            if (typeof manifest.prompt === "string") {
              modules.push({ pkg: name, kind: "manifest prompt", rel: manifest.prompt })
            }
          }
        }
      } catch {
        // Not valid JSON or unreadable: the loader / typecheck gate owns that.
      }
      try {
        if (statSync(providerPath).isFile()) {
          isPackage = true
          const provider = readJson(providerPath)
          if (isObject(provider) && typeof provider.entry === "string") {
            modules.push({ pkg: name, kind: "provider entry", rel: provider.entry })
          }
        }
      } catch {
        // Same as above: another gate's problem, not this scan's.
      }
      if (isPackage) packages.push(name)
    }
    return { modules, files, packages }
  }

  const { modules, files, packages } = collectRefs()

  it("every first-party package dir carries a manifest or provider", () => {
    expect(packages.length).toBeGreaterThanOrEqual(50)
  })

  it("every module, prompt and provider ref resolves to a file on disk", () => {
    const missing = modules
      .filter((r) => {
        const key = normalizePackagePath(r.rel)
        if (key === null) return true
        try {
          return !statSync(join(ROOT, r.pkg, key)).isFile()
        } catch {
          return true
        }
      })
      .map((r) => `${r.pkg} [${r.kind}] ${r.rel}`)
    expect(missing).toEqual([])
  })

  it("every subprocess run file resolves to a file on disk", () => {
    const missing = files
      .filter((r) => {
        const key = normalizePackagePath(r.rel)
        if (key === null) return true
        try {
          return !statSync(join(ROOT, r.pkg, key)).isFile()
        } catch {
          return true
        }
      })
      .map((r) => `${r.pkg} [${r.kind}] ${r.rel}`)
    expect(missing).toEqual([])
  })

  it("the embedded module count is sane (generator embeds >100 modules)", () => {
    expect(modules.length).toBeGreaterThan(100)
  })
})
