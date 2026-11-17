/**
 * s20: a text that names a tool must use the wire name, the name in `tools[]`.
 *
 * The core loader renames each plugin tool (core
 * `src/plugins/loader/helpers.ts` `computeEffectiveName`, applied in
 * `loader.ts`). A tool without `explicitName: true` gets the CamelCase plugin
 * name as a prefix, and its old name becomes a call alias. A call by the alias
 * still works, but the model never sees the alias in `tools[]`. So a text that
 * names `CronList` names a tool that the model cannot find: the wire name is
 * `ScheduleCronList`.
 *
 * This file has three parts:
 * - {@link wireToolNames}: a port of the loader rule over every manifest, plus
 *   the core built-ins. A test keeps it equal to core and to the golden.
 * - {@link toolNameFindings}: the s20 detector for one surface text.
 * - {@link handlerMessageFindings}: the same detector over the string literals
 *   of plugin handler code, which reach the model in a `tool_result`.
 *
 * @module tests/ste/tool-names
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

import type { Role, SteFinding, ToolNameIndex } from "./ste-rules.ts"
import { PLUGINS_ROOT } from "./surfaces.ts"

/** The rule id of every finding in this file. */
export const S20_RULE = "ste-s20-tool-name"

/**
 * The core built-in tools (core `src/tools/tool-definitions.ts`). Their text
 * lives in `ma-core-tools-plugin/tool-text.ts`, which lists the same names in
 * `TOOLS`. The index reads that list and falls back to this one.
 */
export const BUILTIN_TOOLS: readonly string[] = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "FilesStats",
  "Mode",
]

/** One manifest tool and the name that the loader gives it. */
export interface ToolNameEntry {
  /** Plugin directory, for example `ma-schedule-plugin`. */
  plugin: string
  /** `manifest.name`, for example `Schedule`. */
  manifestName: string
  /** The `trigger.tool.name` in the manifest, for example `CronList`. */
  tool: string
  /** The name in `tools[]`, for example `ScheduleCronList`. */
  wire: string
  /** The old name that the loader keeps as a call alias, or null. */
  alias: string | null
  /** False when the plugin sets `enabled: false`. */
  enabled: boolean
}

/** The wire names, the aliases and the facts behind them. */
export interface ToolNames extends ToolNameIndex {
  wire: Set<string>
  aliasToWire: Map<string, string>
  /** CamelCase prefixes that the loader adds (`Schedule`, `SubAgents` ...). */
  prefixes: Set<string>
  /** One entry for each manifest tool, in directory order. */
  entries: ToolNameEntry[]
}

/**
 * Port of core `deriveCamelName`: split on spaces and hyphens, capitalize
 * each token, join. `"Sub-agents"` gives `"SubAgents"`.
 *
 * @param name - `manifest.name`.
 * @returns The CamelCase prefix.
 */
export function deriveCamelName(name: string): string {
  return name
    .split(/[\s-]+/)
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
    .join("")
}

/**
 * Port of core `computeEffectiveName`. With `explicitName: true` the name is
 * unchanged. Otherwise the prefix is `camelName` (or the derived one) and the
 * old name becomes the alias. A name that already equals the prefixed form
 * keeps no alias.
 *
 * @param toolName - `trigger.tool.name` in the manifest.
 * @param explicitName - `trigger.tool.explicitName`.
 * @param manifestName - `manifest.name`.
 * @param camelName - `manifest.camelName`, when set.
 * @returns The wire name and the alias.
 */
export function effectiveName(
  toolName: string,
  explicitName: boolean | undefined,
  manifestName: string,
  camelName: string | undefined,
): { canonical: string; migrationAlias: string | null } {
  if (explicitName === true) return { canonical: toolName, migrationAlias: null }
  const prefix = camelName ?? deriveCamelName(manifestName)
  const canonical = `${prefix}${toolName}`
  if (canonical === toolName) return { canonical: toolName, migrationAlias: null }
  return { canonical, migrationAlias: toolName }
}

/** The shape of a manifest tool, as far as naming goes. */
interface ManifestTool {
  trigger?: {
    type?: string
    tool?: { name?: string; explicitName?: boolean; aliases?: string[] }
  }
}

/** The shape of a manifest, as far as naming goes. */
interface Manifest {
  name?: string
  camelName?: string
  enabled?: boolean
  headless?: { tools?: ManifestTool[] }
  tools?: ManifestTool[]
}

/** A port function with the signature of {@link effectiveName}, for a mutation test. */
export type EffectiveNameFn = typeof effectiveName

/**
 * Read the built-in names from `ma-core-tools-plugin/tool-text.ts` `TOOLS`.
 *
 * @param root - Plugins repo root.
 * @returns The names, or {@link BUILTIN_TOOLS} when the file has no list.
 */
function builtinNames(root: string): readonly string[] {
  const path = join(root, "ma-core-tools-plugin", "tool-text.ts")
  if (!existsSync(path)) return BUILTIN_TOOLS
  const match = /export const TOOLS[^=]*=\s*\[([^\]]*)\]/.exec(readFileSync(path, "utf8"))
  if (!match) return BUILTIN_TOOLS
  const names = [...(match[1] ?? "").matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1] ?? "")
  return names.length > 0 ? names : BUILTIN_TOOLS
}

/**
 * Build the wire-name index from every `ma-*` manifest and the built-ins.
 *
 * A disabled plugin is in the index too: its text ships in the repo, and a
 * user can enable it. `entries[].enabled` keeps the fact.
 *
 * @param root - Plugins repo root.
 * @param port - The naming rule. A test passes a broken copy to prove the
 *   golden parity test catches it.
 * @returns The index.
 */
export function wireToolNames(
  root: string = PLUGINS_ROOT,
  port: EffectiveNameFn = effectiveName,
): ToolNames {
  const wire = new Set<string>(builtinNames(root))
  const aliasToWire = new Map<string, string>()
  const prefixes = new Set<string>()
  const entries: ToolNameEntry[] = []
  const dirs = readdirSync(root)
    .filter((d) => d.startsWith("ma-") && existsSync(join(root, d, "manifest.json")))
    .sort()
  for (const plugin of dirs) {
    const manifest = JSON.parse(
      readFileSync(join(root, plugin, "manifest.json"), "utf8"),
    ) as Manifest
    const manifestName = manifest.name ?? plugin
    const tools = [...(manifest.headless?.tools ?? []), ...(manifest.tools ?? [])]
    for (const handler of tools) {
      const tool = handler.trigger?.tool
      if (handler.trigger?.type !== "tool" || !tool?.name) continue
      const { canonical, migrationAlias } = port(
        tool.name,
        tool.explicitName,
        manifestName,
        manifest.camelName,
      )
      wire.add(canonical)
      if (migrationAlias) {
        aliasToWire.set(migrationAlias, canonical)
        prefixes.add(canonical.slice(0, canonical.length - migrationAlias.length))
      }
      for (const alias of tool.aliases ?? []) aliasToWire.set(alias, canonical)
      entries.push({
        plugin,
        manifestName,
        tool: tool.name,
        wire: canonical,
        alias: migrationAlias,
        enabled: manifest.enabled !== false,
      })
    }
  }
  // A wire name is never an alias, even when two plugins disagree.
  for (const name of wire) aliasToWire.delete(name)
  return { wire, aliasToWire, prefixes, entries }
}

// ---------------------------------------------------------------------------
// The detector
// ---------------------------------------------------------------------------

/** Two or more CamelCase humps, each a capital and lowercase letters or digits. */
const CAMEL = /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+$/

/** One hump only: `Send`, `Inbox`, `Peers`. */
const ONE_HUMP = /^[A-Z][a-z0-9]+$/

/**
 * Words before a tool reference: "use X", "call X", "with X", "via the X".
 * The match is on the text just before the token.
 */
const REFERENCE_BEFORE =
  /\b(?:use|using|uses|call|calling|calls|called|run|running|try|with|via|through|check|see|the|a|an|its)\s+(?:the\s+)?$/i

/** Words before a single-hump `Send` that cannot be the English verb. */
const SEND_BEFORE = /\b(?:use|using|call|calling|with|via|through)\s+(?:the\s+)?$/i

/** Words after a tool reference: "X tool", "X(", "X again", "X first". */
const REFERENCE_AFTER = /^(?:\s+tool\b|\(|\s+again\b|\s+first\b)/

/** A finding before it gets a line number and a role. */
export interface ToolReference {
  /** The token as written. */
  name: string
  /** Offset of the token in the text. */
  offset: number
  /** True when the token is a whole backtick span (or its call shape). */
  backticked: boolean
  /** The wire name to use instead, or null when no wire name is close. */
  wire: string | null
}

/**
 * Edit distance, capped: returns `cap + 1` as soon as the distance is above
 * the cap, so a long name costs little.
 *
 * @param a - First word.
 * @param b - Second word.
 * @param cap - Largest distance of interest.
 * @returns The Levenshtein distance, or `cap + 1`.
 */
function distance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const value = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost)
      row.push(value)
      best = Math.min(best, value)
    }
    if (best > cap) return cap + 1
    prev = row
  }
  return prev[b.length] ?? cap + 1
}

/**
 * The closest wire name to a near-miss token, within 2 edits. A token that is
 * a prefix plus a known tool name (`ScheduleCronCreated`) also matches.
 *
 * @param name - The token.
 * @param index - Wire-name index.
 * @returns The wire name, or null.
 */
function nearestWire(name: string, index: ToolNameIndex): string | null {
  let best: string | null = null
  let bestDistance = 3
  for (const wire of index.wire) {
    if (wire.length < 6) continue
    const d = distance(name, wire, 2)
    if (d < bestDistance) {
      best = wire
      bestDistance = d
    }
  }
  return best
}

/**
 * True when a token that is not a wire name or an alias still looks like a
 * tool name: a near miss of a wire name, or a loader prefix plus more humps.
 *
 * @param name - The token.
 * @param index - Wire-name index.
 * @returns The wire name to suggest, `""` when it is tool-shaped with no
 *   suggestion, or null when it is not a tool reference.
 */
function unknownToolShape(name: string, index: ToolNames | ToolNameIndex): string | null {
  const near = nearestWire(name, index)
  if (near) return near
  const prefixes = "prefixes" in index ? (index as ToolNames).prefixes : new Set<string>()
  for (const prefix of prefixes) {
    if (name.startsWith(prefix) && /^(?:[A-Z][a-z0-9]+)+$/.test(name.slice(prefix.length)))
      return ""
  }
  return null
}

/**
 * Find every tool reference in one text that is not a wire name.
 *
 * Four places are read:
 * 1. A backtick span (raw) that holds one CamelCase name, or its call shape
 *    (a span that holds `ReportResult(...)` or `ReportResult.deliverables`).
 * 2. A bare token in the masked prose (code, URLs and paths are blanked).
 * 3. A call shape in the raw text (`CloudStatus({})`, also in a fence).
 *
 * A token fires when it is an alias, or when it is tool-shaped (a near miss
 * of a wire name, or a loader prefix plus more humps) and it is used as a
 * reference (backticked, "use X", "X tool", "X(" ...). A one-hump alias
 * (`Inbox`, `Peers`, `Mailbox`) fires only when it is backticked or used as a
 * reference, so "your last Inbox read" stays quiet. `Send` is also an English
 * verb, so it fires only when backticked, before "tool", in a call shape, or
 * after "use|call|with|via|through".
 *
 * @param masked - Masked text, same length as `raw`.
 * @param raw - Raw text.
 * @param index - Wire-name index.
 * @returns The references, in offset order.
 */
export function toolReferences(
  masked: string,
  raw: string,
  index: ToolNames | ToolNameIndex,
): ToolReference[] {
  const seen = new Map<number, ToolReference>()

  const judge = (name: string, offset: number, backticked: boolean): void => {
    if (seen.has(offset) || index.wire.has(name)) return
    const before = raw.slice(Math.max(0, offset - 40), offset)
    const after = raw.slice(offset + name.length, offset + name.length + 12)
    const asReference = backticked || REFERENCE_AFTER.test(after) || REFERENCE_BEFORE.test(before)
    const alias = index.aliasToWire.get(name)
    if (alias !== undefined) {
      if (name === "Send") {
        const strong = backticked || /^(?:\s+tool\b|\()/.test(after) || SEND_BEFORE.test(before)
        if (!strong) return
      } else if (ONE_HUMP.test(name) && !asReference) {
        return
      }
      seen.set(offset, { name, offset, backticked, wire: alias })
      return
    }
    if (!CAMEL.test(name) || !asReference) return
    const shape = unknownToolShape(name, index)
    if (shape === null) return
    seen.set(offset, { name, offset, backticked, wire: shape || null })
  }

  // 1. Backtick spans: one name, or its call or field shape.
  for (const match of raw.matchAll(/`([A-Z][A-Za-z0-9]*)(?:\([^`\n]*\)|\.[a-z]\w*)?`/g)) {
    judge(match[1] ?? "", (match.index ?? 0) + 1, true)
  }
  // 2. Bare tokens in masked prose.
  for (const match of masked.matchAll(/(?<![\w./-])[A-Z][A-Za-z0-9]+(?![\w-])/g)) {
    judge(match[0], match.index ?? 0, false)
  }
  // 3. Call shapes anywhere in the raw text, also in a fence.
  for (const match of raw.matchAll(/(?<![\w.])([A-Z][A-Za-z0-9]+)\(/g)) {
    const name = match[1] ?? ""
    const offset = match.index ?? 0
    if (index.aliasToWire.has(name) || CAMEL.test(name)) judge(name, offset, false)
  }
  return [...seen.values()].sort((a, b) => a.offset - b.offset)
}

/** The input of {@link toolNameFindings}, the same as the `extraFindings` hook. */
export interface ToolNameArgs {
  /** Masked text (`maskNonProse`), the same length as `raw`. */
  masked: string
  /** Raw text. */
  raw: string
  /** Lines before the text in its file. */
  lineOffset: number
  /** Repo-relative file. */
  file: string
  /** Role of the surface. */
  role: Role
}

/**
 * The finding message for one reference.
 *
 * @param name - The token.
 * @param wire - The wire name, or null.
 * @returns The message.
 */
export function toolNameMessage(name: string, wire: string | null): string {
  return wire
    ? `"${name}" is not a tool name the model sees; use "${wire}"`
    : `"${name}" is not a tool name the model sees; use a name from tools[]`
}

/**
 * s20 findings for one text. Severity is always `error`: a wrong tool name is
 * zero-tolerance in every role.
 *
 * @param args - The text, its mask, its line offset, file and role.
 * @param index - Wire-name index from {@link wireToolNames}.
 * @returns One finding per reference.
 */
export function toolNameFindings(
  args: ToolNameArgs,
  index: ToolNames | ToolNameIndex,
): SteFinding[] {
  return toolReferences(args.masked, args.raw, index).map((ref) => ({
    rule: S20_RULE,
    message: toolNameMessage(ref.name, ref.wire),
    snippet: ref.name,
    line: args.lineOffset + 1 + countNewlines(args.raw, ref.offset),
    severity: "error" as const,
    offset: ref.offset,
    role: args.role,
  }))
}

/**
 * Count the newlines before an offset.
 *
 * @param text - Text.
 * @param end - Offset.
 * @returns Newlines in `text.slice(0, end)`.
 */
function countNewlines(text: string, end: number): number {
  let count = 0
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) count++
  return count
}

// ---------------------------------------------------------------------------
// Handler messages
// ---------------------------------------------------------------------------

/** One string literal in a TS source, with its body and position. */
export interface StringLiteral {
  /** The literal body, without quotes. A template keeps `${...}` as written. */
  text: string
  /** Offset of the body in the source. */
  offset: number
  /** 1-based line of the body start. */
  line: number
}

/**
 * Read the string and template literals of a TS source. Comments and regex
 * literals are skipped. A `${...}` in a template is kept as text, so the
 * detector sees one literal per template.
 *
 * @param source - TS source text.
 * @returns Each literal, in source order.
 */
export function stringLiterals(source: string): StringLiteral[] {
  const out: StringLiteral[] = []
  let line = 1
  let i = 0
  let lastSignificant = ""
  /**
   * Read one literal that opens at `open`. A template expression `${...}` is
   * scanned for nested literals, so a template inside a template is found.
   *
   * @param open - Offset of the opening quote.
   * @param quote - The quote character.
   * @returns The offset after the closing quote.
   */
  const scanString = (open: number, quote: string): number => {
    const startLine = line
    const start = open + 1
    let k = start
    let depth = 0
    while (k < source.length) {
      const c = source[k]
      if (c === "\\") {
        k += 2
        continue
      }
      if (c === "\n") {
        if (quote !== "`" && depth === 0) break
        line++
      }
      if (depth > 0 && (c === '"' || c === "'" || c === "`")) {
        k = scanString(k, c)
        continue
      }
      if (quote === "`" && c === "$" && source[k + 1] === "{") {
        depth++
        k += 2
        continue
      }
      if (depth > 0 && c === "{") depth++
      else if (depth > 0 && c === "}") depth--
      else if (depth === 0 && c === quote) break
      k++
    }
    out.push({ text: source.slice(start, k), offset: start, line: startLine })
    return k + 1
  }
  while (i < source.length) {
    const ch = source[i] ?? ""
    const next = source[i + 1] ?? ""
    if (ch === "\n") {
      line++
      i++
      continue
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++
      continue
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2)
      const stop = end < 0 ? source.length : end + 2
      for (let k = i; k < stop; k++) if (source[k] === "\n") line++
      i = stop
      continue
    }
    if (ch === "/" && /[(,=:[!&|?{};]|^$|return$/.test(lastSignificant)) {
      // A regex literal: skip to the closing slash on the same line.
      let k = i + 1
      let inClass = false
      while (k < source.length && source[k] !== "\n") {
        const c = source[k]
        if (c === "\\") k++
        else if (c === "[") inClass = true
        else if (c === "]") inClass = false
        else if (c === "/" && !inClass) break
        k++
      }
      i = k + 1
      lastSignificant = "x"
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      i = scanString(i, ch)
      lastSignificant = "x"
      continue
    }
    if (!/\s/.test(ch)) {
      // Track the last token for the regex test: a word or one punctuation.
      if (/\w/.test(ch)) {
        let k = i
        while (k < source.length && /\w/.test(source[k] ?? "")) k++
        lastSignificant = source.slice(i, k)
        i = k
        continue
      }
      lastSignificant = ch
    }
    i++
  }
  return out
}

/** A `Name:` or `Name word:` error prefix at the start of a literal. */
const ERROR_PREFIX = /^([A-Z][A-Za-z0-9]+)(?:\s+[a-z]+)?:/

/**
 * True when a literal is human text, not an identifier. An identifier is one
 * token with no space that does not end in punctuation (`"ReportResult"`,
 * `"show_diff"`, `"a.b"`). `"ReportResult."` ends a sentence, so it is text.
 *
 * @param text - Literal body.
 * @returns True for prose.
 */
function isHumanText(text: string): boolean {
  return /[A-Za-z]/.test(text) && !/^[\w$.-]*[\w$]$/.test(text.trim())
}

/**
 * Blank every `${...}` of a template body, nested braces and nested templates
 * included. A nested template is its own literal, so it is read once there.
 *
 * @param text - Template body.
 * @returns Text of the same length.
 */
export function blankExpressions(text: string): string {
  const chars = text.split("")
  let depth = 0
  for (let i = 0; i < chars.length; i++) {
    if (depth === 0 && chars[i] === "$" && chars[i + 1] === "{") {
      depth = 1
      chars[i] = " "
      chars[i + 1] = " "
      i++
      continue
    }
    if (depth > 0) {
      if (chars[i] === "{") depth++
      else if (chars[i] === "}") depth--
      if (chars[i] !== "\n") chars[i] = " "
    }
  }
  return chars.join("")
}

/** One handler literal that names a tool by a non-wire name. */
export interface HandlerFinding {
  /** Repo-relative file. */
  file: string
  /** 1-based line of the token. */
  line: number
  /** The token as written. */
  name: string
  /** The wire name to use. */
  wire: string | null
  /** The literal, shortened, for the report. */
  context: string
}

/**
 * List the handler and lib files of every plugin (no tests, no fixtures).
 *
 * @param root - Plugins repo root.
 * @returns Absolute paths, sorted.
 */
function handlerFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name === "node_modules" || name === "__fixtures__" || name.startsWith(".")) continue
      const abs = join(dir, name)
      if (statSync(abs).isDirectory()) walk(abs)
      else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
        out.push(abs)
      }
    }
  }
  for (const plugin of readdirSync(root).sort()) {
    if (!plugin.startsWith("ma-")) continue
    for (const sub of ["handlers", "lib"]) {
      const dir = join(root, plugin, sub)
      if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir)
    }
  }
  return out
}

/**
 * s20 over plugin code: each string or template literal of human text in
 * `ma-*\/handlers/**` and `ma-*\/lib/**` (not tests) that names a tool by a
 * non-wire name. These strings reach the model in a `tool_result`, a digest
 * or an attachment.
 *
 * A literal that is one word (an identifier that code compares, such as
 * `RESULT_TOOLS`) is never read. A `Name:` error prefix at the start of a
 * literal (`"CronList: wrong trigger"`) is not guidance and stays quiet; the
 * rest of the same literal is still read ("... call ReportResult again").
 * A multi-hump alias fires anywhere else in the literal; a one-hump alias
 * follows the same context rule as {@link toolReferences}.
 *
 * @param root - Plugins repo root.
 * @param index - Wire-name index. Default: built from `root`.
 * @returns Each finding, in file and line order.
 */
export function handlerMessageFindings(
  root: string = PLUGINS_ROOT,
  index: ToolNames = wireToolNames(root),
): HandlerFinding[] {
  const out: HandlerFinding[] = []
  for (const abs of handlerFiles(root)) {
    const source = readFileSync(abs, "utf8")
    const file = relative(root, abs)
    for (const literal of stringLiterals(source)) {
      if (!isHumanText(literal.text)) continue
      // Blank `${...}` so an expression is not read as prose.
      const masked = blankExpressions(literal.text)
      const prefix = ERROR_PREFIX.exec(masked)
      const refs = toolReferences(masked, literal.text, index)
      for (const ref of refs) {
        if (prefix && ref.offset === 0) continue
        out.push({
          file,
          line: literal.line + countNewlines(literal.text, ref.offset),
          name: ref.name,
          wire: ref.wire,
          context: literal.text.replace(/\s+/g, " ").slice(0, 100),
        })
      }
      // A multi-hump alias as a bare subject ("ReportResult can write only")
      // is not caught by the reference context, so add it here.
      for (const match of masked.matchAll(/(?<![\w./-])[A-Z][A-Za-z0-9]+(?![\w-])/g)) {
        const name = match[0]
        const offset = match.index ?? 0
        if (prefix && offset === 0) continue
        if (refs.some((r) => r.offset === offset)) continue
        const wire = index.aliasToWire.get(name)
        if (wire === undefined || !CAMEL.test(name)) continue
        out.push({
          file,
          line: literal.line + countNewlines(literal.text, offset),
          name,
          wire,
          context: literal.text.replace(/\s+/g, " ").slice(0, 100),
        })
      }
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}
