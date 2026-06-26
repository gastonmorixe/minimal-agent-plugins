import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import {
  defaultRoots,
  listSkills,
  makeSkillsProvider,
  parseMinimalFrontmatter,
  type SkillsDeps,
} from "./skills.ts"

describe("parseMinimalFrontmatter", () => {
  it("extracts name + description from a normal SKILL.md", () => {
    const body = [
      "---",
      "name: foo",
      "description: A short description.",
      "license: MIT",
      "---",
      "# body",
    ].join("\n")
    expect(parseMinimalFrontmatter(body)).toEqual({
      name: "foo",
      description: "A short description.",
    })
  })

  it("returns null when no frontmatter fence", () => {
    expect(parseMinimalFrontmatter("# just a heading\n")).toBeNull()
  })

  it("reports unterminated frontmatter as an error", () => {
    expect(parseMinimalFrontmatter("---\nname: foo\nbody-no-close")).toEqual({
      error: "unterminated frontmatter (missing closing ---)",
    })
  })

  it("strips quotes from quoted values", () => {
    const body = ["---", 'name: "foo"', "description: 'bar baz'", "---"].join("\n")
    expect(parseMinimalFrontmatter(body)).toEqual({
      name: "foo",
      description: "bar baz",
    })
  })

  it("handles block scalar continuation (>) joining with spaces", () => {
    const body = [
      "---",
      "name: foo",
      "description: >",
      "  line one",
      "  line two",
      "license: MIT",
      "---",
    ].join("\n")
    expect(parseMinimalFrontmatter(body)?.description).toBe("line one line two")
  })

  it("handles block scalar (|) joining with newlines", () => {
    const body = [
      "---",
      "name: foo",
      "description: |",
      "  line one",
      "  line two",
      "license: MIT",
      "---",
    ].join("\n")
    expect(parseMinimalFrontmatter(body)?.description).toBe("line one\nline two")
  })

  it("ignores keys other than name + description", () => {
    const body = ["---", "name: foo", "description: bar", "metadata:", "  author: x", "---"].join(
      "\n",
    )
    const out = parseMinimalFrontmatter(body)
    expect(out).toEqual({ name: "foo", description: "bar" })
  })
})

function mkDeps(files: Record<string, string>, dirs: Set<string>): SkillsDeps {
  const cache: Record<string, { mtimeNs: string; tokens: number }> = {}
  return {
    roots: ["/root/a", "/root/b"],
    readDir: (p) => {
      const out: string[] = []
      const prefix = p.endsWith("/") ? p : `${p}/`
      for (const d of dirs) {
        if (d.startsWith(prefix)) {
          const rest = d.slice(prefix.length)
          if (!rest.includes("/")) out.push(rest)
        }
      }
      return out
    },
    readFile: (p) => (p in files ? files[p]! : null),
    stat: (p) => {
      if (dirs.has(p)) return { isDirectory: true }
      if (p in files) return { isDirectory: false }
      return null
    },
    tokens: {
      readFile: (p) => (p in files ? files[p]! : null),
      stat: (p) => (p in files ? { mtimeNs: "1", size: files[p]!.length } : null),
      readCache: () => cache,
      writeCache: (next) => {
        if (next !== cache) {
          for (const k of Object.keys(cache)) delete cache[k]
          Object.assign(cache, next)
        }
      },
    },
  }
}

describe("listSkills", () => {
  it("discovers SKILL.md files across roots", () => {
    const deps = mkDeps(
      {
        "/root/a/foo/SKILL.md": "---\nname: foo\ndescription: alpha\n---\nbody",
        "/root/b/bar/SKILL.md": "---\nname: bar\ndescription: beta\n---\nbody",
      },
      new Set(["/root/a", "/root/b", "/root/a/foo", "/root/b/bar"]),
    )
    const items = listSkills(deps)
    expect(items.map((i) => i.slug).sort()).toEqual(["bar", "foo"])
  })

  it("computes token estimates per skill", () => {
    const deps = mkDeps(
      {
        "/root/a/foo/SKILL.md": "---\nname: foo\ndescription: alpha\n---\n" + "x".repeat(400),
      },
      new Set(["/root/a", "/root/a/foo"]),
    )
    const [item] = listSkills(deps)
    expect(item).toBeDefined()
    // ~ (full file size including frontmatter) / 4. With ~440 chars,
    // tokens should be > 100.
    expect(item!.tokens).toBeGreaterThan(100)
    expect(item!.tokens).toBeLessThan(120)
  })

  it("uses frontmatter `name` over directory name when present", () => {
    const deps = mkDeps(
      {
        "/root/a/some-dir/SKILL.md": "---\nname: real-name\ndescription: x\n---\nbody",
      },
      new Set(["/root/a", "/root/a/some-dir"]),
    )
    const items = listSkills(deps)
    expect(items[0]!.slug).toBe("real-name")
  })

  it("higher-precedence root shadows lower-precedence duplicate", () => {
    const deps = mkDeps(
      {
        "/root/a/foo/SKILL.md": "---\nname: foo\ndescription: from-a\n---\nbody",
        "/root/b/foo/SKILL.md": "---\nname: foo\ndescription: from-b\n---\nbody",
      },
      new Set(["/root/a", "/root/b", "/root/a/foo", "/root/b/foo"]),
    )
    const items = listSkills(deps)
    expect(items).toHaveLength(1)
    expect(items[0]!.description).toBe("from-a")
  })

  it("marks broken frontmatter as disabled with reason", () => {
    const deps = mkDeps(
      {
        "/root/a/broken/SKILL.md": "---\nname: broken\ndescription: oops\nno-closing-fence",
      },
      new Set(["/root/a", "/root/a/broken"]),
    )
    const items = listSkills(deps)
    expect(items[0]!.disabled).toBe(true)
    expect(items[0]!.disabledReason).toContain("unterminated")
    // Broken skills do NOT get a token count (we couldn't trust the parse).
    expect(items[0]!.tokens).toBeUndefined()
  })

  it("skips directories with no SKILL.md", () => {
    const deps = mkDeps(
      {
        "/root/a/empty/README.md": "no skill here",
      },
      new Set(["/root/a", "/root/a/empty"]),
    )
    expect(listSkills(deps)).toHaveLength(0)
  })

  it("returns items in alphabetical order", () => {
    const deps = mkDeps(
      {
        "/root/a/zebra/SKILL.md": "---\nname: zebra\ndescription: z\n---\nbody",
        "/root/a/alpha/SKILL.md": "---\nname: alpha\ndescription: a\n---\nbody",
        "/root/a/mango/SKILL.md": "---\nname: mango\ndescription: m\n---\nbody",
      },
      new Set(["/root/a", "/root/a/zebra", "/root/a/alpha", "/root/a/mango"]),
    )
    const items = listSkills(deps)
    expect(items.map((i) => i.slug)).toEqual(["alpha", "mango", "zebra"])
  })
})

describe("makeSkillsProvider", () => {
  it("declares refreshOn bus events", () => {
    const provider = makeSkillsProvider(mkDeps({}, new Set(["/root/a", "/root/b"])))
    expect(provider.refreshOn).toContain("skill.installed")
    expect(provider.refreshOn).toContain("skill.removed")
  })

  it("calls listSkills each time list() is invoked (no internal caching)", () => {
    const files: Record<string, string> = {}
    const dirs = new Set(["/root/a"])
    const provider = makeSkillsProvider(mkDeps(files, dirs))
    expect(provider.list()).toEqual([])
    // Now "add" a skill.
    dirs.add("/root/a/new-skill")
    files["/root/a/new-skill/SKILL.md"] = "---\nname: new-skill\ndescription: x\n---\nb"
    const items = provider.list() as { slug: string }[]
    expect(items.map((i) => i.slug)).toEqual(["new-skill"])
  })
})

describe("defaultRoots — MINIMAL_AGENT_HOME relocation (dual-root split)", () => {
  // The .minimal-agent user root must honor MINIMAL_AGENT_HOME, while the
  // SIBLING .agents root (a DIFFERENT `~/.agents` convention) must stay pinned
  // to the OS-home param. Clear+restore the env so the assertions are
  // deterministic regardless of the ambient value (a live agent sets it).
  let saved: string | undefined
  beforeEach(() => {
    saved = process.env.MINIMAL_AGENT_HOME
    delete process.env.MINIMAL_AGENT_HOME
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.MINIMAL_AGENT_HOME
    else process.env.MINIMAL_AGENT_HOME = saved
  })

  it("relocates ONLY the .minimal-agent root; .agents stays on the OS-home param", () => {
    process.env.MINIMAL_AGENT_HOME = "/tmp/ma-reloc"
    const roots = defaultRoots("/proj", "/home/u")
    expect(roots).toEqual([
      "/proj/.agents/skills",
      "/home/u/.agents/skills", // .agents convention — pinned to OS home, NOT relocated
      "/tmp/ma-reloc/skills", // .minimal-agent user root — honors MINIMAL_AGENT_HOME
    ])
    // Explicit split proof: the userAgent root moved off /home/u while .agents did not.
    expect(roots[2]).toBe("/tmp/ma-reloc/skills")
    expect(roots[1]).toBe("/home/u/.agents/skills")
  })

  it("absent the override, the .minimal-agent root is join(home, '.minimal-agent', 'skills') (back-compat)", () => {
    const roots = defaultRoots("/proj", "/home/u")
    expect(roots).toEqual([
      "/proj/.agents/skills",
      "/home/u/.agents/skills",
      "/home/u/.minimal-agent/skills",
    ])
  })
})
