/**
 * Tests for the prompt-fragment producer.
 *
 * Strategy: drive the pure `renderFragment` directly with hand-built
 * `DiscoveryResult` objects. Real-filesystem coverage already lives in
 * `lib/discovery.test.ts`, so we don't re-litigate it here.
 *
 * @module handlers/prompt-fragment.test
 */

import { describe, expect, test } from "bun:test"
import type { DiscoveryResult, Skill } from "../lib/types.ts"
import { renderBrokenRow, renderFragment, renderTable, shortenPath } from "./prompt-fragment.ts"

const CWD = "/work/proj"
const HOME = "/Users/me"

function skill(over: Partial<Skill> & { name: string; description: string }): Skill {
  return {
    front: { name: over.name, description: over.description },
    dir: over.dir ?? `${HOME}/.minimal-agent/skills/${over.name}`,
    skillMdPath: over.skillMdPath ?? `${HOME}/.minimal-agent/skills/${over.name}/SKILL.md`,
    scope: over.scope ?? "userAgent",
  }
}

function empty(): DiscoveryResult {
  return { skills: [], broken: [], shadowed: [] }
}

// ===========================================================================
// shortenPath
// ===========================================================================

describe("shortenPath", () => {
  test("cwd-relative path", () => {
    expect(shortenPath(`${CWD}/.agents/skills/x`, CWD, HOME)).toBe("./.agents/skills/x")
  })
  test("home-relative path", () => {
    expect(shortenPath(`${HOME}/.minimal-agent/skills/x`, CWD, HOME)).toBe(
      "~/.minimal-agent/skills/x",
    )
  })
  test("exact home", () => {
    expect(shortenPath(HOME, CWD, HOME)).toBe("~")
  })
  test("absolute path outside cwd/home preserved", () => {
    expect(shortenPath("/var/skills/x", CWD, HOME)).toBe("/var/skills/x")
  })
  test("cwd prefix takes precedence over home prefix when both match", () => {
    // Construct a case where cwd is nested under home.
    const cwd = `${HOME}/work`
    expect(shortenPath(`${cwd}/.agents/skills/x`, cwd, HOME)).toBe("./.agents/skills/x")
  })
})

// ===========================================================================
// renderFragment — empty / populated
// ===========================================================================

describe("renderFragment — empty world", () => {
  test("empty discovery → empty string", () => {
    expect(renderFragment(empty(), CWD, HOME)).toBe("")
  })
})

describe("renderFragment — populated", () => {
  test("header line is present", () => {
    const r = renderFragment(
      { skills: [skill({ name: "a", description: "Alpha." })], broken: [], shadowed: [] },
      CWD,
      HOME,
    )
    expect(r).toContain("## Skills available this session")
  })

  test("router language tells model how to activate", () => {
    const r = renderFragment(
      { skills: [skill({ name: "a", description: "Alpha." })], broken: [], shadowed: [] },
      CWD,
      HOME,
    )
    expect(r).toContain('`Skill {action: "read"')
    expect(r).toContain("`Read`")
  })

  test("table row per skill", () => {
    const r = renderFragment(
      {
        skills: [
          skill({ name: "alpha", description: "First." }),
          skill({ name: "beta", description: "Second.", scope: "project" }),
        ],
        broken: [],
        shadowed: [],
      },
      CWD,
      HOME,
    )
    expect(r).toContain("| `alpha` |")
    expect(r).toContain("| `beta` |")
    expect(r).toContain("project")
    expect(r).toContain("user")
    expect(r).toContain("First.")
    expect(r).toContain("Second.")
  })

  test("description clipped at long length (with ellipsis)", () => {
    const long = "a".repeat(500)
    const r = renderFragment(
      { skills: [skill({ name: "x", description: long })], broken: [], shadowed: [] },
      CWD,
      HOME,
    )
    expect(r).toContain("…")
    expect(r.includes("a".repeat(500))).toBe(false)
  })

  test("pipes in description are escaped (markdown safety)", () => {
    const r = renderFragment(
      {
        skills: [skill({ name: "x", description: "use a | pipe" })],
        broken: [],
        shadowed: [],
      },
      CWD,
      HOME,
    )
    expect(r).toContain("\\|")
  })

  test("newlines in description collapsed to spaces", () => {
    const r = renderFragment(
      {
        skills: [skill({ name: "x", description: "line\nbreak" })],
        broken: [],
        shadowed: [],
      },
      CWD,
      HOME,
    )
    expect(r).toContain("line break")
  })

  test("paths shortened to ~/… or ./…", () => {
    const r = renderFragment(
      {
        skills: [
          skill({ name: "proj", description: "x", scope: "project", dir: `${CWD}/.agents/skills/proj` }),
          skill({ name: "usr", description: "y", scope: "userAgent" }),
        ],
        broken: [],
        shadowed: [],
      },
      CWD,
      HOME,
    )
    expect(r).toContain("./.agents/skills/proj")
    expect(r).toContain("~/.minimal-agent/skills/usr")
  })
})

// ===========================================================================
// renderFragment — broken + shadowed
// ===========================================================================

describe("renderFragment — broken", () => {
  test("broken section present when any broken", () => {
    const r = renderFragment(
      {
        skills: [],
        broken: [
          {
            dirName: "bad",
            dir: `${HOME}/.minimal-agent/skills/bad`,
            scope: "userAgent",
            errors: ["missing closing ---"],
          },
        ],
        shadowed: [],
      },
      CWD,
      HOME,
    )
    expect(r).toContain("### Broken skills")
    expect(r).toContain("`bad`")
    expect(r).toContain("missing closing ---")
  })

  test("first error shown plus +N more counter", () => {
    const r = renderFragment(
      {
        skills: [],
        broken: [
          {
            dirName: "bad",
            dir: `${HOME}/.minimal-agent/skills/bad`,
            scope: "userAgent",
            errors: ["err one", "err two", "err three"],
          },
        ],
        shadowed: [],
      },
      CWD,
      HOME,
    )
    expect(r).toContain("err one")
    expect(r).toContain("+2 more")
  })

  test("renderBrokenRow standalone", () => {
    const row = renderBrokenRow(
      {
        dirName: "x",
        dir: `${HOME}/.minimal-agent/skills/x`,
        scope: "userAgent",
        errors: ["fail"],
      },
      CWD,
      HOME,
    )
    expect(row).toContain("`x`")
    expect(row).toContain("~/.minimal-agent/skills/x")
    expect(row).toContain("fail")
  })
})

describe("renderFragment — shadowed", () => {
  test("shadowed section present when any shadowed", () => {
    const r = renderFragment(
      {
        skills: [skill({ name: "alpha", description: "winner", scope: "project" })],
        broken: [],
        shadowed: [
          {
            skill: skill({ name: "alpha", description: "loser", scope: "homeShared" }),
            shadowedBy: "project",
          },
        ],
      },
      CWD,
      HOME,
    )
    expect(r).toContain("### Shadowed")
    expect(r).toContain("shadowed by project")
  })
})

// ===========================================================================
// renderTable
// ===========================================================================

describe("renderTable", () => {
  test("empty skills → header + separator only", () => {
    const out = renderTable([], CWD, HOME)
    const lines = out.split("\n")
    expect(lines[0]).toContain("name")
    expect(lines[1]).toContain("---")
    expect(lines).toHaveLength(2)
  })

  test("renders four columns including scope and path", () => {
    const out = renderTable(
      [skill({ name: "a", description: "alpha", scope: "homeShared" })],
      CWD,
      HOME,
    )
    expect(out).toContain("| `a` | home | alpha |")
    expect(out).toContain("~/.minimal-agent/skills/a")
  })
})
