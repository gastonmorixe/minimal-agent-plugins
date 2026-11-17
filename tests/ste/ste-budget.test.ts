/**
 * The tool block word budget, as a test.
 *
 * The budget itself lives in `tool-budget.ts` so a script can read it without
 * starting the test runner. This file only asserts it. Every count comes from
 * `budgetWords` (raw whitespace split, R3 bug B8).
 *
 * @module tests/ste/ste-budget.test
 */

import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { PLUGINS_ROOT } from "./surfaces.ts"
import {
  budgetWords,
  descriptionTexts,
  LOOSE_WORDS,
  MAX_DESCRIPTION_CHARS,
  PER_TOOL_LOOSE,
  parseToolWords,
  RAISES,
  TARGET,
  TOOL_BLOCK_WORDS,
  TOOL_WORDS,
  type ToolText,
  toolWords,
  unloggedRaises,
} from "./tool-budget.ts"

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

/**
 * The `tool-budget.ts` source at the merge base with origin/main.
 *
 * @returns The source, or null when there is no merge base or no file there.
 */
function mergeBaseSource(): string | null {
  try {
    const base = execFileSync("git", ["merge-base", "HEAD", "origin/main"], {
      cwd: PLUGINS_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    if (!base) return null
    return execFileSync("git", ["show", `${base}:tests/ste/tool-budget.ts`], {
      cwd: PLUGINS_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
  } catch {
    return null
  }
}

describe("tool block word budget", () => {
  const tools = toolWords()
  const total = tools.reduce((sum, tool) => sum + tool.words, 0)

  test("the golden yields the shipped tool block", () => {
    expect(tools.length).toBeGreaterThan(40)
    expect(tools.some((tool) => tool.name === "Bash")).toBe(true)
    expect(tools.some((tool) => tool.name === "FixtureThrow")).toBe(false)
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

  test("an entry above its merge-base value has a RAISES row", () => {
    const source = mergeBaseSource()
    if (source === null) {
      console.warn("[ste-budget] no merge base with origin/main: the raise check is off")
      return
    }
    const base = parseToolWords(source)
    if (base === null) {
      console.warn(
        "[ste-budget] the merge base has no TOOL_WORDS (it predates the per-tool map): the raise check is off",
      )
      return
    }
    expect(unloggedRaises(TOOL_WORDS, base, RAISES)).toEqual([])
  })
})

describe("per-tool budget: mutation proof", () => {
  const tools = toolWords()

  test("a tool that grows by one word fails", () => {
    const grown = tools.map((t) => (t.name === "Bash" ? { ...t, words: t.words + 1 } : t))
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

  test("parseToolWords reads this file and reads null from an old file", () => {
    const source = `export const TOOL_WORDS: Readonly<Record<string, number>> = {\n  Bash: 386,\n  "Task": 562,\n}`
    expect(parseToolWords(source)).toEqual({ Bash: 386, Task: 562 })
    expect(parseToolWords("export const PER_TOOL_MAX = 751")).toBeNull()
  })
})

describe("description length cap (MAX_DESCRIPTION_CHARS)", () => {
  const texts = descriptionTexts()

  test("the golden yields every tool and param description", () => {
    expect(texts.filter((t) => t.path === "description").length).toBe(toolWords().length)
    expect(texts.length).toBeGreaterThan(200)
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
    const dir = mkdtempSync(join(tmpdir(), "ste-cap-"))
    const file = join(dir, "golden.json")
    const golden = {
      requests: [
        {
          tools: [
            {
              name: "Probe",
              description: "x".repeat(MAX_DESCRIPTION_CHARS + 1),
              input_schema: {
                type: "object",
                properties: {
                  a: { type: "string", description: "y".repeat(MAX_DESCRIPTION_CHARS) },
                },
              },
            },
          ],
        },
      ],
    }
    writeFileSync(file, JSON.stringify(golden))
    const rows = descriptionTexts(file)
    rmSync(dir, { recursive: true, force: true })
    expect(rows.map((r) => [r.path, r.chars > MAX_DESCRIPTION_CHARS])).toEqual([
      ["description", true],
      ["input_schema.properties.a", false],
    ])
  })
})
