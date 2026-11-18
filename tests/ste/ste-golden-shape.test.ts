/**
 * Keep the golden regeneration honest (R3 section 10.3).
 *
 * A text rewrite regenerates the request goldens. The new goldens must differ
 * from the merge base ONLY in prose: a string leaf whose key is `description`
 * or `text`. Every key, array length, non-string leaf, tool name, enum value
 * and `required[]` entry must stay equal. A rewrite that renames a tool, drops
 * a parameter or changes an enum fails here, even when the golden test
 * itself was regenerated and passes.
 *
 * Protocol tags (review C M6): a prose leaf may change its words, but not its
 * `<ma::...>` tags. Before a prose leaf is allowed, {@link maTags} reads every
 * tag (name and attributes, as written) from both sides. In a `text` leaf the
 * two lists must be equal, in the same order. A `description` leaf may add or
 * drop a tag mention (the STE pass rewrote tool docs), but each tag name must
 * be one that the merge-base golden uses. A renamed
 * `<ma::agent::turn-aborted />` or a changed attribute is a `tag` difference.
 *
 * A {@link PROSE_LEAVES} entry allows a change only to the part BEFORE the
 * trailing `<ma::agent::mode-active .../>` stamp. The stamp (from the `\n\n`
 * before it to the end) must stay byte-identical ({@link proseLeafProblem}).
 *
 * The test skips with a printed notice when there is no merge base with
 * origin/main. A golden that is new since the merge base has nothing to
 * compare and is listed, not failed.
 *
 * @module tests/ste/ste-golden-shape.test
 */

import { execFileSync } from "node:child_process"
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { PLUGINS_ROOT } from "./surfaces.ts"

/** Golden folder, relative to the plugins root. */
const GOLDEN_DIR = "tests/request-golden/goldens"

/** String keys whose value is prose, so a rewrite may change it. */
const PROSE_KEYS: ReadonlySet<string> = new Set(["description", "text"])

/** One difference between two JSON values. */
export interface LeafDiff {
  /** JSON path, for example `requests[0].tools[3].input_schema.required[1]`. */
  path: string
  /**
   * `shape`: a key, an array length or a value type differs. `value`: a
   * non-prose leaf differs. `tag`: a prose leaf differs in its `<ma::...>`
   * tags. `string`: a prose leaf differs in its words only (allowed).
   */
  kind: "shape" | "value" | "tag" | "string"
  /** The key of the leaf. An array item takes the key of its array. */
  key: string
}

/** One `<ma::...>` protocol tag, open, close or self-closing, as written. */
const MA_TAG = /<\/?ma::[^<>]*>/g

/**
 * Every `<ma::...>` protocol tag in a text, with its attributes, in order.
 *
 * @param text - A prose leaf.
 * @returns The tags, as written.
 */
export function maTags(text: string): string[] {
  return text.match(MA_TAG) ?? []
}

/**
 * The tag name of a `<ma::...>` tag: `<ma::agent::turn-aborted />` gives
 * `ma::agent::turn-aborted`.
 *
 * @param tag - One tag, as {@link maTags} gives it.
 * @returns The name.
 */
export function maTagName(tag: string): string {
  return /^<\/?(ma::[^\s/>]+)/.exec(tag)?.[1] ?? tag
}

/**
 * Every `<ma::...>` tag name in every string of a JSON value.
 *
 * @param value - A golden.
 * @param out - The set to fill.
 * @returns The set.
 */
export function maTagNames(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") for (const tag of maTags(value)) out.add(maTagName(tag))
  else if (Array.isArray(value)) for (const item of value) maTagNames(item, out)
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) maTagNames(v, out)
  return out
}

/**
 * Tag names that a `description` may name although the merge-base golden
 * does not use them. Each entry needs the file that renders the tag; a test
 * checks that the file holds `<` + the name. Keep it narrow.
 */
export const DESCRIPTION_TAGS: ReadonlyArray<{ tag: string; source: string; reason: string }> = [
  {
    tag: "ma::agent::memory-saved",
    source: "ma-memory-plugin/lib/save-echo.ts",
    reason:
      "MemoryTool `id` named the old tag `<memory-saved>`; the STE pass gave the tag that renderEcho writes",
  },
]

/** The tag names of {@link DESCRIPTION_TAGS}. */
const DESCRIPTION_TAG_NAMES: ReadonlySet<string> = new Set(DESCRIPTION_TAGS.map((t) => t.tag))

/**
 * True when a changed prose leaf keeps its protocol tags.
 *
 * - A `text` leaf (system prompt, message, tool result) is the protocol that
 *   ships: the tag list, attributes included, must be equal and in order.
 * - A `description` leaf is tool documentation that the STE pass rewrites. It
 *   may add or drop a mention of a tag, but every tag NAME in it must be a
 *   name that the merge-base golden uses somewhere (or a
 *   {@link DESCRIPTION_TAGS} entry), so a renamed tag fails.
 *
 * @param key - `text` or `description`.
 * @param before - The merge-base text.
 * @param after - The current text.
 * @param known - Every tag name of the merge-base golden.
 * @returns True when the tags are kept.
 */
function tagsKept(key: string, before: string, after: string, known: ReadonlySet<string>): boolean {
  const tagsA = maTags(before)
  const tagsB = maTags(after)
  if (tagsA.join("\u0000") === tagsB.join("\u0000")) return true
  if (key !== "description") return false
  return tagsB.every(
    (tag) => known.has(maTagName(tag)) || DESCRIPTION_TAG_NAMES.has(maTagName(tag)),
  )
}

/**
 * Compare two JSON values leaf by leaf.
 *
 * @param before - The merge-base value.
 * @param after - The current value.
 * @param path - JSON path of the values.
 * @param key - Key of the values (an array item keeps its array key).
 * @param known - Every `<ma::...>` tag name of the whole merge-base value.
 *   Computed from `before` on the top call.
 * @returns Every difference, in walk order.
 */
export function leafDiff(
  before: unknown,
  after: unknown,
  path = "$",
  key = "",
  known: ReadonlySet<string> = maTagNames(before),
): LeafDiff[] {
  const typeOf = (v: unknown): string =>
    v === null ? "null" : Array.isArray(v) ? "array" : typeof v
  if (typeOf(before) !== typeOf(after)) return [{ path, kind: "shape", key }]
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) return [{ path: `${path}.length`, kind: "shape", key }]
    return before.flatMap((item, i) => leafDiff(item, after[i], `${path}[${i}]`, key, known))
  }
  if (before && typeof before === "object") {
    const a = before as Record<string, unknown>
    const b = after as Record<string, unknown>
    const keysA = Object.keys(a).sort()
    const keysB = Object.keys(b).sort()
    if (keysA.join("\u0000") !== keysB.join("\u0000")) {
      const only = [
        ...keysA.filter((k) => !(k in b)).map((k) => `-${k}`),
        ...keysB.filter((k) => !(k in a)).map((k) => `+${k}`),
      ]
      return [{ path: `${path}{${only.join(",")}}`, kind: "shape", key }]
    }
    return keysA.flatMap((k) => leafDiff(a[k], b[k], `${path}.${k}`, k, known))
  }
  if (before === after) return []
  if (typeof before === "string" && PROSE_KEYS.has(key)) {
    const kept = tagsKept(key, before, after as string, known)
    return [{ path, kind: kept ? "string" : "tag", key }]
  }
  return [{ path, kind: "value", key }]
}

/**
 * The differences that a text rewrite may not make.
 *
 * @param before - The merge-base golden.
 * @param after - The current golden.
 * @returns Every `shape` and `value` difference.
 */
export function forbiddenDiffs(before: unknown, after: unknown): LeafDiff[] {
  return leafDiff(before, after).filter((d) => d.kind !== "string")
}

/**
 * The tool names, enum values and `required[]` lists of a golden, by path.
 * The leaf diff covers them already. This list makes the R3 requirement
 * explicit and gives a clear message when it fails.
 *
 * @param value - A golden.
 * @param path - JSON path.
 * @param out - Collected `path=value` lines.
 * @returns The lines.
 */
export function contractLeaves(value: unknown, path = "$", out: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item, i) => contractLeaves(item, `${path}[${i}]`, out))
    return out
  }
  if (!value || typeof value !== "object") return out
  const node = value as Record<string, unknown>
  if (/\.tools\[\d+\]$/.test(path) && typeof node.name === "string")
    out.push(`${path}.name=${node.name}`)
  for (const k of ["enum", "required"]) {
    if (Array.isArray(node[k])) out.push(`${path}.${k}=${JSON.stringify(node[k])}`)
  }
  for (const [k, child] of Object.entries(node)) contractLeaves(child, `${path}.${k}`, out)
  return out
}

/**
 * Run git in the plugins root.
 *
 * @param args - Git arguments.
 * @returns Stdout, or null on failure.
 */
function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: PLUGINS_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch {
    return null
  }
}

const MERGE_BASE = git(["merge-base", "HEAD", "origin/main"])?.trim() || null

/** Golden file names today. */
const GOLDENS = readdirSync(join(PLUGINS_ROOT, GOLDEN_DIR))
  .filter((name) => name.endsWith(".json"))
  .sort()

/** Golden file names at the merge base. */
const BASE_GOLDENS = new Set(
  MERGE_BASE === null
    ? []
    : (git(["ls-tree", "--name-only", `${MERGE_BASE}:${GOLDEN_DIR}`]) ?? "")
        .split("\n")
        .filter((name) => name.endsWith(".json")),
)

/**
 * Read a golden at the merge base.
 *
 * @param name - Golden file name.
 * @returns The parsed golden, or null when it is not there.
 */
function baseGolden(name: string): unknown {
  if (MERGE_BASE === null || !BASE_GOLDENS.has(name)) return null
  const raw = git(["show", `${MERGE_BASE}:${GOLDEN_DIR}/${name}`])
  return raw === null ? null : (JSON.parse(raw) as unknown)
}

/**
 * Read a golden in the working tree.
 *
 * @param name - Golden file name.
 * @returns The parsed golden.
 */
function currentGolden(name: string): unknown {
  return JSON.parse(readFileSync(join(PLUGINS_ROOT, GOLDEN_DIR, name), "utf8")) as unknown
}

/** One {@link PROSE_LEAVES} entry. */
export interface ProseLeaf {
  /** Golden file name. */
  golden: string
  /** JSON path of the leaf, as {@link leafDiff} writes it. */
  path: string
  /** Where the text comes from. */
  source: string
}

/**
 * Model-facing prose that ships OUTSIDE a `description` or `text` key, and that
 * the STE pass may change. Each entry names one golden, one JSON path and the
 * source of the text. Keep it narrow: a new entry needs a source and a reason.
 * An entry allows a change only before the trailing mode stamp
 * ({@link proseLeafProblem}).
 */
export const PROSE_LEAVES: readonly ProseLeaf[] = [
  // The ask-mode refusal hint (ma-ask-mode-plugin/manifest.json refusalHint),
  // which core sends as the tool_result of a refused Edit or Write. The STE
  // pass fixed the old tool name `ShowDiff` (wire name: DiffViewerShowDiff).
  {
    golden: "ask-mode-edit-allowed-today.json",
    path: "$.requests[0].messages[2].content[0].content",
    source: "ma-ask-mode-plugin refusalHint",
  },
  {
    golden: "ask-mode-write-allowed-today.json",
    path: "$.requests[0].messages[2].content[0].content",
    source: "ma-ask-mode-plugin refusalHint",
  },
]

/**
 * One intended SCHEMA change: a key that a tool's `input_schema` property
 * gains, with its exact value. It is not prose, so {@link PROSE_LEAVES} cannot
 * allow it. Each entry names the tool, the property, the added key and value,
 * and the reason.
 *
 * Remove an entry when main has the new goldens: the guard compares with the
 * merge base, so after the change lands the entry matches nothing. Do not add
 * a check that fails on a stale entry: on the push run to main the merge base
 * is HEAD, and that check would turn main red.
 */
export interface SchemaAddition {
  /** Tool name (`tools[i].name`). */
  tool: string
  /** Property of the tool's `input_schema.properties`. */
  property: string
  /** The key that the property gains. */
  key: string
  /** The exact value of the new key. */
  value: unknown
  /** Why the schema changed. */
  source: string
}

/** Intended schema additions. Keep it narrow: each entry needs a reason. */
export const SCHEMA_ADDITIONS: readonly SchemaAddition[] = [
  // Strict OpenAI tools (ma-llm-openai-plugin/responses/strict-tools.ts) need
  // a declared type on each property. Task's ids take a string or a positive
  // integer (task_tool.ts isIdRef). Remove these entries after the change is
  // on plugins main (follow-up PR).
  ...["id", "parent", "after"].map((property) => ({
    tool: "Task",
    property,
    key: "type",
    value: ["string", "integer"],
    source: "nullable strict tools: Task id type",
  })),
  {
    tool: "Task",
    property: "order",
    key: "items",
    value: { type: ["string", "integer"] },
    source: "nullable strict tools: Task order item type",
  },
]

/** A `shape` path of a key added to a tool property: `...tools[i].input_schema.properties.<p>{+<k>}`. */
const ADDED_PROPERTY_KEY =
  /^(.*\.tools\[\d+\])\.input_schema\.properties\.([^.{}[\]]+)\{\+([^,{}]+)\}$/

/**
 * True when a `shape` difference is exactly one {@link SCHEMA_ADDITIONS} entry:
 * the tool at that path has the entry's name, the property gained only that
 * key, the key was absent before, and its new value is the entry's value.
 *
 * @param path - The `shape` path from {@link leafDiff}.
 * @param before - The merge-base golden.
 * @param after - The current golden.
 * @param additions - The allowlist (a test passes its own).
 * @returns Whether the difference is allowed.
 */
export function isAllowedAddition(
  path: string,
  before: unknown,
  after: unknown,
  additions: readonly SchemaAddition[] = SCHEMA_ADDITIONS,
): boolean {
  const m = ADDED_PROPERTY_KEY.exec(path)
  if (!m) return false
  const [, toolPath, property, key] = m as unknown as [string, string, string, string]
  const toolBefore = atPath(before, toolPath) as { name?: unknown } | undefined
  const toolAfter = atPath(after, toolPath) as { name?: unknown } | undefined
  if (toolBefore?.name !== toolAfter?.name) return false
  const entry = additions.find(
    (a) => a.tool === toolAfter?.name && a.property === property && a.key === key,
  )
  if (!entry) return false
  const propBefore = atPath(before, `${toolPath}.input_schema.properties.${property}`)
  const propAfter = atPath(after, `${toolPath}.input_schema.properties.${property}`)
  if (!propBefore || !propAfter || typeof propBefore !== "object" || typeof propAfter !== "object")
    return false
  if (Object.hasOwn(propBefore, key)) return false
  const { [key]: added, ...rest } = propAfter as Record<string, unknown>
  // The rest of the property must be unchanged, except prose. Walk it as the
  // golden walk does (same key and tag names), so a reworded description is
  // prose here too, and a changed `<ma::...>` tag is still a problem.
  const restDiffs = leafDiff(propBefore, rest, "$", property, maTagNames(before))
  if (restDiffs.some((d) => d.kind !== "string")) return false
  return JSON.stringify(added) === JSON.stringify(entry.value)
}

/** The trailing mode stamp of a tool_result, with the blank line before it. */
const MODE_STAMP = /\n\n<ma::agent::mode-active [^<>]*\/>$/

/**
 * Why a change of a {@link PROSE_LEAVES} leaf is not allowed, or null when it
 * is. Both sides must end with the mode stamp, the stamp must be
 * byte-identical, and the part before it must keep the same `<ma::...>` tags.
 *
 * @param before - The merge-base text.
 * @param after - The current text.
 * @returns A reason, or null.
 */
export function proseLeafProblem(before: unknown, after: unknown): string | null {
  if (typeof before !== "string" || typeof after !== "string") return "not a string"
  const stampA = MODE_STAMP.exec(before)?.[0]
  const stampB = MODE_STAMP.exec(after)?.[0]
  if (stampA === undefined || stampB === undefined) return "no trailing mode-active stamp"
  if (stampA !== stampB) return "the mode-active stamp changed"
  const proseA = before.slice(0, before.length - stampA.length)
  const proseB = after.slice(0, after.length - stampB.length)
  if (maTags(proseA).join("\u0000") !== maTags(proseB).join("\u0000"))
    return "a <ma::...> tag changed"
  return null
}

/**
 * Read a value at a path that {@link leafDiff} wrote (`$.a[0].b`).
 *
 * @param value - The root.
 * @param path - The path.
 * @returns The value, or undefined.
 */
function atPath(value: unknown, path: string): unknown {
  let node = value
  for (const part of path.replace(/^\$/, "").match(/\.[^.[\]]+|\[\d+\]/g) ?? []) {
    if (node === null || typeof node !== "object") return undefined
    const key = part.startsWith("[") ? Number(part.slice(1, -1)) : part.slice(1)
    node = (node as Record<string | number, unknown>)[key]
  }
  return node
}

/**
 * Every problem of one golden against its merge-base version: each `shape`,
 * `value` and `tag` difference that no {@link PROSE_LEAVES} entry allows, and
 * a changed contract-leaf list ({@link contractLeaves}).
 *
 * @param name - Golden file name.
 * @param before - The merge-base golden.
 * @param after - The current golden.
 * @param leaves - The allowlist (a test passes its own).
 * @returns One line per problem. Empty when the golden is clean.
 */
export function goldenProblems(
  name: string,
  before: unknown,
  after: unknown,
  leaves: readonly ProseLeaf[] = PROSE_LEAVES,
  additions: readonly SchemaAddition[] = SCHEMA_ADDITIONS,
): string[] {
  const out: string[] = []
  for (const d of leafDiff(before, after)) {
    if (d.kind === "string") continue
    if (d.kind === "shape" && isAllowedAddition(d.path, before, after, additions)) continue
    const listed = leaves.some((leaf) => leaf.golden === name && leaf.path === d.path)
    if (listed && d.kind === "value") {
      const problem = proseLeafProblem(atPath(before, d.path), atPath(after, d.path))
      if (problem === null) continue
      out.push(`prose-leaf ${d.path}: ${problem}`)
      continue
    }
    out.push(`${d.kind} ${d.path}`)
  }
  return [...out, ...contractProblems(before, after)]
}

/**
 * The {@link contractLeaves} lines that differ: `contract -line` for a line
 * that is gone, `contract +line` for a new line, or `contract order changed`.
 *
 * @param before - The merge-base golden.
 * @param after - The current golden.
 * @returns One line per difference. Empty when the lists are equal.
 */
export function contractProblems(before: unknown, after: unknown): string[] {
  const contractA = contractLeaves(before)
  const contractB = contractLeaves(after)
  if (contractA.join("\n") === contractB.join("\n")) return []
  const a = new Set(contractA)
  const b = new Set(contractB)
  const out = [
    ...contractA.filter((line) => !b.has(line)).map((line) => `contract -${line}`),
    ...contractB.filter((line) => !a.has(line)).map((line) => `contract +${line}`),
  ]
  return out.length > 0 ? out : ["contract order changed"]
}

describe("golden leaf diff against the merge base", () => {
  if (MERGE_BASE === null) {
    test("skipped: no merge base with origin/main", () => {
      console.warn("[ste-golden-shape] no merge base with origin/main: the leaf diff is off")
    })
    return
  }

  test("no golden was deleted since the merge base", () => {
    const now = new Set(GOLDENS)
    expect([...BASE_GOLDENS].filter((name) => !now.has(name))).toEqual([])
    const added = GOLDENS.filter((name) => !BASE_GOLDENS.has(name))
    if (added.length > 0)
      console.log(`[ste-golden-shape] new goldens, not compared: ${added.join(", ")}`)
  })

  for (const name of GOLDENS) {
    if (!BASE_GOLDENS.has(name)) continue
    test(`${name}: only description and text strings changed`, () => {
      expect(goldenProblems(name, baseGolden(name), currentGolden(name)).slice(0, 20)).toEqual([])
    })
  }
})

describe("golden leaf diff: rules", () => {
  const base = {
    tools: [
      {
        name: "Bash",
        description: "Run a command.",
        input_schema: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["a", "b"], description: "The mode." },
            description: { type: "string", description: "A param named description." },
          },
          required: ["mode"],
        },
      },
    ],
    system: [{ type: "text", text: "Hello." }],
    max_tokens: 10,
  }
  const clone = (): typeof base => structuredClone(base)

  test("a changed description or text is allowed", () => {
    const after = clone()
    const tool = after.tools[0]
    if (!tool) throw new Error("fixture")
    tool.description = "Run a shell command."
    tool.input_schema.properties.mode.description = "The run mode."
    const sys = after.system[0]
    if (sys) sys.text = "Hi."
    expect(leafDiff(base, after).map((d) => d.kind)).toEqual(["string", "string", "string"])
    expect(forbiddenDiffs(base, after)).toEqual([])
  })

  const CASES: ReadonlyArray<readonly [string, (v: ReturnType<typeof clone>) => void, string]> = [
    [
      "a changed tool name",
      (v) => Object.assign(v.tools[0] ?? {}, { name: "Shell" }),
      "value $.tools[0].name",
    ],
    [
      "a changed enum value",
      (v) => {
        v.tools[0]?.input_schema.properties.mode.enum.splice(1, 1, "c")
      },
      "value $.tools[0].input_schema.properties.mode.enum[1]",
    ],
    [
      "a dropped enum value",
      (v) => {
        v.tools[0]?.input_schema.properties.mode.enum.pop()
      },
      "shape $.tools[0].input_schema.properties.mode.enum.length",
    ],
    [
      "a changed required entry",
      (v) => {
        v.tools[0]?.input_schema.required.splice(0, 1, "x")
      },
      "value $.tools[0].input_schema.required[0]",
    ],
    [
      "a dropped param",
      (v) => {
        const props = v.tools[0]?.input_schema.properties as Record<string, unknown>
        delete props.mode
      },
      "shape $.tools[0].input_schema.properties{-mode}",
    ],
    ["a changed number", (v) => Object.assign(v, { max_tokens: 11 }), "value $.max_tokens"],
    [
      "a string description turned into an object",
      (v) => Object.assign(v.tools[0] ?? {}, { description: { x: 1 } }),
      "shape $.tools[0].description",
    ],
    [
      "a changed type string",
      (v) => Object.assign(v.system[0] ?? {}, { type: "image" }),
      "value $.system[0].type",
    ],
  ]

  for (const [label, mutate, expected] of CASES) {
    test(`fails on ${label}`, () => {
      const after = clone()
      mutate(after)
      expect(forbiddenDiffs(base, after).map((d) => `${d.kind} ${d.path}`)).toEqual([expected])
    })
  }

  test("the contract leaves list tool names, enums and required", () => {
    expect(contractLeaves(base)).toEqual([
      "$.tools[0].name=Bash",
      '$.tools[0].input_schema.required=["mode"]',
      '$.tools[0].input_schema.properties.mode.enum=["a","b"]',
    ])
  })
})

describe("golden leaf diff: mutation proof on a real golden (temp copy)", () => {
  test("a changed enum in a temp copy of a real golden fails the comparator", () => {
    const name = "plugin-handler-throws.json"
    const dir = mkdtempSync(join(tmpdir(), "golden-shape-"))
    try {
      const copy = join(dir, name)
      copyFileSync(join(PLUGINS_ROOT, GOLDEN_DIR, name), copy)
      const original = JSON.parse(readFileSync(copy, "utf8")) as unknown
      // Change the first enum value found, in the copy only.
      const raw = readFileSync(copy, "utf8")
      const mutated = raw.replace(/("enum": \[\s*")([^"]+)"/, '$1$2-MUTATED"')
      expect(mutated).not.toBe(raw)
      writeFileSync(copy, mutated)
      const after = JSON.parse(readFileSync(copy, "utf8")) as unknown
      const forbidden = forbiddenDiffs(original, after)
      expect(forbidden).toHaveLength(1)
      expect(forbidden[0]?.kind).toBe("value")
      expect(forbidden[0]?.path).toMatch(/\.enum\[0\]$/)
      expect(contractLeaves(after)).not.toEqual(contractLeaves(original))

      // A changed description in the same copy is allowed.
      const prose = raw.replace(/("description": ")((?:[^"\\]|\\.)*)"/, '$1$2 More."')
      expect(prose).not.toBe(raw)
      expect(forbiddenDiffs(original, JSON.parse(prose) as unknown)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("golden leaf diff: protocol tags in prose (review C M6)", () => {
  test("maTags reads every tag with its attributes, in order", () => {
    expect(
      maTags('A <ma::agent::turn-aborted /> b <ma::x::y k="v">c</ma::x::y> `<ma::emit::memory>`.'),
    ).toEqual([
      "<ma::agent::turn-aborted />",
      '<ma::x::y k="v">',
      "</ma::x::y>",
      "<ma::emit::memory>",
    ])
    expect(maTagName('<ma::agent::mode-active id="ask" />')).toBe("ma::agent::mode-active")
    expect(maTagName("</ma::sys::tool>")).toBe("ma::sys::tool")
  })

  const text = (t: string): unknown => ({ messages: [{ content: [{ type: "text", text: t }] }] })
  const desc = (d: string): unknown => ({ tools: [{ name: "T", description: d }] })
  const kinds = (a: unknown, b: unknown): string[] => leafDiff(a, b).map((d) => d.kind)

  test("text: new words with the same tags is allowed", () => {
    expect(
      kinds(text("Stop. <ma::agent::turn-aborted />"), text("Halt. <ma::agent::turn-aborted />")),
    ).toEqual(["string"])
  })

  test("text: a renamed, dropped, added, reordered or re-attributed tag fails", () => {
    const base = 'A <ma::agent::turn-aborted /> b <ma::agent::mode-active id="ask" />'
    for (const changed of [
      'A <ma::agent::turn-ABORTED-RENAMED /> b <ma::agent::mode-active id="ask" />',
      'A b <ma::agent::mode-active id="ask" />',
      'A <ma::agent::turn-aborted /> <ma::agent::turn-aborted /> b <ma::agent::mode-active id="ask" />',
      'A <ma::agent::mode-active id="ask" /> b <ma::agent::turn-aborted />',
      'A <ma::agent::turn-aborted /> b <ma::agent::mode-active id="default" />',
    ]) {
      expect(kinds(text(base), text(changed)), changed).toEqual(["tag"])
      expect(forbiddenDiffs(text(base), text(changed)), changed).toHaveLength(1)
    }
  })

  test("description: a tag mention may move, but a tag name must be known", () => {
    const base = {
      tools: [{ name: "T", description: "See `<ma::agent::raw-output />`." }],
      system: [{ type: "text", text: "<ma::emit::memory>" }],
    }
    // Dropping a mention, or naming a tag that the golden uses, is prose.
    const dropped = structuredClone(base)
    dropped.tools[0] = { name: "T", description: "See the blob path." }
    expect(forbiddenDiffs(base, dropped)).toEqual([])
    const moved = structuredClone(base)
    moved.tools[0] = { name: "T", description: "Use `<ma::emit::memory>`." }
    expect(forbiddenDiffs(base, moved)).toEqual([])
    // A renamed tag is not.
    const renamed = structuredClone(base)
    renamed.tools[0] = { name: "T", description: "See `<ma::agent::raw-OUTPUT />`." }
    expect(forbiddenDiffs(base, renamed).map((d) => `${d.kind} ${d.path}`)).toEqual([
      "tag $.tools[0].description",
    ])
    // A DESCRIPTION_TAGS name is allowed.
    expect(kinds(desc("x"), desc("A `<ma::agent::memory-saved>` tag."))).toEqual(["string"])
  })

  test("every DESCRIPTION_TAGS entry is rendered by its source file", () => {
    for (const entry of DESCRIPTION_TAGS) {
      const source = readFileSync(join(PLUGINS_ROOT, entry.source), "utf8")
      expect(source.includes(`<${entry.tag}`), entry.source).toBe(true)
      expect(entry.reason.length).toBeGreaterThan(10)
    }
  })
})

describe("golden leaf diff: PROSE_LEAVES and goldenProblems (review C M6)", () => {
  const STAMP = '\n\n<ma::agent::mode-active id="ask" since="2026-01-02T03:04:05.000Z" />'
  const golden = (first: string, second: string, maxTokens = 10): unknown => ({
    requests: [
      {
        max_tokens: maxTokens,
        tools: [{ name: "Edit", input_schema: { required: ["path"] } }],
        messages: [
          { role: "user", content: [{ type: "tool_result", content: second }] },
          { role: "assistant", content: [{ type: "text", text: "ok" }] },
          { role: "user", content: [{ type: "tool_result", content: first }] },
        ],
      },
    ],
  })
  const LISTED = "$.requests[0].messages[2].content[0].content"
  const OTHER = "$.requests[0].messages[0].content[0].content"
  const leaves: readonly ProseLeaf[] = [{ golden: "g.json", path: LISTED, source: "test" }]
  const base = golden(`Not allowed.${STAMP}`, `Other.${STAMP}`)

  test("proseLeafProblem: words before the stamp may change, the stamp may not", () => {
    expect(proseLeafProblem(`Not allowed.${STAMP}`, `Refused.${STAMP}`)).toBeNull()
    expect(
      proseLeafProblem(
        `Not allowed.${STAMP}`,
        `Not allowed.${STAMP.replace('"ask"', '"default"')}`,
      ),
    ).toBe("the mode-active stamp changed")
    expect(proseLeafProblem(`Not allowed.${STAMP}`, "Not allowed.")).toBe(
      "no trailing mode-active stamp",
    )
    // The blank line before the stamp is part of the stamp.
    expect(
      proseLeafProblem(`Not allowed.${STAMP}`, `Not allowed.${STAMP.replace("\n\n", " ")}`),
    ).toBe("no trailing mode-active stamp")
    expect(proseLeafProblem(`Not allowed.${STAMP}`, `Not allowed.${STAMP} `)).toBe(
      "no trailing mode-active stamp",
    )
    expect(
      proseLeafProblem(`Not allowed.${STAMP}`, `Not <ma::agent::turn-aborted /> allowed.${STAMP}`),
    ).toBe("a <ma::...> tag changed")
    expect(proseLeafProblem(1, `x${STAMP}`)).toBe("not a string")
  })

  test("the listed leaf may change its words, in the listed golden only", () => {
    const after = golden(`Refused.${STAMP}`, `Other.${STAMP}`)
    expect(goldenProblems("g.json", base, after, leaves)).toEqual([])
    // Kills "allowlist any golden": the same path in another golden fails.
    expect(goldenProblems("h.json", base, after, leaves)).toEqual([`value ${LISTED}`])
    // Without the entry it fails too.
    expect(goldenProblems("g.json", base, after, [])).toEqual([`value ${LISTED}`])
  })

  test("kills 'allowlist any path': an unlisted leaf of the listed golden fails", () => {
    // The unlisted leaf has the same shape (words + stamp), so only the path
    // check can stop it.
    const after = golden(`Not allowed.${STAMP}`, `Changed.${STAMP}`)
    expect(goldenProblems("g.json", base, after, leaves)).toEqual([`value ${OTHER}`])
  })

  test("kills 'allowlist any value': a listed leaf with a changed stamp fails", () => {
    const after = golden(`Refused.${STAMP.replace('"ask"', '"default"')}`, `Other.${STAMP}`)
    expect(goldenProblems("g.json", base, after, leaves)).toEqual([
      `prose-leaf ${LISTED}: the mode-active stamp changed`,
    ])
    const number = golden(`Not allowed.${STAMP}`, `Other.${STAMP}`, 11)
    expect(goldenProblems("g.json", base, number, leaves)).toEqual([
      "value $.requests[0].max_tokens",
    ])
  })

  test("kills 'contractLeaves check dropped': a renamed tool gives the contract lines", () => {
    const after = structuredClone(base) as { requests: Array<{ tools: Array<{ name: string }> }> }
    const tool = after.requests[0]?.tools[0]
    if (!tool) throw new Error("fixture")
    tool.name = "Write"
    expect(goldenProblems("g.json", base, after, leaves)).toEqual([
      "value $.requests[0].tools[0].name",
      "contract -$.requests[0].tools[0].name=Edit",
      "contract +$.requests[0].tools[0].name=Write",
    ])
    expect(contractProblems(base, base)).toEqual([])
    // Same set, other order.
    const two = { tools: [{ name: "A" }, { name: "B" }] }
    const swapped = { tools: [{ name: "B" }, { name: "A" }] }
    expect(contractProblems(two, swapped)).toEqual([
      "contract -$.tools[0].name=A",
      "contract -$.tools[1].name=B",
      "contract +$.tools[0].name=B",
      "contract +$.tools[1].name=A",
    ])
  })

  test("every PROSE_LEAVES path holds a stamped string in its golden today", () => {
    for (const leaf of PROSE_LEAVES) {
      const value = JSON.parse(readFileSync(join(PLUGINS_ROOT, GOLDEN_DIR, leaf.golden), "utf8"))
      const node = leaf.path
        .replace(/^\$/, "")
        .match(/\.[^.[\]]+|\[\d+\]/g)
        ?.reduce<unknown>(
          (n, part) =>
            (n as Record<string, unknown>)[
              part.startsWith("[") ? part.slice(1, -1) : part.slice(1)
            ],
          value,
        )
      expect(typeof node, leaf.path).toBe("string")
      expect(proseLeafProblem(node, node), `${leaf.golden} ${leaf.path}`).toBeNull()
    }
  })
})

describe("golden leaf diff: M6 mutation proof on real goldens (temp copy)", () => {
  /**
   * Copy a real golden, change the copy with `edit`, and return the problems
   * of the copy against the original.
   */
  const probe = (name: string, edit: (raw: string) => string): string[] => {
    const dir = mkdtempSync(join(tmpdir(), "golden-m6-"))
    try {
      const copy = join(dir, name)
      copyFileSync(join(PLUGINS_ROOT, GOLDEN_DIR, name), copy)
      const raw = readFileSync(copy, "utf8")
      const mutated = edit(raw)
      expect(mutated).not.toBe(raw)
      writeFileSync(copy, mutated)
      return goldenProblems(name, JSON.parse(raw), JSON.parse(readFileSync(copy, "utf8")))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test("a renamed <ma::agent::turn-aborted /> in abort-mid-tool.json fails", () => {
    const problems = probe("abort-mid-tool.json", (raw) =>
      raw.replace("<ma::agent::turn-aborted />", "<ma::agent::turn-ABORTED-RENAMED />"),
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/^tag \$\.requests\[\d+\]\.messages\[\d+\]\.content\[\d+\]\.text$/)
  })

  test("a changed mode-active stamp in a PROSE_LEAVES leaf fails, new words pass", () => {
    const name = "ask-mode-edit-allowed-today.json"
    const stamp = probe(name, (raw) =>
      raw.replace(
        /(is not permitted in ASK mode\.[^"]*<ma::agent::mode-active id=\\")ask/,
        "$1default",
      ),
    )
    expect(stamp).toEqual([
      "prose-leaf $.requests[0].messages[2].content[0].content: the mode-active stamp changed",
    ])
    const words = probe(name, (raw) =>
      raw.replace("is not permitted in ASK mode.", "is not allowed in ASK mode."),
    )
    expect(words).toEqual([])
  })
})

describe("golden leaf diff: SCHEMA_ADDITIONS (intended Task schema change)", () => {
  /** A golden with one Task tool and one other tool, like the real request goldens. */
  const golden = (task: Record<string, unknown>, other: Record<string, unknown>) => ({
    requests: [
      {
        tools: [
          { name: "Other", input_schema: { type: "object", properties: other } },
          { name: "Task", input_schema: { type: "object", properties: task } },
        ],
      },
    ],
  })
  const ID = { description: "The task id." }
  const ORDER = { type: "array", description: "The ids." }
  const before = golden({ id: ID, order: ORDER }, { id: ID, order: ORDER })
  const typedId = { ...ID, type: ["string", "integer"] }
  const typedOrder = { ...ORDER, items: { type: ["string", "integer"] } }

  test("the exact listed additions on Task pass", () => {
    const after = golden({ id: typedId, order: typedOrder }, { id: ID, order: ORDER })
    expect(goldenProblems("g.json", before, after)).toEqual([])
  })

  test("kills 'any key': another added key at a listed property fails", () => {
    const after = golden({ id: { ...ID, minimum: 1 }, order: ORDER }, { id: ID, order: ORDER })
    expect(goldenProblems("g.json", before, after)).toEqual([
      "shape $.requests[0].tools[1].input_schema.properties.id{+minimum}",
    ])
  })

  test("kills 'any value': the listed key with another value fails", () => {
    const after = golden({ id: { ...ID, type: "string" }, order: ORDER }, { id: ID, order: ORDER })
    expect(goldenProblems("g.json", before, after)).toEqual([
      "shape $.requests[0].tools[1].input_schema.properties.id{+type}",
    ])
  })

  test("kills 'any tool': the same addition on another tool fails", () => {
    const after = golden({ id: ID, order: ORDER }, { id: typedId, order: ORDER })
    expect(goldenProblems("g.json", before, after)).toEqual([
      "shape $.requests[0].tools[0].input_schema.properties.id{+type}",
    ])
  })

  test("kills 'hides other changes': an addition plus a changed non-prose leaf fails", () => {
    const after = golden(
      { id: typedId, order: { ...typedOrder, minItems: 1 } },
      { id: ID, order: ORDER },
    )
    expect(goldenProblems("g.json", before, after)).toEqual([
      "shape $.requests[0].tools[1].input_schema.properties.order{+items,+minItems}",
    ])
  })

  test("a Task description change still follows the prose rules", () => {
    const reworded = { description: "The id of the task." }
    const after = golden(
      { id: { ...reworded, type: ["string", "integer"] }, order: ORDER },
      {
        id: ID,
        order: ORDER,
      },
    )
    expect(goldenProblems("g.json", before, after)).toEqual([])
    const tagged = { description: "The id. <ma::agent::invented-tag />" }
    const bad = golden(
      { id: { ...tagged, type: ["string", "integer"] }, order: ORDER },
      {
        id: ID,
        order: ORDER,
      },
    )
    // An unknown tag in the description: the addition is not allowed, so the
    // shape difference is reported (the prose rule still applies).
    expect(goldenProblems("g.json", before, bad)).toEqual([
      "shape $.requests[0].tools[1].input_schema.properties.id{+type}",
    ])
    expect(
      isAllowedAddition("$.requests[0].tools[1].input_schema.properties.id{+type}", before, bad),
    ).toBe(false)
  })

  test("with no allowlist, the same change fails (the entry is what allows it)", () => {
    const after = golden({ id: typedId, order: typedOrder }, { id: ID, order: ORDER })
    expect(goldenProblems("g.json", before, after, PROSE_LEAVES, []).length).toBe(2)
  })
})
