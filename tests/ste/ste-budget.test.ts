/**
 * The tool block word budget, as a test.
 *
 * The budget itself lives in `tool-budget.ts` so a script can read it without
 * starting the test runner. This file only asserts it. Every count comes from
 * `budgetWords` (raw whitespace split, R3 bug B8).
 *
 * @module tests/ste/ste-budget.test
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { beforeAll, describe, expect, test } from "bun:test"

import type { SidebandApi } from "@minimal-agent/core/host/sideband"

import { pluginSideband } from "../support/sideband.ts"

import { historyRefs, showAt } from "./ratchet.ts"
import { renderDescriptions } from "./render.ts"
import { PLUGINS_ROOT } from "./surfaces.ts"
import {
  BLOCK_RAISES,
  blockWords,
  budgetFloor,
  budgetWords,
  descriptionStrings,
  descriptionTexts,
  GOLDEN,
  goldenTools,
  LOOSE_WORDS,
  MAX_DESCRIPTION_CHARS,
  PER_TOOL_LOOSE,
  parseToolWords,
  RAISES,
  type ShippedTool,
  shippedTools,
  TARGET,
  TOOL_BLOCK_WORDS,
  TOOL_WORDS,
  type ToolText,
  toolWords,
  unloggedRaises,
  unmeasuredTools,
} from "./tool-budget.ts"
import { BUILTIN_TOOLS, wireToolNames } from "./tool-names.ts"

/**
 * Tools over their entry.
 *
 * @param tools - Measured tools.
 * @param entries - The per-tool map.
 * @returns One line per tool over its entry.
 */
function overEntry(
  tools: readonly ToolText[],
  entries: Readonly<Record<string, number>>,
): string[] {
  return tools
    .filter((t) => entries[t.name] !== undefined && t.words > (entries[t.name] ?? 0))
    .map((t) => `${t.name}: ${t.words} words > entry ${entries[t.name]}`)
}

/**
 * Entries more than {@link PER_TOOL_LOOSE} above their tool.
 *
 * @param tools - Measured tools.
 * @param entries - The per-tool map.
 * @returns One line per loose entry.
 */
function looseEntry(
  tools: readonly ToolText[],
  entries: Readonly<Record<string, number>>,
): string[] {
  return tools
    .filter((t) => (entries[t.name] ?? t.words) - t.words > PER_TOOL_LOOSE)
    .map(
      (t) =>
        `${t.name}: entry ${entries[t.name]} is ${(entries[t.name] ?? 0) - t.words} above ${t.words}. Lower it.`,
    )
}

/** The repo path of the budget file. */
const BUDGET_REL = "tests/ste/tool-budget.ts"

/**
 * Every committed copy of `tool-budget.ts` that the working copy must not go
 * above ({@link historyRefs}: HEAD, the pushed branch, the merge base and each
 * branch commit that changed it).
 */
function budgetSources(): string[] {
  return historyRefs(BUDGET_REL)
    .map((ref) => showAt(ref, BUDGET_REL))
    .filter((text): text is string => text !== undefined)
}

describe("tool block word budget", () => {
  const tools = toolWords()
  const total = blockWords(tools)

  test("the golden yields the shipped tool block", () => {
    expect(tools.length).toBeGreaterThan(40)
    expect(tools.some((tool) => tool.name === "Bash")).toBe(true)
    expect(tools.some((tool) => tool.name === "FixtureThrow")).toBe(false)
  })

  test("the block total counts only the golden tools (a default lead request)", () => {
    const golden = tools.filter((t) => t.source === "golden")
    expect(total).toBe(golden.reduce((sum, t) => sum + t.words, 0))
    expect(golden.length).toBe(goldenTools().length)
    expect(golden.length).toBeLessThan(tools.length)
  })

  test("the total tool block is within budget", () => {
    expect(total, `total ${total} > budget ${TOOL_BLOCK_WORDS}`).toBeLessThanOrEqual(
      TOOL_BLOCK_WORDS,
    )
  })

  test("the budget is not loose", () => {
    // A budget far above the real count lets the text grow back. When the tree
    // is well under, lower the constant.
    expect(
      TOOL_BLOCK_WORDS - total,
      `the tree is ${TOOL_BLOCK_WORDS - total} words under budget. Lower TOOL_BLOCK_WORDS.`,
    ).toBeLessThanOrEqual(LOOSE_WORDS)
  })

  test("the constants are the agreed values", () => {
    expect(LOOSE_WORDS).toBe(50)
    expect(PER_TOOL_LOOSE).toBe(10)
    expect(TARGET.words).toBe(250)
    expect(TARGET.owner.length).toBeGreaterThan(0)
  })

  test("budgetWords is a raw whitespace split", () => {
    expect(budgetWords("")).toBe(0)
    expect(budgetWords("  Run `git status --short` now.\n")).toBe(5)
    expect(budgetWords("See https://x.io/a/b and ~/a/b.")).toBe(4)
  })
})

describe("per-tool budget (TOOL_WORDS)", () => {
  const tools = toolWords()

  test("every shipped tool has an entry", () => {
    expect(tools.filter((t) => TOOL_WORDS[t.name] === undefined).map((t) => t.name)).toEqual([])
  })

  test("every entry is a shipped tool", () => {
    const shipped = new Set(tools.map((t) => t.name))
    expect(Object.keys(TOOL_WORDS).filter((name) => !shipped.has(name))).toEqual([])
  })

  test("no tool is over its entry", () => {
    expect(overEntry(tools, TOOL_WORDS)).toEqual([])
  })

  test("no entry is loose", () => {
    expect(looseEntry(tools, TOOL_WORDS)).toEqual([])
  })

  test("every RAISES row is well formed", () => {
    for (const raise of RAISES) {
      expect(TOOL_WORDS[raise.tool], `${raise.tool} is not in TOOL_WORDS`).toBeDefined()
      expect(raise.to).toBeGreaterThan(raise.from)
      expect(raise.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(raise.reason.trim().length).toBeGreaterThanOrEqual(10)
    }
  })

  test("an entry above its lowest committed value has a RAISES row (REVIEW-C2 W1)", () => {
    // Before the first landing the merge base has no map, so the floor comes
    // from HEAD, the pushed branch and each branch commit that changed the
    // file. This test is never off: HEAD always has the map.
    const floor = budgetFloor(budgetSources())
    expect(Object.keys(floor.perTool).length).toBeGreaterThan(0)
    expect(unloggedRaises(TOOL_WORDS, floor.perTool, RAISES)).toEqual([])
  })

  test("TOOL_BLOCK_WORDS above its lowest committed value has a BLOCK_RAISES row", () => {
    const floor = budgetFloor(budgetSources())
    expect(floor.block).not.toBeNull()
    const from = floor.block ?? 0
    if (TOOL_BLOCK_WORDS <= from) return
    const logged = BLOCK_RAISES.some(
      (r) => r.from <= from && r.to >= TOOL_BLOCK_WORDS && r.reason.trim().length >= 10,
    )
    expect(logged, `TOOL_BLOCK_WORDS ${from} -> ${TOOL_BLOCK_WORDS} has no BLOCK_RAISES row`).toBe(
      true,
    )
  })
})

describe("per-tool budget: mutation proof", () => {
  const tools = toolWords()

  test("a tool that grows by one word fails", () => {
    // Pin each tool at its entry, then grow one: only that tool fails.
    const atEntry = tools.map((t) => ({ ...t, words: TOOL_WORDS[t.name] ?? t.words }))
    const grown = atEntry.map((t) => (t.name === "Bash" ? { ...t, words: t.words + 1 } : t))
    expect(overEntry(atEntry, TOOL_WORDS)).toEqual([])
    expect(overEntry(grown, TOOL_WORDS)).toEqual([
      `Bash: ${(TOOL_WORDS.Bash ?? 0) + 1} words > entry ${TOOL_WORDS.Bash}`,
    ])
  })

  test("an entry 11 words above its tool fails, 10 passes", () => {
    const at10 = { ...TOOL_WORDS, Edit: (TOOL_WORDS.Edit ?? 0) + 10 }
    const at11 = { ...TOOL_WORDS, Edit: (TOOL_WORDS.Edit ?? 0) + 11 }
    expect(looseEntry(tools, at10)).toEqual([])
    expect(looseEntry(tools, at11)).toHaveLength(1)
  })

  test("a raise without a row fails, with a matching row passes", () => {
    const base = { Bash: 386, Task: 562 }
    const raised = { Bash: 400, Task: 562 }
    expect(unloggedRaises(raised, base, [])).toEqual([
      "Bash: 386 -> 400 has no RAISES row with a reason",
    ])
    const row = {
      tool: "Bash",
      from: 386,
      to: 400,
      date: "2026-11-17",
      reason: "STE s21: The tool gives",
    }
    expect(unloggedRaises(raised, base, [row])).toEqual([])
    // A row with other numbers does not cover the raise.
    expect(unloggedRaises(raised, base, [{ ...row, to: 399 }])).toHaveLength(1)
    // A lowered entry and a new tool need no row.
    expect(unloggedRaises({ Bash: 300, New: 50 }, base, [])).toEqual([])
  })

  test("budgetFloor takes the lowest entry and total over the copies", () => {
    const a =
      "export const TOOL_BLOCK_WORDS = 7000\nexport const TOOL_WORDS = {\n  Bash: 120,\n  Read: 90,\n}"
    const b =
      "export const TOOL_BLOCK_WORDS = 6800\nexport const TOOL_WORDS = {\n  Bash: 117,\n  Read: 95,\n}"
    const old = "export const PER_TOOL_MAX = 751"
    expect(budgetFloor([a, b, old])).toEqual({ perTool: { Bash: 117, Read: 90 }, block: 6800 })
    // A raise from the floor needs a row that covers the whole raise.
    const floor = budgetFloor([a, b]).perTool
    expect(unloggedRaises({ Bash: 131, Read: 90 }, floor, [])).toEqual([
      "Bash: 117 -> 131 has no RAISES row with a reason",
    ])
    const row = {
      tool: "Bash",
      from: 115,
      to: 131,
      date: "2026-11-17",
      reason: "a needed fact here",
    }
    expect(unloggedRaises({ Bash: 131, Read: 90 }, floor, [row])).toEqual([])
  })

  test("parseToolWords reads this file and reads null from an old file", () => {
    const source = `export const TOOL_WORDS: Readonly<Record<string, number>> = {\n  Bash: 386,\n  "Task": 562,\n}`
    expect(parseToolWords(source)).toEqual({ Bash: 386, Task: 562 })
    expect(parseToolWords("export const PER_TOOL_MAX = 751")).toBeNull()
  })
})

/** The 5 tools that no golden has (review C B3). */
const MANIFEST_ONLY = [
  "CloudLogin",
  "CloudPush",
  "CloudStatus",
  "SecurityStatus",
  "SubAgentsReportResult",
] as const

/**
 * Make a temp plugins root with one plugin and an empty golden.
 *
 * @param tool - The `trigger.tool` block of the one manifest tool.
 * @returns The root, the golden path and a cleanup function.
 */
function tempRoot(tool: Record<string, unknown>): {
  root: string
  golden: string
  done: () => void
} {
  const root = mkdtempSync(join(tmpdir(), "ste-src-"))
  mkdirSync(join(root, "ma-probe-plugin"))
  writeFileSync(
    join(root, "ma-probe-plugin", "manifest.json"),
    JSON.stringify({
      name: "Probe",
      headless: { tools: [{ trigger: { type: "tool", tool } }] },
    }),
  )
  const golden = join(root, "golden.json")
  // The core `binary` param is read from the real golden.
  writeFileSync(golden, readFileSync(GOLDEN, "utf8"))
  return { root, golden, done: () => rmSync(root, { recursive: true, force: true }) }
}

describe("measurement source: the golden plus every manifest tool (review C B3)", () => {
  const tools = shippedTools()
  const byName = new Map(tools.map((t) => [t.name, t]))
  let sb: SidebandApi
  beforeAll(async () => {
    sb = await pluginSideband()
  })

  test("every manifest tool and every built-in is measured", () => {
    expect(unmeasuredTools(tools)).toEqual([])
    for (const name of BUILTIN_TOOLS) expect(byName.get(name)?.source, name).toBe("golden")
  })

  test("the 5 tools that no golden has come from their manifest", () => {
    const golden = new Set(goldenTools().map((t) => t.name))
    for (const name of MANIFEST_ONLY) {
      expect(golden.has(name), `${name} is now in the golden`).toBe(false)
      expect(byName.get(name)?.source, name).toBe("manifest")
    }
    expect(tools.filter((t) => t.source === "manifest").map((t) => t.name)).toEqual([
      ...MANIFEST_ONLY,
    ])
  })

  test("golden and manifest agree for every tool in both (core sends the manifest text as it is)", () => {
    // This proves that a manifest is a correct source for a tool that no
    // golden has. The one change that core makes is the `binary` param.
    const golden = new Map(goldenTools().map((t) => [t.name, t]))
    const canon = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(canon)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.keys(v as object)
                .sort()
                .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
            )
          : v
    const differ: string[] = []
    let compared = 0
    for (const entry of wireToolNames().entries) {
      const shipped = golden.get(entry.wire)
      if (!shipped) continue
      const manifest = JSON.parse(
        readFileSync(join(PLUGINS_ROOT, entry.plugin, "manifest.json"), "utf8"),
      ) as { headless?: { tools?: Array<{ trigger?: { tool?: Record<string, unknown> } }> } }
      const raw = manifest.headless?.tools?.find((h) => h.trigger?.tool?.name === entry.tool)
        ?.trigger?.tool
      if (!raw) {
        differ.push(`${entry.wire}: not found`)
        continue
      }
      // Core renders the `%%sideband:...%%` calls before it sends the text.
      const tool = renderDescriptions(raw, sb)
      const props = (shipped.input_schema as { properties?: Record<string, unknown> }).properties
      const schema = tool.mayReturnBinary
        ? {
            ...(tool.input_schema as object),
            properties: {
              ...((tool.input_schema as { properties?: object }).properties ?? {}),
              binary: props?.binary,
            },
          }
        : tool.input_schema
      compared += 1
      if (
        JSON.stringify(canon({ d: tool.description, s: schema })) !==
        JSON.stringify(canon({ d: shipped.description, s: shipped.input_schema }))
      )
        differ.push(entry.wire)
    }
    expect(differ).toEqual([])
    expect(compared).toBeGreaterThan(35)
  })

  test("mutation: a tool in neither source fails", () => {
    const without = tools.filter((t) => t.name !== "CloudPush")
    expect(unmeasuredTools(without)).toEqual(["CloudPush"])
    const noBash = tools.filter((t) => t.name !== "Bash")
    expect(unmeasuredTools(noBash)).toEqual(["Bash"])
  })

  test("mutation: a new manifest tool is measured, and one with no text is reported", () => {
    const ok = tempRoot({
      name: "Thing",
      description: "Do a thing.",
      input_schema: { type: "object", properties: {} },
      mayReturnBinary: true,
    })
    try {
      const got = shippedTools(ok.root, ok.golden)
      const probe = got.find((t) => t.name === "ProbeThing")
      expect(probe?.source).toBe("manifest")
      // The core `binary` param is added, as core does.
      const schema = probe?.input_schema as { properties: Record<string, unknown> } | undefined
      const props = schema?.properties ?? {}
      expect(Object.keys(props)).toEqual(["binary"])
      expect(unmeasuredTools(got, wireToolNames(ok.root).wire)).toEqual([])
    } finally {
      ok.done()
    }
    const bad = tempRoot({ name: "Thing", input_schema: { type: "object" } })
    try {
      const got = shippedTools(bad.root, bad.golden)
      expect(unmeasuredTools(got, wireToolNames(bad.root).wire)).toContain("ProbeThing")
    } finally {
      bad.done()
    }
  })
})

describe("description length cap (MAX_DESCRIPTION_CHARS)", () => {
  const texts = descriptionTexts()

  test("every shipped tool and param description is measured", () => {
    expect(texts.filter((t) => t.path === "description").length).toBe(toolWords().length)
    expect(texts.length).toBeGreaterThan(200)
    // A real nested `items` description is in the list (SubAgentsReportResult deliverables).
    expect(texts.some((t) => t.tool === "SubAgentsReportResult" && /\.items\./.test(t.path))).toBe(
      true,
    )
  })

  test("no tool or param description is longer than the cap", () => {
    const over = texts
      .filter((t) => t.chars > MAX_DESCRIPTION_CHARS)
      .map((t) => `${t.tool} ${t.path}: ${t.chars} chars`)
    expect(over).toEqual([])
  })

  test("the cap is the value the user set", () => {
    expect(MAX_DESCRIPTION_CHARS).toBe(500)
  })

  test("mutation: a planted long description is caught", () => {
    const rows = descriptionTexts([
      {
        name: "Probe",
        description: "x".repeat(MAX_DESCRIPTION_CHARS + 1),
        input_schema: {
          type: "object",
          properties: {
            a: { type: "string", description: "y".repeat(MAX_DESCRIPTION_CHARS) },
          },
        },
        source: "manifest",
      },
    ])
    expect(rows.map((r) => [r.path, r.chars > MAX_DESCRIPTION_CHARS])).toEqual([
      ["description", true],
      ["input_schema.properties.a", false],
    ])
  })

  test("mutation: a long description at any schema depth is caught", () => {
    const long = "z".repeat(MAX_DESCRIPTION_CHARS + 1)
    const tool: ShippedTool = {
      name: "Probe",
      description: "Short.",
      source: "manifest",
      input_schema: {
        type: "object",
        properties: {
          // A param NAMED description is an object: walk into it, do not count it.
          description: { type: "string", description: long },
          list: {
            type: "array",
            description: "Short.",
            items: {
              type: "array",
              items: { type: "object", properties: { deep: { description: long } } },
            },
          },
          any: { anyOf: [{ type: "string" }, { type: "number", description: long }] },
          one: { oneOf: [{ description: long }] },
          all: { allOf: [{ description: long }] },
          extra: { type: "object", additionalProperties: { description: long } },
        },
        $defs: { thing: { description: long } },
      },
    }
    const over = descriptionStrings(tool)
      .filter((d) => d.text.length > MAX_DESCRIPTION_CHARS)
      .map((d) => d.path)
    expect(over).toEqual([
      "input_schema.properties.description",
      "input_schema.properties.list.items.items.properties.deep",
      "input_schema.properties.any.anyOf[1]",
      "input_schema.properties.one.oneOf[0]",
      "input_schema.properties.all.allOf[0]",
      "input_schema.properties.extra.additionalProperties",
      "input_schema.$defs.thing",
    ])
    expect(descriptionTexts([tool]).filter((t) => t.chars > MAX_DESCRIPTION_CHARS)).toHaveLength(7)
  })

  test("mutation: the cap counts the RAW string, code spans included", () => {
    // 501 characters, most of them in code spans. With the spans masked or
    // dropped, the text is far below the cap. The model gets every character.
    const span = "`--flag-name` "
    let text = "Use "
    while (text.length + span.length <= MAX_DESCRIPTION_CHARS - 1) text += span
    text = `${text}${"x".repeat(MAX_DESCRIPTION_CHARS + 1 - text.length - 1)}.`
    expect(text.length).toBe(MAX_DESCRIPTION_CHARS + 1)
    const withoutSpans = text.replace(/`[^`]*`/g, "")
    expect(withoutSpans.length).toBeLessThan(MAX_DESCRIPTION_CHARS / 2)
    const rows = descriptionTexts([
      {
        name: "Probe",
        description: text,
        input_schema: { type: "object", properties: { a: { description: text } } },
        source: "manifest",
      },
    ])
    expect(rows.map((r) => r.chars)).toEqual([501, 501])
  })
})
