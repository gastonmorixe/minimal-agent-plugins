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

import { renderCatalog, renderFragment, shortenPath } from "./prompt-fragment.ts"

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
    expect(r).toContain("Use `Skill` with `read` and the name of a skill to load it.")
    expect(r).toContain("`<root>/<name>/SKILL.md`")
  })

  test("one row per skill, no scope column", () => {
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
    expect(r).toContain("- alpha: First.")
    expect(r).toContain("- beta: Second.")
    expect(r).not.toContain("|")
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
    expect(r).toContain(`- x: ${"a".repeat(119)}…`)
    expect(r.includes("a".repeat(120))).toBe(false)
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

  test("roots shortened to ~/… or ./… as headings", () => {
    const r = renderFragment(
      {
        skills: [
          skill({
            name: "proj",
            description: "x",
            scope: "project",
            dir: `${CWD}/.agents/skills/proj`,
          }),
          skill({ name: "usr", description: "y", scope: "userAgent" }),
        ],
        broken: [],
        shadowed: [],
      },
      CWD,
      HOME,
    )
    expect(r).toContain("### `./.agents/skills`")
    expect(r).toContain("### `~/.minimal-agent/skills`")
    expect(r).toContain("- proj: x")
    expect(r).toContain("- usr: y")
    expect(r.indexOf("./.agents/skills")).toBeLessThan(r.indexOf("~/.minimal-agent/skills"))
  })
})

// ===========================================================================
// renderFragment — broken + shadowed are not in the prompt
// ===========================================================================

describe("renderFragment — broken", () => {
  test("only broken skills → empty string", () => {
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
    expect(r).toBe("")
  })

  test("broken skills give no line next to valid skills", () => {
    const r = renderFragment(
      {
        skills: [skill({ name: "a", description: "Alpha." })],
        broken: [
          {
            dirName: "bad",
            dir: `${HOME}/.minimal-agent/skills/bad`,
            scope: "userAgent",
            errors: ["err one", "err two"],
          },
        ],
        shadowed: [],
      },
      CWD,
      HOME,
    )
    expect(r).not.toContain("bad")
    expect(r).not.toContain("err one")
    expect(r).not.toContain("Broken")
  })
})

describe("renderFragment — catalog cap", () => {
  test("notes omitted count and that Skill list still sees them", () => {
    const r = renderFragment(
      { skills: [skill({ name: "a", description: "Alpha." })], broken: [], shadowed: [] },
      CWD,
      HOME,
      { omittedCount: 22, maxSkills: 64 },
    )
    expect(r).toContain("Skills not shown here: 22. `Skill` with `list` shows all skills.")
    expect(r).not.toContain("maxSkills")
  })

  test("singular cap line", () => {
    const r = renderFragment(
      { skills: [skill({ name: "a", description: "Alpha." })], broken: [], shadowed: [] },
      CWD,
      HOME,
      { omittedCount: 1, maxSkills: 64 },
    )
    expect(r).toContain("Skills not shown here: 1.")
  })

  test("no cap line when nothing is omitted", () => {
    const r = renderFragment(
      { skills: [skill({ name: "a", description: "Alpha." })], broken: [], shadowed: [] },
      CWD,
      HOME,
    )
    expect(r).not.toContain("Skills not shown here")
  })
})

describe("renderFragment — shadowed", () => {
  test("shadowed skills are not in the prompt", () => {
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
    expect(r).not.toContain("Shadowed")
    expect(r).not.toContain("loser")
    expect(r).toContain("- alpha: winner")
  })
})

// ===========================================================================
// renderCatalog
// ===========================================================================

describe("renderCatalog", () => {
  test("empty skills → empty string", () => {
    expect(renderCatalog([], CWD, HOME)).toBe("")
  })

  test("one heading per root, rows under it", () => {
    const out = renderCatalog(
      [
        skill({ name: "a", description: "alpha", scope: "homeShared" }),
        skill({ name: "b", description: "beta", scope: "homeShared" }),
      ],
      CWD,
      HOME,
    )
    expect(out).toBe("### `~/.minimal-agent/skills`\n\n- a: alpha\n- b: beta")
  })

  test("interleaved root groups under its first heading", () => {
    const out = renderCatalog(
      [
        skill({ name: "a", description: "alpha" }),
        skill({ name: "x", description: "extra", dir: "/opt/skills/x", scope: "extra" }),
        skill({ name: "b", description: "beta" }),
      ],
      CWD,
      HOME,
    )
    expect(out).toBe(
      "### `~/.minimal-agent/skills`\n\n- a: alpha\n- b: beta\n\n### `/opt/skills`\n\n- x: extra",
    )
  })
})
