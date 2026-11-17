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
   * non-prose leaf differs. `string`: a prose leaf differs (allowed).
   */
  kind: "shape" | "value" | "string"
  /** The key of the leaf. An array item takes the key of its array. */
  key: string
}

/**
 * Compare two JSON values leaf by leaf.
 *
 * @param before - The merge-base value.
 * @param after - The current value.
 * @param path - JSON path of the values.
 * @param key - Key of the values (an array item keeps its array key).
 * @returns Every difference, in walk order.
 */
export function leafDiff(before: unknown, after: unknown, path = "$", key = ""): LeafDiff[] {
  const typeOf = (v: unknown): string =>
    v === null ? "null" : Array.isArray(v) ? "array" : typeof v
  if (typeOf(before) !== typeOf(after)) return [{ path, kind: "shape", key }]
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) return [{ path: `${path}.length`, kind: "shape", key }]
    return before.flatMap((item, i) => leafDiff(item, after[i], `${path}[${i}]`, key))
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
    return keysA.flatMap((k) => leafDiff(a[k], b[k], `${path}.${k}`, k))
  }
  if (before === after) return []
  if (typeof before === "string" && PROSE_KEYS.has(key)) return [{ path, kind: "string", key }]
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
      const before = baseGolden(name)
      const after = currentGolden(name)
      const diffs = leafDiff(before, after)
      const forbidden = diffs.filter((d) => d.kind !== "string")
      expect(forbidden.slice(0, 20).map((d) => `${d.kind} ${d.path}`)).toEqual([])
      expect(contractLeaves(after)).toEqual(contractLeaves(before))
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
