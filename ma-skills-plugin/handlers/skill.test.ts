/**
 * Tests for the `Skill` tool handler.
 *
 * Strategy:
 *   - Pure validators (validateInput, buildListJson, buildInfoContent,
 *     buildReadContent, buildReadDisplay, findBodyStart) are tested
 *     directly with handcrafted Skill objects.
 *   - The full handler is driven through `default` with a faked
 *     `TUIContext` against a tmpdir-backed skill tree, so end-to-end
 *     dispatch (list/info/read + error paths) is covered.
 *
 * @module handlers/skill.test
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { DiscoveryResult, Skill, TUIContext, TUIResult } from "../lib/types.ts"

import handler, {
  buildInfoContent,
  buildListDisplay,
  buildListJson,
  buildReadContent,
  buildReadDisplay,
  findBodyStart,
  validateInput,
} from "./skill.ts"

// ---------------------------------------------------------------------------
// validateInput
// ---------------------------------------------------------------------------

describe("validateInput", () => {
  test("missing action → error", () => {
    const r = validateInput({})
    expect(r.ok).toBe(false)
  })

  test("unknown action → error", () => {
    const r = validateInput({ action: "delete" })
    expect(r.ok).toBe(false)
  })

  test("list does not need name", () => {
    const r = validateInput({ action: "list" })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({ action: "list" })
  })

  test("info requires name", () => {
    expect(validateInput({ action: "info" }).ok).toBe(false)
    expect(validateInput({ action: "info", name: "" }).ok).toBe(false)
    expect(validateInput({ action: "info", name: "   " }).ok).toBe(false)
  })

  test("read requires name; trims", () => {
    const r = validateInput({ action: "read", name: "  pdf  " })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({ action: "read", name: "pdf" })
  })

  test("rejects non-string action", () => {
    expect(validateInput({ action: 42 }).ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// findBodyStart
// ---------------------------------------------------------------------------

describe("findBodyStart", () => {
  test("locates index just past closing ---", () => {
    const text = "---\nname: a\n---\nbody"
    const i = findBodyStart(text)
    expect(text.slice(i)).toBe("body")
  })

  test("tolerates BOM", () => {
    const text = "\ufeff---\nname: a\n---\nhi"
    const i = findBodyStart(text)
    expect(text.slice(i)).toBe("hi")
  })

  test("returns -1 when first line is not ---", () => {
    expect(findBodyStart("# title\n")).toBe(-1)
  })

  test("returns -1 when closing --- missing", () => {
    expect(findBodyStart("---\nname: a\nnope")).toBe(-1)
  })

  test("file ending exactly at closing --- (no body)", () => {
    const text = "---\nname: a\n---"
    const i = findBodyStart(text)
    expect(i).toBe(text.length)
  })
})

// ---------------------------------------------------------------------------
// Pure renderers
// ---------------------------------------------------------------------------

function skill(over: Partial<Skill> & { name: string; description: string }): Skill {
  return {
    front: {
      name: over.name,
      description: over.description,
      license: over.front?.license,
      compatibility: over.front?.compatibility,
      metadata: over.front?.metadata,
      allowedTools: over.front?.allowedTools,
    },
    dir: over.dir ?? `/u/.minimal-agent/skills/${over.name}`,
    skillMdPath: over.skillMdPath ?? `/u/.minimal-agent/skills/${over.name}/SKILL.md`,
    scope: over.scope ?? "userAgent",
  }
}

describe("buildListJson", () => {
  test("flattens skills + broken + shadowed", () => {
    const result: DiscoveryResult = {
      skills: [skill({ name: "a", description: "alpha" })],
      broken: [
        {
          dirName: "bad",
          dir: "/u/.minimal-agent/skills/bad",
          scope: "userAgent",
          errors: ["err"],
        },
      ],
      shadowed: [
        {
          skill: skill({ name: "z", description: "z", scope: "homeShared" }),
          shadowedBy: "project",
        },
      ],
    }
    const j = buildListJson(result)
    expect(j.skills.map((s) => s.name)).toEqual(["a"])
    expect(j.skills[0].scope).toBe("userAgent")
    expect(j.skills[0].hasAllowedTools).toBe(false)
    expect(j.broken).toHaveLength(1)
    expect(j.shadowed[0].shadowedBy).toBe("project")
  })

  test("hasAllowedTools reflects presence", () => {
    const s = skill({ name: "x", description: "x" })
    s.front.allowedTools = ["Read"]
    const j = buildListJson({ skills: [s], broken: [], shadowed: [] })
    expect(j.skills[0].hasAllowedTools).toBe(true)
  })
})

describe("buildListDisplay", () => {
  test("empty world placeholder", () => {
    expect(buildListDisplay({ skills: [], broken: [], shadowed: [] }, "/c", "/h")).toContain(
      "no skills discovered",
    )
  })

  test("renders names and descriptions", () => {
    const out = buildListDisplay(
      {
        skills: [skill({ name: "alpha", description: "alpha desc" })],
        broken: [],
        shadowed: [],
      },
      "/c",
      "/h",
    )
    expect(out).toContain("alpha")
    expect(out).toContain("alpha desc")
    expect(out).toContain("skills")
  })

  test("renders broken section", () => {
    const out = buildListDisplay(
      {
        skills: [],
        broken: [
          {
            dirName: "bad",
            dir: "/u/.minimal-agent/skills/bad",
            scope: "userAgent",
            errors: ["e1", "e2"],
          },
        ],
        shadowed: [],
      },
      "/c",
      "/h",
    )
    expect(out).toContain("broken")
    expect(out).toContain("bad")
    expect(out).toContain("+1 more")
  })
})

describe("buildInfoContent", () => {
  test("minimal", () => {
    const out = buildInfoContent(skill({ name: "a", description: "Hello." }))
    expect(out).toContain("name: a")
    expect(out).toContain("description: Hello.")
    expect(out).toContain("# scope: user")
    expect(out).toContain("# path:")
  })

  test("includes optional fields when present", () => {
    const s = skill({ name: "a", description: "x" })
    s.front.license = "Apache-2.0"
    s.front.compatibility = "needs git"
    s.front.metadata = { author: "me", version: "1" }
    s.front.allowedTools = ["Bash(git:*)", "Read"]
    const out = buildInfoContent(s)
    expect(out).toContain("license:")
    expect(out).toContain("compatibility:")
    expect(out).toContain("metadata:")
    expect(out).toContain("author:")
    expect(out).toContain("allowed-tools: Bash(git:*) Read")
  })

  test("quotes when value has special chars", () => {
    const s = skill({ name: "a", description: 'has "quotes" inside' })
    const out = buildInfoContent(s)
    expect(out).toContain('description: "has \\"quotes\\" inside"')
  })
})

describe("buildReadContent / buildReadDisplay", () => {
  test("trailer announces skill + siblings", () => {
    const s = skill({ name: "demo", description: "x" })
    const c = buildReadContent(s, ["scripts", "references"], "# Demo\nbody")
    expect(c).toContain("# Demo")
    expect(c).toContain("body")
    expect(c).toContain("Skill loaded: demo")
    expect(c).toContain("scripts")
    expect(c).toContain("references")
    expect(c).toContain("Use `Read`")
  })

  test("no siblings → '(none — SKILL.md only)'", () => {
    const s = skill({ name: "demo", description: "x" })
    const c = buildReadContent(s, [], "body")
    expect(c).toContain("(none — SKILL.md only)")
  })

  test("includes allowed-tools self-enforcement hint when present", () => {
    const s = skill({ name: "demo", description: "x" })
    s.front.allowedTools = ["Read"]
    const c = buildReadContent(s, [], "body")
    expect(c).toMatch(/Self-enforce.*Read/i)
  })

  test("read display clipped to PREVIEW_LINES with overflow hint", () => {
    const body = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n")
    const d = buildReadDisplay(body)
    expect(d).toContain("line 0")
    expect(d).toContain("…")
    expect(d).toContain("more lines")
  })

  test("read display safe for short bodies", () => {
    const d = buildReadDisplay("only one line")
    expect(d).toBe("only one line")
  })
})

// ---------------------------------------------------------------------------
// End-to-end through default handler
// ---------------------------------------------------------------------------

let TMP: string

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "ma-skills-handler-"))
})

afterEach(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true })
  // Reset env that could leak between tests.
  delete process.env.MINIMAL_AGENT_CONFIG
})

function ctxFor(input: Record<string, unknown>): TUIContext {
  const cwd = join(TMP, "cwd")
  const env: Record<string, string> = {}
  return {
    trigger: { type: "tool", name: "Skill", input },
    packageDir: join(TMP, "pkg"),
    cwd,
    env,
    abort: new AbortController().signal,
    stdout: process.stdout,
    stdin: process.stdin,
    stderr: process.stderr,
    log: (() => {
      const noop = () => {}
      return {
        emergency: noop,
        alert: noop,
        critical: noop,
        error: noop,
        warn: noop,
        notice: noop,
        info: noop,
        debug: noop,
      }
    })(),
  }
}

function makeUserSkill(
  name: string,
  body: string = "Body content.",
  extraFrontmatter: string = "",
): string {
  // We write to the userAgent root: ~/.minimal-agent/skills/...
  // For tests, override HOME via MINIMAL_AGENT_CONFIG?  No — homedir()
  // is read by discovery directly. Use project root instead: <cwd>/.agents/skills/
  // because the handler uses ctx.cwd for discovery's cwd.
  const cwd = join(TMP, "cwd")
  const dir = join(cwd, ".agents", "skills", name)
  mkdirSync(dir, { recursive: true })
  const fm = `name: ${name}\ndescription: Description for ${name}.${extraFrontmatter}`
  writeFileSync(join(dir, "SKILL.md"), `---\n${fm}\n---\n${body}`)
  return dir
}

describe("Skill handler — list action", () => {
  test("empty project root → 'no skills discovered' display", async () => {
    // Force isolation: point HOME-rooted scans somewhere empty by
    // disabling homeShared / userAgent via config file.
    const cfg = join(TMP, "cfg.json")
    writeFileSync(
      cfg,
      JSON.stringify({
        plugins: {
          "ma-skills": {
            roots: {
              project: true,
              projectClaudeCode: false,
              homeShared: false,
              userAgent: false,
            },
          },
        },
      }),
    )
    process.env.MINIMAL_AGENT_CONFIG = cfg

    const r = (await handler(ctxFor({ action: "list" }))) as TUIResult
    expect(r.kind).toBe("tool_result")
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBeUndefined()
    const payload = JSON.parse(r.content)
    expect(payload.skills).toEqual([])
    expect(payload.broken).toEqual([])
    expect(r.display).toContain("no skills discovered")
  })

  test("finds project-root skills", async () => {
    const cfg = join(TMP, "cfg.json")
    writeFileSync(
      cfg,
      JSON.stringify({
        plugins: {
          "ma-skills": {
            roots: {
              project: true,
              projectClaudeCode: false,
              homeShared: false,
              userAgent: false,
            },
          },
        },
      }),
    )
    process.env.MINIMAL_AGENT_CONFIG = cfg

    makeUserSkill("alpha")
    makeUserSkill("beta")

    const r = (await handler(ctxFor({ action: "list" }))) as TUIResult
    if (r.kind !== "tool_result") throw new Error("wrong kind")
    expect(r.is_error).toBeUndefined()
    const payload = JSON.parse(r.content)
    expect(payload.skills.map((s: { name: string }) => s.name).sort()).toEqual(["alpha", "beta"])
  })

  test("disabled plugin → error result", async () => {
    const cfg = join(TMP, "cfg.json")
    writeFileSync(cfg, JSON.stringify({ plugins: { "ma-skills": { enabled: false } } }))
    process.env.MINIMAL_AGENT_CONFIG = cfg
    const r = (await handler(ctxFor({ action: "list" }))) as TUIResult
    if (r.kind !== "tool_result") throw new Error("wrong kind")
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("disabled")
  })

  test("invalid input → error result", async () => {
    const r = (await handler(ctxFor({ action: "wat" }))) as TUIResult
    if (r.kind !== "tool_result") throw new Error("wrong kind")
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("unknown action")
  })
})

describe("Skill handler — info action", () => {
  function isolateCfg(): void {
    const cfg = join(TMP, "cfg.json")
    writeFileSync(
      cfg,
      JSON.stringify({
        plugins: {
          "ma-skills": {
            roots: {
              project: true,
              projectClaudeCode: false,
              homeShared: false,
              userAgent: false,
            },
          },
        },
      }),
    )
    process.env.MINIMAL_AGENT_CONFIG = cfg
  }

  test("returns YAML-ish dump for known skill", async () => {
    isolateCfg()
    makeUserSkill("alpha", "Body", "\nlicense: Apache-2.0")
    const r = (await handler(ctxFor({ action: "info", name: "alpha" }))) as TUIResult
    if (r.kind !== "tool_result") throw new Error("wrong kind")
    expect(r.is_error).toBeUndefined()
    expect(r.content).toContain("name: alpha")
    expect(r.content).toContain("license: Apache-2.0")
    expect(r.content).toContain("# path:")
  })

  test("unknown skill → not-found error with available list", async () => {
    isolateCfg()
    makeUserSkill("alpha")
    const r = (await handler(ctxFor({ action: "info", name: "nope" }))) as TUIResult
    if (r.kind !== "tool_result") throw new Error("wrong kind")
    expect(r.is_error).toBe(true)
    expect(r.content).toContain('no skill named "nope"')
    expect(r.content).toContain("available: alpha")
  })

  test("missing name → input validation error", async () => {
    const r = (await handler(ctxFor({ action: "info" }))) as TUIResult
    if (r.kind !== "tool_result") throw new Error("wrong kind")
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/name.*required/i)
  })
})

describe("Skill handler — read action", () => {
  function isolateCfg(): void {
    const cfg = join(TMP, "cfg.json")
    writeFileSync(
      cfg,
      JSON.stringify({
        plugins: {
          "ma-skills": {
            roots: {
              project: true,
              projectClaudeCode: false,
              homeShared: false,
              userAgent: false,
            },
          },
        },
      }),
    )
    process.env.MINIMAL_AGENT_CONFIG = cfg
  }

  test("returns body + sibling listing + trunc ctx", async () => {
    isolateCfg()
    const dir = makeUserSkill("alpha", "# Hello\nThis is the body.\n")
    mkdirSync(join(dir, "scripts"))
    writeFileSync(join(dir, "scripts", "run.sh"), "#!/bin/sh")
    writeFileSync(join(dir, "REFERENCE.md"), "ref")

    const r = (await handler(ctxFor({ action: "read", name: "alpha" }))) as TUIResult
    if (r.kind !== "tool_result") throw new Error("wrong kind")
    expect(r.is_error).toBeUndefined()
    expect(r.content).toContain("# Hello")
    expect(r.content).toContain("This is the body.")
    expect(r.content).toContain("Skill loaded: alpha")
    expect(r.content).toContain("REFERENCE.md")
    expect(r.content).toContain("scripts")
    expect(r.display).toContain("# Hello")
    expect(r._truncCtx).toBeDefined()
    expect(r._truncCtx?.tool).toBe("Skill")
    expect(r._truncCtx?.totalBytes).toBeGreaterThan(0)
  })

  test("unknown skill → not-found error", async () => {
    isolateCfg()
    const r = (await handler(ctxFor({ action: "read", name: "nope" }))) as TUIResult
    if (r.kind !== "tool_result") throw new Error("wrong kind")
    expect(r.is_error).toBe(true)
    expect(r.content).toContain('no skill named "nope"')
  })
})
