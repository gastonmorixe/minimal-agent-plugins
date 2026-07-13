/**
 * Resolve whether a file is covered by the nearest TypeScript project.
 *
 * Used by type providers' {@link DiagnosticProvider.inScope} so the
 * out-of-scope `tsc --ignoreConfig` fallback only runs for files that
 * really are outside a tsconfig. Without this, clean in-project files
 * fall through to ad-hoc checks that ignore `paths`/`baseUrl` and emit
 * false TS2307s on path aliases like `@/…`.
 *
 * Implementation notes:
 * - Prefer the project's own `typescript` package **when it still exposes**
 *   the classic `findConfigFile` / `parseJsonConfigFileContent` API (TS ≤ 6).
 * - TypeScript 7 ships a different public surface (`typescript/unstable/*`)
 *   without those helpers, so we fall back to a lightweight include/exclude
 *   match against the nearest `tsconfig.json`. That is enough to gate the
 *   ad-hoc path; it does not need to be a full project program.
 * - If nothing can be resolved, assume **in-scope** (skip noisy ad-hoc).
 *
 * @module plugins/diagnostics/lib/tsconfig-scope
 */
import { existsSync, readFileSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path"

/** Minimal surface of the classic (TS ≤ 6) TypeScript package we touch. */
interface ClassicTsModule {
  sys: {
    readFile(path: string): string | undefined
    fileExists(path: string): boolean
    readDirectory?(
      path: string,
      extensions?: readonly string[],
      exclude?: readonly string[],
      include?: readonly string[],
      depth?: number,
    ): string[]
    directoryExists?(path: string): boolean
    getCurrentDirectory?(): string
    getDirectories?(path: string): string[]
    realpath?(path: string): string
  }
  findConfigFile(
    searchPath: string,
    fileExists: (path: string) => boolean,
    configName?: string,
  ): string | undefined
  readConfigFile(
    fileName: string,
    readFile: (path: string) => string | undefined,
  ): { config?: unknown; error?: unknown }
  parseJsonConfigFileContent(
    json: unknown,
    host: {
      useCaseSensitiveFileNames: boolean
      readDirectory: (
        path: string,
        extensions?: readonly string[],
        exclude?: readonly string[],
        include?: readonly string[],
        depth?: number,
      ) => string[]
      fileExists: (path: string) => boolean
      readFile: (path: string) => string | undefined
      directoryExists?: (path: string) => boolean
      getCurrentDirectory?: () => string
      getDirectories?: (path: string) => string[]
      realpath?: (path: string) => string
    },
    basePath: string,
    existingOptions?: unknown,
    configFileName?: string,
  ): { fileNames: string[]; errors: unknown[] }
}

const classicTsCache = new Map<string, ClassicTsModule | null>()
/** configPath → normalized absolute fileNames (classic API only). */
const projectFilesCache = new Map<string, Set<string> | null>()
/** configPath → lightweight include/exclude matcher. */
const lightweightCache = new Map<string, LightweightProject | null>()

interface LightweightProject {
  baseDir: string
  include: string[]
  exclude: string[]
}

function normalizePath(p: string): string {
  return normalize(resolve(p)).split(sep).join("/")
}

function tryLoadClassicTypescript(from: string): ClassicTsModule | null {
  try {
    const require = createRequire(join(from, "package.json"))
    const ts = require("typescript") as Partial<ClassicTsModule>
    if (
      typeof ts.findConfigFile === "function" &&
      typeof ts.readConfigFile === "function" &&
      typeof ts.parseJsonConfigFileContent === "function" &&
      ts.sys &&
      typeof ts.sys.fileExists === "function"
    ) {
      return ts as ClassicTsModule
    }
    return null
  } catch {
    return null
  }
}

function loadClassicTypescript(root: string): ClassicTsModule | null {
  const hit = classicTsCache.get(root)
  if (hit !== undefined) return hit

  // Project-local typescript first (many apps still pin TS ≤ 6 with classic API).
  let ts = tryLoadClassicTypescript(root)
  if (!ts) {
    // Plugin workspace may be on TS 7 (no classic API) — try anyway.
    try {
      const require = createRequire(import.meta.url)
      const resolved = require.resolve("typescript/package.json")
      ts = tryLoadClassicTypescript(dirname(resolved))
    } catch {
      ts = null
    }
  }
  classicTsCache.set(root, ts)
  return ts
}

function loadClassicProjectFiles(ts: ClassicTsModule, configPath: string): Set<string> | null {
  const cached = projectFilesCache.get(configPath)
  if (cached !== undefined) return cached

  try {
    const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile)
    if (error || config == null) {
      projectFilesCache.set(configPath, null)
      return null
    }
    const basePath = dirname(configPath)
    const host = {
      useCaseSensitiveFileNames: process.platform !== "win32",
      readDirectory: (
        path: string,
        extensions?: readonly string[],
        exclude?: readonly string[],
        include?: readonly string[],
        depth?: number,
      ) => ts.sys.readDirectory?.(path, extensions, exclude, include, depth) ?? [],
      fileExists: (p: string) => ts.sys.fileExists(p),
      readFile: (p: string) => ts.sys.readFile(p),
      directoryExists: ts.sys.directoryExists?.bind(ts.sys),
      getCurrentDirectory: ts.sys.getCurrentDirectory?.bind(ts.sys),
      getDirectories: ts.sys.getDirectories?.bind(ts.sys),
      realpath: ts.sys.realpath?.bind(ts.sys),
    }
    const parsed = ts.parseJsonConfigFileContent(config, host, basePath, undefined, configPath)
    const files = new Set(parsed.fileNames.map(normalizePath))
    projectFilesCache.set(configPath, files)
    return files
  } catch {
    projectFilesCache.set(configPath, null)
    return null
  }
}

/** Walk parents from `startDir` up to (and including) `root` for tsconfig.json. */
function findTsconfigUp(startDir: string, root: string): string | null {
  const rootAbs = resolve(root)
  let dir = resolve(startDir)
  for (;;) {
    const candidate = join(dir, "tsconfig.json")
    if (existsSync(candidate)) {
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        /* ignore */
      }
    }
    if (dir === rootAbs) break
    const parent = dirname(dir)
    if (parent === dir) break
    // Don't walk above workspace root.
    const rel = relative(rootAbs, parent)
    if (rel.startsWith("..")) break
    dir = parent
  }
  return null
}

/** Strip // and /* comments from a tsconfig-ish JSONC string (good enough). */
function stripJsonc(raw: string): string {
  let out = ""
  let i = 0
  let inStr = false
  let quote = ""
  let escape = false
  while (i < raw.length) {
    const c = raw[i]
    if (inStr) {
      out += c
      if (escape) escape = false
      else if (c === "\\") escape = true
      else if (c === quote) inStr = false
      i++
      continue
    }
    if (c === '"' || c === "'") {
      inStr = true
      quote = c
      out += c
      i++
      continue
    }
    if (c === "/" && raw[i + 1] === "/") {
      i += 2
      while (i < raw.length && raw[i] !== "\n") i++
      continue
    }
    if (c === "/" && raw[i + 1] === "*") {
      i += 2
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  // trailing commas before } or ]
  return out.replace(/,\s*([}\]])/g, "$1")
}

function parseTsconfigLite(configPath: string): LightweightProject | null {
  const cached = lightweightCache.get(configPath)
  if (cached !== undefined) return cached
  try {
    const raw = readFileSync(configPath, "utf8")
    const json = JSON.parse(stripJsonc(raw)) as {
      include?: string[]
      exclude?: string[]
      files?: string[]
      compilerOptions?: { rootDir?: string }
    }
    const baseDir = dirname(configPath)
    // When `files` is set without include, only those files are in the program.
    // We treat explicit files[] as additional includes of exact paths.
    const include =
      json.include && json.include.length > 0
        ? json.include
        : json.files && json.files.length > 0
          ? json.files
          : ["**/*"]
    const exclude =
      json.exclude && json.exclude.length > 0
        ? json.exclude
        : ["node_modules", "bower_components", "jspm_packages", "dist", "out", "build"]
    const project: LightweightProject = { baseDir, include, exclude }
    lightweightCache.set(configPath, project)
    return project
  } catch {
    lightweightCache.set(configPath, null)
    return null
  }
}

/**
 * Convert a tsconfig glob (relative to baseDir) into a RegExp matching a
 * posix-normalized path relative to baseDir.
 *
 * Supports `*`, `**`, `?`, and trailing directory patterns like `src` (→ `src/**`).
 */
function globToRegExp(pattern: string): RegExp {
  let pat = pattern.replace(/\\/g, "/")
  // Bare directory name without glob → match that tree.
  if (!pat.includes("*") && !pat.includes("?") && !pat.includes(".")) {
    // Could still be a file without extension; if it has no slash and looks like a dir pattern
    // tsconfig treats non-glob include entries as directories (include all under them).
    if (!pat.endsWith("/")) pat = `${pat}/**/*`
    else pat = `${pat}**/*`
  }
  // Patterns without ** that don't start with **/ still match from base.
  let re = "^"
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i]
    if (c === "*") {
      if (pat[i + 1] === "*") {
        // ** or **/
        if (pat[i + 2] === "/") {
          re += "(?:.*/)?"
          i += 2
        } else {
          re += ".*"
          i += 1
        }
      } else {
        re += "[^/]*"
      }
    } else if (c === "?") {
      re += "[^/]"
    } else if ("+|(){}^$[]".includes(c)) {
      re += `\\${c}`
    } else if (c === ".") {
      re += "\\."
    } else {
      re += c
    }
  }
  re += "$"
  return new RegExp(re)
}

function matchAny(globs: string[], relPosix: string): boolean {
  for (const g of globs) {
    if (globToRegExp(g).test(relPosix)) return true
    // Also allow matching when pattern is a prefix directory already handled by globToRegExp
  }
  return false
}

function lightweightInScope(configPath: string, absFile: string): boolean | null {
  const project = parseTsconfigLite(configPath)
  if (!project) return null
  const rel = relative(project.baseDir, absFile)
  if (rel.startsWith("..") || rel === "") return false
  const relPosix = rel.split(sep).join("/")

  // Default exclude node_modules etc.
  if (matchAny(project.exclude, relPosix)) return false
  // Common: exclude also matches path segments (node_modules anywhere)
  if (relPosix.split("/").includes("node_modules")) return false

  return matchAny(project.include, relPosix)
}

/**
 * True when `filePath` is part of a TypeScript project rooted under `root`.
 * Returns `true` when we cannot decide (assume in-scope so the ad-hoc
 * fallback does not invent path-alias errors).
 */
export function isPathInTsconfigScope(root: string, filePath: string): boolean {
  const abs = isAbsolute(filePath) ? filePath : resolve(root, filePath)
  const absNorm = normalizePath(abs)
  const rootAbs = resolve(root)

  const relToRoot = relative(rootAbs, abs)
  if (relToRoot.startsWith("..")) return false

  // Classic API path (TS ≤ 6 in the target project).
  const ts = loadClassicTypescript(root)
  if (ts) {
    const searchStart = dirname(abs)
    let configPath =
      ts.findConfigFile(searchStart, (p) => ts.sys.fileExists(p), "tsconfig.json") ?? undefined
    if (!configPath) {
      const rootConfig = join(root, "tsconfig.json")
      if (ts.sys.fileExists(rootConfig)) configPath = rootConfig
    }
    if (!configPath) return false
    const cfgRel = relative(rootAbs, configPath)
    if (cfgRel.startsWith("..")) return false
    const files = loadClassicProjectFiles(ts, configPath)
    if (files) return files.has(absNorm)
    // Classic parse failed → lightweight below.
  }

  // Lightweight include/exclude (TS 7 / no classic API / classic parse failed).
  const configPath =
    findTsconfigUp(dirname(abs), root) ??
    (existsSync(join(root, "tsconfig.json")) ? join(root, "tsconfig.json") : null)
  if (!configPath) return false
  const cfgRel = relative(rootAbs, configPath)
  if (cfgRel.startsWith("..")) return false

  const lite = lightweightInScope(configPath, abs)
  if (lite === null) return true // unreadable config → quiet
  return lite
}

/** Test helper: drop caches between fixtures. */
export function resetTsconfigScopeCache(): void {
  classicTsCache.clear()
  projectFilesCache.clear()
  lightweightCache.clear()
}
