/**
 * Tests for the block removal rules in `golden-removals.ts`.
 *
 * A block is one `<ma::sys::ROLE name="NAME">` section of a system prompt.
 * Each case builds a before text and an after text. Then it checks
 * `isAllowedRemoval` and `withoutBlock` directly.
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { pluginSideband } from "../support/sideband.ts"

import {
  BLOCK_REMOVALS,
  BLOCK_TRIMS,
  type BlockRemoval,
  type BlockTrim,
  DELETED_GOLDENS,
  isAllowedRemoval,
  isAllowedTrim,
  type SectionRemoval,
  withoutBlock,
} from "./golden-removals.ts"
import { PLUGINS_ROOT } from "./surfaces.ts"

const SB = await pluginSideband()

/** One `tool` block with the name `n`, as the real codec writes it. */
const block = (n: string): string =>
  `${SB.open("tool", { attrs: { name: n } })}\nbody ${n}\n${SB.close("tool")}`

describe("golden removals: block removals", () => {
  const blockRule = (...names: string[]): readonly BlockRemoval[] =>
    names.map((name) => ({ role: "tool", name, source: "test" }))
  const blockText = (...names: string[]) => ["# A\n\na", ...names.map(block)].join("\n\n")
  /** True when the change from before to after is an allowed removal. */
  const allowed = (
    beforeText: string,
    afterText: string,
    blocks: readonly BlockRemoval[],
    sections: readonly SectionRemoval[] = [],
  ) => isAllowedRemoval(beforeText, afterText, sections, blocks)

  test("one listed block removed is allowed", () => {
    expect(allowed(blockText("X", "Y"), blockText("Y"), blockRule("X"))).toBe(true)
  })
  test("the last block removed takes its separator", () => {
    expect(allowed(blockText("X", "Y"), blockText("X"), blockRule("Y"))).toBe(true)
  })
  test("two listed blocks removed are allowed", () => {
    expect(allowed(blockText("X", "Y", "Z"), blockText("Y"), blockRule("X", "Z"))).toBe(true)
  })
  test("a block removed but not listed is not allowed", () => {
    expect(allowed(blockText("X", "Y"), blockText("Y"), [])).toBe(false)
    expect(allowed(blockText("X", "Y"), blockText("Y"), blockRule("Q"))).toBe(false)
  })
  test("a listed block that is absent in before is skipped", () => {
    expect(allowed(blockText("X", "Y"), blockText("Y"), blockRule("Q", "X"))).toBe(true)
  })
  test("a listed block removed plus one changed byte is not allowed", () => {
    expect(
      allowed(blockText("X", "Y"), blockText("Y").replace("body Y", "body y"), blockRule("X")),
    ).toBe(false)
  })
  test("a section and a block removed together, both listed, are allowed", () => {
    const sections: readonly SectionRemoval[] = [{ heading: "# B", source: "test" }]
    const withSection = `${blockText("X", "Y")}\n\n# B\n\nb`
    expect(allowed(withSection, blockText("Y"), blockRule("X"), sections)).toBe(true)
    expect(allowed(withSection, blockText("Y"), blockRule("X"), [])).toBe(false)
  })
  test("a name that is a prefix of another name removes only the exact block", () => {
    const both = blockText("FetchX", "Fetch")
    expect(withoutBlock(both, "tool", "Fetch")).toBe(blockText("FetchX"))
    const other = blockText("Fetch", "FetchX")
    expect(withoutBlock(other, "tool", "Fetch")).toBe(blockText("FetchX"))
    expect(withoutBlock(blockText("FetchX"), "tool", "Fetch")).toBeNull()
    expect(allowed(other, blockText("FetchX"), blockRule("Fetch"))).toBe(true)
    expect(allowed(other, blockText("Fetch"), blockRule("Fetch"))).toBe(false)
  })
  test("a block of another role with the same name is not removed", () => {
    expect(withoutBlock(blockText("X"), "behavior", "X")).toBeNull()
  })
  test("a block that does not start after a separator is not matched", () => {
    expect(withoutBlock(`a ${block("X")}`, "tool", "X")).toBeNull()
  })
  test("each listed deleted golden has a source", () => {
    for (const d of DELETED_GOLDENS) expect(d.source.length).toBeGreaterThan(0)
  })
  test("BLOCK_REMOVALS entries have a source", () => {
    for (const b of BLOCK_REMOVALS) expect(b.source.length).toBeGreaterThan(0)
  })
})

describe("golden removals: block trims", () => {
  /** Every protocol tag of a text, in order. Tag mentions count too. */
  const tags = (text: string): string[] => {
    const out: string[] = []
    for (let i = text.indexOf("<"); i >= 0; i = text.indexOf("<", i + 1)) {
      const end = text.indexOf(">", i)
      if (end < 0) break
      const tag = text.slice(i, end + 1)
      const name = tag.startsWith("</") ? tag.slice(2) : tag.slice(1)
      if (name.startsWith("ma::") && !tag.slice(1).includes("<")) out.push(tag)
    }
    return out
  }
  const stamp = SB.render("mode-active", { attrs: { id: "x", since: "y" } })
  const mode = (body: string): string =>
    `${SB.open("mode", { attrs: { name: "M" } })}\n${body}\n${SB.close("mode")}`
  const removeX: readonly BlockRemoval[] = [{ role: "tool", name: "X", source: "test" }]
  const trimM = (dropTags: readonly string[] = []): readonly BlockTrim[] => [
    { role: "mode", name: "M", dropTags, source: "test" },
  ]
  const before = ["# A\n\na", block("X"), mode(`Long text. ${stamp} more.`)].join("\n\n")
  const allowed = (after: string, trims: readonly BlockTrim[], blocks = removeX) =>
    isAllowedTrim(before, after, tags, trims, [], blocks)

  test("a removal plus a trim that drops a listed tag is allowed", () => {
    const after = ["# A\n\na", mode("Short.")].join("\n\n")
    expect(allowed(after, trimM(["ma::agent::mode-active"]))).toBe(true)
  })
  test("a trim that drops an unlisted tag is not allowed", () => {
    expect(allowed(["# A\n\na", mode("Short.")].join("\n\n"), trimM())).toBe(false)
  })
  test("a trim that keeps the tags may change the words", () => {
    expect(allowed(["# A\n\na", mode(`New. ${stamp}`)].join("\n\n"), trimM())).toBe(true)
  })
  test("a change out of the trimmed block is not allowed", () => {
    const after = ["# A\n\nb", mode("Short.")].join("\n\n")
    expect(allowed(after, trimM(["ma::agent::mode-active"]))).toBe(false)
  })
  test("a trim with no listed removal is not allowed", () => {
    const after = ["# A\n\na", block("X"), mode("Short.")].join("\n\n")
    expect(allowed(after, trimM(["ma::agent::mode-active"]), [])).toBe(false)
  })
  test("a trimmed block that is gone is not allowed", () => {
    expect(allowed("# A\n\na", trimM(["ma::agent::mode-active"]))).toBe(false)
  })
  test("BLOCK_TRIMS entries have a source", () => {
    for (const t of BLOCK_TRIMS) expect(t.source.length).toBeGreaterThan(0)
  })
})

describe("golden removals: per golden", () => {
  const GOLDEN_DIR = "tests/request-golden/goldens"
  /**
   * The count of (golden, block) removals since the merge base: 14 listed
   * blocks, each removed from each of 57 request goldens (14 x 57 = 798).
   * It was 784 (14 x 56) before the rebase onto the tool attachments, which
   * added the cdp-screenshot golden. A later change that drops a listed block
   * from one more golden must raise this number.
   */
  const EXPECTED_REMOVALS = 798
  /** The open tag prefix of a system block, built by the codec (no tag literal here). */
  const probe = SB.open("tool", { attrs: { name: "Q" } })
  const PREFIX = probe.slice(0, probe.indexOf("tool"))
  const REST = /(\w+) name="([^"]*)">/y
  const git = (args: string[]): string | null => {
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
  const base = git(["merge-base", "HEAD", "origin/main"])?.trim() || null
  /** Every `role:name` block that opens in a string leaf of a parsed golden. */
  const blocksOf = (value: unknown, out = new Set<string>()): Set<string> => {
    if (typeof value === "string") {
      for (let i = value.indexOf(PREFIX); i >= 0; i = value.indexOf(PREFIX, i + 1)) {
        REST.lastIndex = i + PREFIX.length
        const m = REST.exec(value)
        if (m) out.add(`${m[1]}:${m[2]}`)
      }
    } else if (value !== null && typeof value === "object") {
      for (const v of Object.values(value)) blocksOf(v, out)
    }
    return out
  }
  const names = (git(["ls-tree", "--name-only", `${base}:${GOLDEN_DIR}`]) ?? "")
    .split("\n")
    .filter((n) => n.endsWith(".json"))
  const listed = new Set(BLOCK_REMOVALS.map((b) => `${b.role}:${b.name}`))

  if (base === null) {
    test("skipped: no merge base with origin/main", () => {
      console.warn("[golden-removals] no merge base with origin/main: the per golden check is off")
    })
    return
  }

  test("each listed block is gone and each gone block is listed, in every golden", () => {
    let removals = 0
    const problems: string[] = []
    for (const name of names) {
      const path = join(PLUGINS_ROOT, GOLDEN_DIR, name)
      if (!existsSync(path)) continue
      const before = blocksOf(JSON.parse(git(["show", `${base}:${GOLDEN_DIR}/${name}`]) ?? "null"))
      const after = blocksOf(JSON.parse(readFileSync(path, "utf8")))
      for (const key of before) {
        if (listed.has(key) && after.has(key)) problems.push(`${name}: ${key} is still there`)
        if (!listed.has(key) && !after.has(key))
          problems.push(`${name}: ${key} is gone, not listed`)
        if (listed.has(key) && !after.has(key)) removals++
      }
    }
    expect(problems).toEqual([])
    expect(removals).toBe(EXPECTED_REMOVALS)
  })
})
