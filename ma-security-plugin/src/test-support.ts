/**
 * Shared helpers for the plugin's static tests (deps, arch).
 *
 * @module src/test-support
 */

import { readdirSync } from "node:fs"
import { dirname, join } from "node:path"

/** Absolute path of the plugin package root. */
export const PLUGIN_ROOT = dirname(import.meta.dir)

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith(".ts")) out.push(full)
  }
}

/** List index.ts plus every `.ts` file under src/, sorted. */
export function listSourceFiles(opts: { includeTests: boolean }): string[] {
  const out: string[] = [join(PLUGIN_ROOT, "index.ts")]
  walk(join(PLUGIN_ROOT, "src"), out)
  const files = opts.includeTests ? out : out.filter((f) => !f.endsWith(".test.ts"))
  return files.sort()
}

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|(?:^|\n)\s*import\s*["']([^"']+)["']|\brequire\(\s*["']([^"']+)["']\s*\)/g

/** Module specifiers a source text imports (static, dynamic, side effect, require). */
export function importSpecifiers(text: string): string[] {
  return [...text.matchAll(IMPORT_RE)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4] ?? "")
}

const ASYNC_RE = /\basync\b|\bawait\b|\bPromise\b|\.then\(/

/** True when the text uses async code. */
export function usesAsync(text: string): boolean {
  return ASYNC_RE.test(text)
}

const PRINT_RE = /\bconsole\s*[.[]|\bprocess\s*\.\s*(?:stdout|stderr)\b/

/** True when the text prints (console member access or process stdout/stderr). */
export function usesConsole(text: string): boolean {
  return PRINT_RE.test(text)
}

const TIMEOUT_KEY = ["timeout", "Ms"].join("")

/** Ids (or indexes) of manifest hooks that declare a timeout key. */
export function hooksWithTimeout(manifest: { hooks?: unknown[] }): string[] {
  const out: string[] = []
  for (const [i, h] of (manifest.hooks ?? []).entries()) {
    if (h !== null && typeof h === "object" && TIMEOUT_KEY in h) {
      const id = (h as { id?: unknown }).id
      out.push(typeof id === "string" ? id : String(i))
    }
  }
  return out
}

/** Index just past the brace that closes the `{` at `open`, or -1. Skips strings and comments. */
function matchBrace(text: string, open: number): number {
  let depth = 0
  let i = open
  while (i < text.length) {
    const c = text[i]
    if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i)
      i = nl === -1 ? text.length : nl
      continue
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2)
      i = end === -1 ? text.length : end + 2
      continue
    }
    if (c === '"' || c === "'" || c === "`") {
      i++
      while (i < text.length && text[i] !== c) i += text[i] === "\\" ? 2 : 1
      i++
      continue
    }
    if (c === "{") depth++
    if (c === "}") {
      depth--
      if (depth === 0) return i + 1
    }
    i++
  }
  return -1
}

/** Index of the first non-whitespace char at or after `i`. */
function skipWs(text: string, i: number): number {
  let j = i
  while (j < text.length && /\s/.test(text[j] ?? "")) j++
  return j
}

/**
 * True when the default export body is exactly one try/catch: `try {`
 * first, then `catch`, and only whitespace between the end of the catch
 * block and the function's closing brace.
 */
export function isOneTryCatch(text: string): boolean {
  const head = /export default function \w+\s*\(/.exec(text)
  if (!head) return false
  const paramsEnd = text.indexOf(")", head.index + head[0].length)
  const bodyOpen = text.indexOf("{", paramsEnd)
  if (paramsEnd === -1 || bodyOpen === -1) return false
  const bodyEnd = matchBrace(text, bodyOpen)
  if (bodyEnd === -1) return false
  const fnClose = bodyEnd - 1
  let i = skipWs(text, bodyOpen + 1)
  if (!/^try\s*\{/.test(text.slice(i))) return false
  const tryEnd = matchBrace(text, text.indexOf("{", i))
  if (tryEnd === -1) return false
  i = skipWs(text, tryEnd)
  const c = /^catch\s*(?:\([^)]*\))?\s*\{/.exec(text.slice(i))
  if (!c) return false
  const catchEnd = matchBrace(text, i + c[0].length - 1)
  if (catchEnd === -1 || catchEnd > fnClose) return false
  return skipWs(text, catchEnd) === fnClose
}
