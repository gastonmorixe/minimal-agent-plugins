/**
 * Collect every model-facing text surface in the plugins repo and in core.
 *
 * A surface is one named string with a file, a locator and its text:
 *
 * - `ma-*-plugin/PROMPT.md` (whole file)
 * - `ma-*-plugin/prompts/**.md` (whole file, template vars kept)
 * - `ma-*-plugin/manifest.json` `description` values
 * - inline `systemPrompt:` / `description:` TS literals
 * - a small set of core TS files that still hold model text
 *
 * The scanner is deterministic and read-only. `ste-check.ts` and the tests
 * both use it, so the gate and the ratchet cannot disagree.
 *
 * @module tests/ste/surfaces
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, join, relative, resolve } from "node:path"

import { collectInlineTsStrings } from "../../scripts/prompt-inventory.ts"

/** One model-facing string. */
export interface Surface {
  /** Repo-relative path (from the plugins root). */
  file: string
  /** Where the text sits in that file. */
  locator: string
  /** The raw text. */
  text: string
  /** 1-based line where the text starts, for findings. */
  line: number
  /** Surface family, for grouping in a report. */
  kind: "prompt-md" | "prompts-md" | "manifest" | "inline-ts" | "core-ts"
}

/** Default plugins root: two levels up from this file. */
export const PLUGINS_ROOT = resolve(import.meta.dir, "..", "..")

/** A sibling checkout of core is found next to the plugins root. */
export const CORE_ROOT = resolve(PLUGINS_ROOT, "..", "minimal-agent-core")

const SKIP_DIRS = new Set(["node_modules", "tmp", ".tmp", "dist", "build", "goldens"])

/**
 * Inline TS surfaces that reach a human, not the model. Each entry needs a
 * reason. `beta-flags-catalog.ts` feeds the `--list-flags` CLI listing only.
 */
const NOT_MODEL_FACING = new Set(["ma-llm-anthropic-plugin/beta-flags-catalog.ts"])

/** Walk a tree and return file paths, skipping scratch and dependency folders. */
function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue
    const abs = join(dir, entry)
    const stat = statSync(abs)
    if (stat.isDirectory()) out.push(...walk(abs))
    else if (stat.isFile()) out.push(abs)
  }
  return out
}

/** Plugin directories, in a stable order. */
function pluginDirs(root: string): string[] {
  return readdirSync(root)
    .filter((name) => name.startsWith("ma-") && statSync(join(root, name)).isDirectory())
    .sort()
}

/** Collect recursive `description` values of a JSON manifest. */
function manifestDescriptions(
  node: unknown,
  path: string,
  out: Array<{ locator: string; text: string }>,
): void {
  if (node === null || typeof node !== "object") return
  if (Array.isArray(node)) {
    node.forEach((value, index) => manifestDescriptions(value, `${path}[${index}]`, out))
    return
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const child = path ? `${path}.${key}` : key
    if (key === "description" && typeof value === "string") {
      out.push({ locator: child, text: value })
    } else {
      manifestDescriptions(value, child, out)
    }
  }
}

/**
 * Decode the escapes of a JS string literal body.
 *
 * The extractors used to decode only the newline, quote and apostrophe
 * escapes. That left a `\u200b` escape as six
 * ASCII characters, so a hidden character in a TS literal passed the character
 * allowlist AND hid a banned word from the word rules. The model receives the
 * real character at runtime, so the audit must see it too.
 *
 * @param body - The text between the quotes, with its backslashes.
 * @returns The text a reader of the file would see at runtime.
 */
/**
 * Normalize a checkout to the bytes the model receives.
 *
 * A Windows checkout with `core.autocrlf` has `\r` on every line, and `\r` is
 * not on the character allowlist, so every line would fail. The model never
 * receives that `\r`, so it is removed here, once, at the edge.
 *
 * @param text - Raw file content.
 * @returns Content with CRLF and a lone CR normalized to LF.
 */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

/**
 * Decode the escapes of a JS string literal body.
 *
 * The extractors used to decode only the newline, quote and apostrophe
 * escapes. That left a `\u200b` escape as six ASCII characters, so a hidden
 * character in a TS literal passed the character allowlist AND hid a banned
 * word from the word rules. The model receives the real character at runtime,
 * so the audit must see it too.
 *
 * @param body - The text between the quotes, with its backslashes.
 * @returns The text a reader of the file would see at runtime.
 */
export function decodeJsEscapes(body: string): string {
  return body
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, hex: string) =>
      safeFromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
      safeFromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) =>
      safeFromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\b/g, "\b")
    .replace(/\\f/g, "\f")
    .replace(/\\v/g, "\v")
    .replace(/\\0/g, "\0")
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
}

/** Code point to text, with a visible fallback for an out-of-range value. */
function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "\uFFFD"
  return String.fromCodePoint(code)
}

/** Line of `needle` in `text`, 1-based. */
function lineOf(text: string, needle: string): number {
  const index = text.indexOf(needle)
  if (index < 0) return 1
  return text.slice(0, index).split("\n").length
}

/**
 * Every quoted string literal in a TS file that reads as prose. Used for core
 * files that hold model text in a constant array, not in a `description:` key.
 *
 * Strings inside a comment or a type annotation are not model text, so they
 * are skipped. A model never receives a comment.
 *
 * @param source - TS source text.
 * @returns Each prose literal with its 1-based line.
 */
export function proseLiterals(source: string): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = []
  const re = /"((?:[^"\\\n]|\\.){20,})"|'((?:[^'\\\n]|\\.){20,})'/g
  for (const match of source.matchAll(re)) {
    const value = decodeJsEscapes(match[1] ?? match[2] ?? "")
    if (!/[A-Za-z]/.test(value) || !/\s/.test(value)) continue
    // Skip import paths, module ids and regex source.
    if (/^[\w./@$-]+$/.test(value)) continue
    if (/\\b|\\s|^\^/.test(value)) continue
    // Skip code, not prose: a type guard, a selector, an operator chain.
    if (/=>|===|!==|\{\s*$|^\s*;|\btype:\s/.test(value)) continue
    if (!/[a-z] [a-z]/i.test(value)) continue
    const index = match.index ?? 0
    if (inCommentOrType(source, index)) continue
    out.push({ text: value, line: source.slice(0, index).split("\n").length })
  }
  return out
}

/** True when `index` sits inside a `//` comment, a block comment or a type literal. */
function inCommentOrType(source: string, index: number): boolean {
  const before = source.slice(0, index)
  const lineStart = before.lastIndexOf("\n") + 1
  const linePrefix = before.slice(lineStart)
  if (linePrefix.includes("//")) return true
  if (!linePrefix.includes("/*")) {
    const openBlock = before.lastIndexOf("/*")
    const closeBlock = before.lastIndexOf("*/")
    if (openBlock > closeBlock) return true
  }
  // A string inside a type annotation, for example `{ type: "text"; text: string }`.
  if (/:\s*$/.test(linePrefix) && /[<>|&{}]\s*$/.test(before.slice(lineStart - 40, lineStart))) {
    return true
  }
  return false
}

/**
 * Collect the manifest, markdown and inline TS surfaces of one plugin folder.
 *
 * @param root - Plugins repo root.
 * @param plugin - Plugin directory name.
 * @returns Every surface of that plugin.
 */
export function pluginSurfaces(root: string, plugin: string): Surface[] {
  const out: Surface[] = []
  for (const abs of walk(join(root, plugin))) {
    const rel = relative(root, abs)
    const base = basename(abs)

    if (base === "PROMPT.md") {
      out.push({
        file: rel,
        locator: "(whole file)",
        text: normalizeNewlines(readFileSync(abs, "utf8")),
        line: 1,
        kind: "prompt-md",
      })
      continue
    }
    if (rel.includes("/prompts/") && base.endsWith(".md")) {
      out.push({
        file: rel,
        locator: "(whole file)",
        text: normalizeNewlines(readFileSync(abs, "utf8")),
        line: 1,
        kind: "prompts-md",
      })
      continue
    }
    if (base === "manifest.json" && rel === `${plugin}/manifest.json`) {
      const text = normalizeNewlines(readFileSync(abs, "utf8"))
      const strings: Array<{ locator: string; text: string }> = []
      try {
        manifestDescriptions(JSON.parse(text), "", strings)
      } catch (error) {
        // A manifest that does not parse is a real defect, never a skip: its
        // descriptions would go unaudited and the gate would stay green.
        out.push({
          file: rel,
          locator: "parse-error",
          text: `manifest.json does not parse: ${error instanceof Error ? error.message : String(error)}`,
          line: 1,
          kind: "manifest",
        })
        continue
      }
      for (const entry of strings) {
        out.push({
          file: rel,
          locator: entry.locator,
          text: entry.text,
          line: lineOf(text, entry.text),
          kind: "manifest",
        })
      }
      continue
    }
    if (
      base.endsWith(".ts") &&
      !base.endsWith(".test.ts") &&
      !base.endsWith(".d.ts") &&
      !rel.includes("__fixtures__")
    ) {
      const text = normalizeNewlines(readFileSync(abs, "utf8"))
      if (NOT_MODEL_FACING.has(rel)) continue
      for (const entry of collectInlineTsStrings(text)) {
        const line = Number(entry.locator.split("@L")[1] ?? "1")
        out.push({ file: rel, locator: entry.locator, text: entry.text, line, kind: "inline-ts" })
      }
      // A `PARAMS` map keys each param description by the schema property
      // name, not by `description:`, so the generic scan above cannot see it.
      // These strings reach the model in the tool schema.
      for (const entry of paramMapStrings(text)) {
        out.push({
          file: rel,
          locator: entry.locator,
          text: entry.text,
          line: entry.line,
          kind: "inline-ts",
        })
      }
    }
  }
  return out
}

/**
 * Prose values inside a `PARAMS`-style record: `Tool: { paramName: "text" }`.
 *
 * Only string values of two or more words count, so a short enum value or an
 * id does not become a surface.
 *
 * @param source - TS source text.
 * @returns Each param description with its 1-based line.
 */
export function paramMapStrings(
  source: string,
): Array<{ locator: string; text: string; line: number }> {
  const out: Array<{ locator: string; text: string; line: number }> = []
  const start = source.search(/const PARAMS[^=]*=\s*\{/)
  if (start < 0) return out
  // Scan to the end of the file; the map is the only thing this reader needs.
  const body = source.slice(start)
  // A key can be bare (`pattern`) or quoted (`"-A"`, `"output_mode"`). A value
  // can be double-quoted or single-quoted (`glob: 'A glob pattern ...'`).
  const re = /^\s{2,}"?(-?[A-Za-z_][\w-]*)"?:\s*(["'])((?:(?!\2)[^\\\n]|\\.){10,})\2,?\s*$/gm
  for (const match of body.matchAll(re)) {
    const value = decodeJsEscapes(match[3] ?? "")
    if (!/\s/.test(value)) continue
    const index = start + (match.index ?? 0)
    out.push({
      locator: `PARAMS.${match[1] ?? ""}`,
      text: value,
      line: source.slice(0, index).split("\n").length,
    })
  }
  return out
}

/**
 * Collect every surface of the repo.
 *
 * @param root - Plugins repo root. Defaults to the folder above this module.
 * @returns Every surface, sorted by file and line.
 */
export function allSurfaces(root: string = PLUGINS_ROOT): Surface[] {
  const out = pluginDirs(root).flatMap((plugin) => pluginSurfaces(root, plugin))
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

/**
 * Core TS files that still hold model-facing prose. Core owns no prompt text
 * any more except these. The list is explicit so a new file is a visible
 * change, not a silent gap.
 */
const CORE_TEXT_FILES = [
  "src/agent/context-compact.ts",
  "src/modes/mode-text.ts",
  "src/modes/modes.ts",
  "src/llm/system-prompt.ts",
  // Injects the `binary` param into every tool that can return a body.
  "src/tools/binary-guard.ts",
] as const

/**
 * Collect the model-facing surfaces of a core checkout.
 *
 * A missing core checkout is a failure, not an empty list: a CI run with only
 * the plugins repo would otherwise audit nothing and stay green. Set
 * `STE_ALLOW_MISSING_CORE=1` to opt out on purpose (a plugins-only checkout).
 *
 * @param coreRoot - Core repo root. Defaults to the sibling folder.
 * @returns Surfaces with `file` prefixed by `core/`.
 */
export function coreSurfaces(coreRoot: string = CORE_ROOT): Surface[] {
  const present = existsSync(coreRoot)
  if (!present) {
    if (process.env.STE_ALLOW_MISSING_CORE === "1") return []
    throw new Error(
      `STE: no core checkout at ${coreRoot}. Set MA_PLUGINS_DIR or clone minimal-agent-core next to the plugins repo. Set STE_ALLOW_MISSING_CORE=1 to audit plugins only.`,
    )
  }
  const out: Surface[] = []
  for (const rel of CORE_TEXT_FILES) {
    const abs = join(coreRoot, rel)
    let text: string
    try {
      text = normalizeNewlines(readFileSync(abs, "utf8"))
    } catch {
      // A file on the list that is gone is a real change, not a skip.
      out.push({
        file: `core/${rel}`,
        locator: "missing",
        text: `listed core text file is missing: ${rel}`,
        line: 1,
        kind: "core-ts",
      })
      continue
    }
    for (const entry of proseLiterals(text)) {
      out.push({
        file: `core/${rel}`,
        locator: `L${entry.line}`,
        text: entry.text,
        line: entry.line,
        kind: "core-ts",
      })
    }
  }
  return out
}
