/**
 * Project tool detection — "use whatever the project already has".
 *
 * We NEVER install anything. We probe the project root for tools that are
 * already present: a binary in `node_modules/.bin` (or an ancestor's, for
 * hoisted workspaces) or on `PATH`, and check for known config files that
 * signal the tool is configured for the project.
 *
 * Config root vs install root are deliberately separate:
 * - `root` passed to {@link detectTools} is the **configRoot** (nearest
 *   tsconfig/biome/… for the file being edited).
 * - Binaries may live higher up (`resolveBinUp`) when package managers hoist
 *   `node_modules` to a workspace root. Providers still run with
 *   `cwd = configRoot` so project config applies.
 *
 * Pure + synchronous: detection is a function of the filesystem at `root`, with
 * no spawning, so it unit-tests against temp fixtures. The returned
 * {@link DetectedTool}s are inert descriptors; the runner decides what to spawn.
 *
 * @module plugins/diagnostics/lib/detect
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

/** What kind of signal a detected tool produces. */
export type ToolKind = "type" | "lint" | "format" | "apple"

/** An inert descriptor of a tool found in the project. */
export interface DetectedTool {
  /** Stable id: `"tsgo"`, `"biome"`, `"oxlint"`, `"sourcekit-lsp"`, ... */
  id: string
  kind: ToolKind
  /** Absolute path to the resolved binary. */
  bin: string
  /**
   * Directory that owns the `node_modules/.bin` entry the binary came from
   * (may be an ancestor of the config root when deps are hoisted). Undefined
   * for PATH-resolved tools.
   */
  binRoot?: string
  /**
   * Project directory whose config applies for this tool (LSP rootUri / spawn cwd).
   * May differ per tool for the same file (e.g. package tsconfig + workspace biome.json).
   * Set by {@link detectTools} / {@link detectToolsForFile}.
   */
  configRoot?: string
  /** True when a config file or devDependency named this tool (a strong signal). */
  configFound: boolean
  /** True for tools we run as a long-lived LSP server (tsgo) vs spawn-per-call. */
  persistent: boolean
}

/** One entry in the detection registry: how to recognize a given tool. */
interface ToolSpec {
  id: string
  kind: ToolKind
  /** Binary name under `node_modules/.bin` (or on PATH when `fromPath` is true). */
  binName: string
  /** Config files that signal the tool is configured for this project. */
  configFiles: string[]
  /** Tool ids that, if already detected, suppress this tool. Higher-priority first. */
  suppressedBy?: string[]
  /** package.json dependency names that signal the tool. */
  depNames: string[]
  /** When true, the tool is unusable without one of `requiresAnyOf` present. */
  requiresConfig: boolean
  /** Files (or globs like "*.xcodeproj") that must exist for the tool to have anything to check. */
  requiresAnyOf?: string[]
  persistent: boolean
  /** When true, resolve the binary from PATH instead of node_modules/.bin. */
  fromPath?: boolean
}

/**
 * The detection registry. Adding a new tool (prettier, eslint, pyright,
 * rust-analyzer, ...) is a single entry here : the Strategy/Adapter layers key
 * off `id`. Ordered type → lint → format → apple so reports read in that priority.
 */
const REGISTRY: ToolSpec[] = [
  {
    // Legacy `tsgo` binary from the `@typescript/native-preview` package (the
    // TypeScript 7 preview before GA). Kept for back-compat with projects that
    // still pin native-preview. As of TypeScript 7 GA the native LSP moved into
    // the `tsc` binary (see the `tsc` entry below), so on a modern install this
    // binary is absent and the `tsc` entry provides the persistent LSP instead.
    id: "tsgo",
    kind: "type",
    binName: "tsgo",
    configFiles: ["tsconfig.json", "jsconfig.json"],
    depNames: ["@typescript/native-preview"],
    requiresConfig: true,
    requiresAnyOf: ["tsconfig.json", "jsconfig.json"],
    persistent: true,
  },
  {
    // The stable `tsc` binary. As of TypeScript 7 (GA 2026-07-08) `tsc` IS the
    // native Go compiler and speaks LSP over `tsc --lsp -stdio` (verified: it
    // answers an `initialize` handshake, whereas TS<=6 rejects `--lsp` with
    // TS5023). So on TS>=7 we run it as a PERSISTENT LSP server (fast per-edit
    // pulls); on TS<=6 it stays a spawn-per-call `tsc --noEmit` fallback. The
    // `persistent` flag here is the TS<=6 default; detectTools() promotes it to
    // true when the installed TypeScript major version is >= 7.
    id: "tsc",
    kind: "type",
    binName: "tsc",
    configFiles: ["tsconfig.json", "jsconfig.json"],
    suppressedBy: ["tsgo"],
    depNames: ["typescript"],
    requiresConfig: true,
    requiresAnyOf: ["tsconfig.json", "jsconfig.json"],
    persistent: false,
  },
  {
    id: "oxlint",
    kind: "lint",
    binName: "oxlint",
    configFiles: [".oxlintrc.json", "oxlint.json", ".oxlintrc"],
    depNames: ["oxlint"],
    requiresConfig: false,
    persistent: false,
  },
  {
    id: "biome",
    kind: "format",
    binName: "biome",
    configFiles: ["biome.json", "biome.jsonc"],
    depNames: ["@biomejs/biome"],
    requiresConfig: false,
    persistent: false,
  },
  {
    // Prettier. Only activates when the project CONFIGURED it (a prettier
    // config file exists): running tool defaults on an unconfigured project
    // would invent formatting rules the project never chose.
    id: "prettier",
    kind: "format",
    binName: "prettier",
    configFiles: [
      ".prettierrc",
      ".prettierrc.json",
      ".prettierrc.jsonc",
      ".prettierrc.yaml",
      ".prettierrc.yml",
      ".prettierrc.toml",
      ".prettierrc.js",
      ".prettierrc.cjs",
      ".prettierrc.mjs",
      ".prettierrc.tml",
      "prettier.config.js",
      "prettier.config.cjs",
      "prettier.config.mjs",
      "prettier.config.ts",
    ],
    depNames: ["prettier"],
    requiresConfig: true,
    // Biome owns format when its config is present; skip prettier entirely.
    suppressedBy: ["biome"],
    persistent: false,
  },
  {
    // ESLint (flat config era). Coexists with oxlint: they check different
    // rule sets, so neither suppresses the other.
    id: "eslint",
    kind: "lint",
    binName: "eslint",
    configFiles: [
      "eslint.config.js",
      "eslint.config.mjs",
      "eslint.config.cjs",
      "eslint.config.ts",
      ".eslintrc",
      ".eslintrc.json",
      ".eslintrc.js",
      ".eslintrc.cjs",
      ".eslintrc.yml",
      ".eslintrc.yaml",
    ],
    depNames: ["eslint"],
    requiresConfig: true,
    persistent: false,
  },
  {
    id: "sourcekit-lsp",
    kind: "apple",
    binName: "sourcekit-lsp",
    configFiles: ["Package.swift"],
    depNames: [],
    requiresConfig: false,
    persistent: true,
    fromPath: true,
  },
]

/** Read package.json dependency maps, tolerant of a missing/malformed file. */
function readDeps(root: string): Record<string, string> {
  const pkgPath = join(root, "package.json")
  if (!existsSync(pkgPath)) return {}
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
      const map = pkg[key]
      if (map && typeof map === "object") {
        for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
          if (typeof v === "string") out[k] = v
        }
      }
    }
    return out
  } catch {
    // Malformed package.json: behave as if there were no deps (binary probe
    // still applies). Never throw into detection.
    return {}
  }
}

/**
 * Walk ancestors of `startDir` looking for `node_modules/.bin/<binName>`.
 * Supports hoisted workspaces where the package has config (tsconfig, biome)
 * but binaries live at the workspace root.
 *
 * Returns the absolute binary path, or null when nothing is found within
 * `maxDepth` steps (or the filesystem root).
 */
export function resolveBinUp(binName: string, startDir: string, maxDepth = 12): string | null {
  let dir = startDir
  for (let depth = 0; depth < maxDepth; depth++) {
    const candidate = join(dir, "node_modules", ".bin", binName)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Directory that owns a `node_modules/.bin/<name>` path (the install root),
 * or undefined when the path does not look like one.
 */
function binRootFromBinPath(bin: string): string | undefined {
  // .../node_modules/.bin/<name> → ...
  const binDir = dirname(bin)
  const norm = binDir.replace(/\\/g, "/")
  if (!norm.endsWith("node_modules/.bin")) return undefined
  return dirname(dirname(binDir))
}

/**
 * Read the MAJOR version of the `typescript` package installed at `root` or an
 * ancestor (from `node_modules/typescript/package.json`). Returns null when it
 * can't be read (not installed, malformed, unreadable). Used to decide whether
 * the `tsc` binary is LSP-capable: on TypeScript 7 and later, `tsc` speaks
 * `--lsp -stdio` so it runs as a persistent server; on TypeScript 6 and earlier
 * it does not, and stays spawn-per-call.
 *
 * Walks up so hoisted installs (workspace root `node_modules/typescript`) still
 * promote `tsc` correctly when the config root is a nested package.
 */
function readTypescriptMajor(root: string, maxDepth = 12): number | null {
  let dir = root
  for (let depth = 0; depth < maxDepth; depth++) {
    try {
      const pkgPath = join(dir, "node_modules", "typescript", "package.json")
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown }
        if (typeof pkg.version === "string") {
          const major = Number.parseInt(pkg.version.split(".")[0] ?? "", 10)
          if (!Number.isNaN(major)) return major
        }
        // Malformed package at this level: keep walking for a hoisted install.
      }
    } catch {
      // Unreadable intermediate node_modules: keep walking.
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** Injectable options for detection (used in tests to control PATH). */
export interface DetectOptions {
  /** PATH to use when resolving PATH-based tools. Defaults to `process.env.PATH`. */
  path?: string
  /**
   * Override the detected TypeScript major version (skips reading
   * `node_modules/typescript/package.json`). Used in tests to exercise the
   * TS7-tsc-as-LSP promotion without a real install.
   */
  typescriptMajor?: number | null
}

/**
 * Resolve a binary name from a PATH string. Returns the first match or null.
 */
function resolveFromPath(binName: string, pathEnv?: string): string | null {
  const paths = (pathEnv ?? process.env.PATH ?? "").split(":")
  for (const dir of paths) {
    if (!dir) continue
    const candidate = join(dir, binName)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Check whether at least one pattern in `patterns` matches an entry in `root`.
 * Supports simple `*` globs (e.g. `"*.xcodeproj"`).
 */
function anyPatternMatches(root: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (!pattern.includes("*")) {
      if (existsSync(join(root, pattern))) return true
    } else {
      // Simple wildcard: convert to regex and test against directory entries
      const re = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`)
      try {
        const entries = readdirSync(root)
        if (entries.some((e) => re.test(e))) return true
      } catch {
        // Can't read directory — skip this pattern
      }
    }
  }
  return false
}

/**
 * Known project signals used for walking up from a file to find
 * the project root. Independent of tool detection gating: even if a
 * tool doesn't require these signals to activate, the root finder
 * still looks for them to locate the project boundary.
 */
const PROJECT_SIGNALS = [
  "Package.swift",
  "*.xcodeproj",
  "*.xcworkspace",
  "tsconfig.json",
  "jsconfig.json",
  "biome.json",
  "biome.jsonc",
  ".oxlintrc.json",
  "oxlint.json",
  ".prettierrc",
  "prettier.config.js",
  "eslint.config.js",
  "eslint.config.mjs",
]

/** TypeScript / JS project signals (type providers). */
export const TYPE_CONFIG_SIGNALS = ["tsconfig.json", "jsconfig.json"] as const
/** Biome config signals (format provider). */
export const FORMAT_CONFIG_SIGNALS = [
  "biome.json",
  "biome.jsonc",
  // Prettier configs (only count when the file is actually configured).
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.jsonc",
  ".prettierrc.yaml",
  ".prettierrc.yml",
  ".prettierrc.toml",
  "prettier.config.js",
  "prettier.config.cjs",
  "prettier.config.mjs",
  "prettier.config.ts",
] as const
/** Oxlint + ESLint config signals (lint providers). */
export const LINT_CONFIG_SIGNALS = [
  ".oxlintrc.json",
  "oxlint.json",
  ".oxlintrc",
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  ".eslintrc",
  ".eslintrc.json",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.yml",
  ".eslintrc.yaml",
] as const
/** Apple / Xcode project signals. */
export const APPLE_CONFIG_SIGNALS = ["Package.swift", "*.xcodeproj", "*.xcworkspace"] as const

/**
 * Walk up from a file's directory looking for any of `signals`.
 * Stops at the first matching ancestor (or maxDepth / filesystem root).
 *
 * Per-tool config roots use this with tool-specific signal lists so a
 * package-local `tsconfig.json` does not claim the biome/oxlint root.
 */
export function findConfigRoot(
  filePath: string,
  signals: readonly string[],
  maxDepth = 10,
): string | null {
  let dir = dirname(filePath)
  let depth = 0
  while (depth < maxDepth) {
    for (const signal of signals) {
      if (!signal.includes("*")) {
        if (existsSync(join(dir, signal))) return dir
      } else {
        try {
          const entries = readdirSync(dir)
          if (entries.some((e) => e.endsWith(signal.slice(1)))) return dir
        } catch {
          // Can't read directory — skip
        }
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
    depth++
  }
  return null
}

/**
 * Walk up from a file's directory looking for a project root.
 * Checks known project signals at each ancestor directory.
 * Stops at the first match or when max depth is reached.
 *
 * Returns the first ancestor directory that contains any known
 * project signal, or null when none is found within maxDepth steps.
 *
 * Prefer {@link findConfigRoot} / {@link detectToolsForFile} when tool-specific
 * roots matter (Phase 2+).
 */
export function findProjectRoot(filePath: string, maxDepth = 10): string | null {
  return findConfigRoot(filePath, PROJECT_SIGNALS, maxDepth)
}

/**
 * Walk up from a file's directory looking for an Apple/Xcode project root.
 */
export function findAppleProjectRoot(filePath: string): string | null {
  return findConfigRoot(filePath, APPLE_CONFIG_SIGNALS)
}

/**
 * Detect the diagnostic tools available in the project at `root` (the
 * **configRoot**). Returns an ordered list of {@link DetectedTool} descriptors
 * (type, then lint, then format). Empty when nothing is installed.
 *
 * Binaries are resolved with {@link resolveBinUp}: first `root/node_modules/.bin`,
 * then ancestor directories. That is required for hoisted monorepos where a
 * package has its own `tsconfig.json` but `tsc`/`biome` live at the workspace
 * root. Config / `requiresAnyOf` signals still must exist at `root` itself so a
 * bare ancestor bin without a local project does not activate tools.
 *
 * When `options.fallback` is true, PATH-based tools are included even when
 * their required project signals are absent. This is useful for ad-hoc files
 * outside any project tree — the LSP server may still provide value (basic
 * syntax checking) even without full project context.
 *
 * Pass `options.path` to control PATH resolution for `fromPath` tools (used
 * in tests). Defaults to `process.env.PATH`.
 */
export function detectTools(
  root: string,
  options: DetectOptions & { fallback?: boolean } = {},
): DetectedTool[] {
  const deps = readDeps(root)
  const tsMajor =
    options.typescriptMajor !== undefined ? options.typescriptMajor : readTypescriptMajor(root)
  const out: DetectedTool[] = []
  const detectedIds = new Set<string>()
  for (const spec of REGISTRY) {
    // Dedup: skip if any suppressing tool was already detected.
    if (spec.suppressedBy?.some((id) => detectedIds.has(id))) continue

    let bin: string | null
    let binRoot: string | undefined
    if (spec.fromPath) {
      bin = resolveFromPath(spec.binName, options.path)
    } else {
      bin = resolveBinUp(spec.binName, root)
      if (bin) binRoot = binRootFromBinPath(bin)
    }
    if (bin === null) continue

    const hasConfigFile = spec.configFiles.some((f) => existsSync(join(root, f)))
    const hasDep = spec.depNames.some((d) => d in deps)
    const configFound = hasConfigFile || hasDep

    // A tool that requires config is skipped when none of its requiresAnyOf
    // files (or wildcard patterns) are present. In fallback mode, PATH-based
    // tools skip this check: they may provide value even without project context.
    const skipSignalCheck = spec.fromPath && options.fallback
    if (!skipSignalCheck && spec.requiresAnyOf && !anyPatternMatches(root, spec.requiresAnyOf)) {
      continue
    }
    if (spec.requiresConfig && !configFound) continue

    // TypeScript 7+ `tsc` speaks LSP (`tsc --lsp -stdio`), so promote it to a
    // persistent server. On TS <= 6 (or unknown), it stays spawn-per-call.
    const persistent =
      spec.id === "tsc" && tsMajor !== null && tsMajor >= 7 ? true : spec.persistent

    detectedIds.add(spec.id)
    out.push({
      id: spec.id,
      kind: spec.kind,
      bin,
      ...(binRoot !== undefined ? { binRoot } : {}),
      configRoot: root,
      configFound,
      persistent,
    })
  }
  return out
}

/**
 * Detect tools for a specific file using **per-tool** config roots.
 *
 * Type / format / lint / apple each walk up for their own signals, so a
 * package-local `tsconfig.json` does not force biome/oxlint to use that
 * directory as cwd when `biome.json` lives at the workspace root (and vice
 * versa). Binaries still resolve via {@link resolveBinUp} from each tool's
 * config root.
 *
 * Falls back to `options.fallbackRoot` (typically agent cwd) only when no
 * tool-specific root is found for a PATH-based tool that can run without
 * project context (sourcekit-lsp).
 */
export function detectToolsForFile(
  filePath: string,
  options: DetectOptions & { fallback?: boolean; fallbackRoot?: string } = {},
): DetectedTool[] {
  const typeRoot = findConfigRoot(filePath, TYPE_CONFIG_SIGNALS)
  const formatRoot = findConfigRoot(filePath, FORMAT_CONFIG_SIGNALS)
  const lintRoot = findConfigRoot(filePath, LINT_CONFIG_SIGNALS)
  const appleRoot = findConfigRoot(filePath, APPLE_CONFIG_SIGNALS)

  const out: DetectedTool[] = []
  const seen = new Set<string>()

  const take = (
    root: string | null,
    kind: ToolKind,
    extra?: DetectOptions & { fallback?: boolean },
  ) => {
    if (!root) return
    for (const t of detectTools(root, { ...options, ...extra })) {
      if (t.kind !== kind) continue
      if (seen.has(t.id)) continue
      seen.add(t.id)
      out.push({ ...t, configRoot: root })
    }
  }

  take(typeRoot, "type")
  take(formatRoot, "format")
  take(lintRoot, "lint")
  take(appleRoot, "apple")

  // sourcekit-lsp can still help without a project signal (basic syntax).
  if (!seen.has("sourcekit-lsp")) {
    const fallbackRoot = options.fallbackRoot ?? typeRoot ?? formatRoot ?? dirname(filePath)
    for (const t of detectTools(fallbackRoot, { ...options, fallback: true })) {
      if (t.id !== "sourcekit-lsp") continue
      out.push({ ...t, configRoot: appleRoot ?? fallbackRoot })
      break
    }
  }

  // Preserve registry order: type → lint → format → apple.
  const order = new Map(REGISTRY.map((s, i) => [s.id, i]))
  out.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99))
  return out
}
