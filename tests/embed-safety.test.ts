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
import { join, relative } from "node:path"

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

/** One allowed (file, rule) pair and why it is safe. */
interface AllowEntry {
  file: string
  rule: string
  reason: string
}

const ALLOWLIST: readonly AllowEntry[] = [
  {
    file: "ma-diagnostics-plugin/lib/tsconfig-scope.ts",
    rule: "import-meta-path",
    reason:
      "createRequire(import.meta.url) resolves the optional `typescript` package, not a plugin " +
      "file. It sits in a try/catch and degrades when absent (embedded or not).",
  },
  {
    file: "ma-config-plugin/handlers/cmd_config.ts",
    rule: "import-meta-path",
    reason:
      "Fallback only, used while the host CommandContext lacks packageDir (older core). " +
      "ctx.packageDir wins when present. Delete once core passes it (W2 step 4).",
  },
  {
    file: "ma-chrome-cdp-plugin/bin/cdpd.ts",
    rule: "import-meta-path",
    reason:
      "Derives the package dir only as the SOURCE-run devPath of cdp-server.ts for " +
      'selfSpawn().script("ma-chrome-cdp/cdp-server", ...). Compiled, the helper ignores ' +
      "it and spawns `<binary> __run`. No file is read from it.",
  },
  {
    file: "ma-computer-use-plugin/bin/cud.ts",
    rule: "import-meta-path",
    reason:
      "macOS developer tool (xcodegen/xcodebuild of the helper app), never a runtime path. " +
      "W2 section 5 leaves it as is.",
  },
  {
    file: "ma-security-plugin/src/test-support.ts",
    rule: "import-meta-path",
    reason: "Test support module, imported by tests only.",
  },
  {
    file: "ma-llm-openai-plugin/openai.test-helpers.ts",
    rule: "import-meta-path",
    reason: "Test helper reading __fixtures__, imported by tests only.",
  },
  {
    file: "ma-llm-cursor-plugin/scripts/generate-static-catalog.ts",
    rule: "import-meta-path",
    reason: "Developer script run from the checkout, not part of the plugin runtime.",
  },
  {
    file: "ma-llm-cursor-plugin/scripts/probe-carry.ts",
    rule: "import-meta-path",
    reason: "Developer probe run from the checkout, not part of the plugin runtime.",
  },
  {
    file: "ma-llm-cursor-plugin/scripts/probe-run-encode.ts",
    rule: "import-meta-path",
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
