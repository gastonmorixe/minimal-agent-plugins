/**
 * Store tests: create, read, list, edit, rename, delete, collisions, caps.
 *
 * All fs access goes through injected deps backed by a temp directory, so the
 * real `~/.minimal-agent/prompts` is never touched.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import {
  createPrompt,
  defaultDeps,
  deletePrompt,
  editPrompt,
  findPrompt,
  loadPrompts,
  type StoreDeps,
} from "../lib/store.ts"

let dir: string
let deps: StoreDeps

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ma-prompts-store-"))
  deps = defaultDeps({}, dir, false, {
    roots: [{ scope: "user", dir: join(dir, "prompts") }],
  })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("create + load", () => {
  it("creates and reads back a prompt", () => {
    const r = createPrompt(deps, { name: "review-pr", description: "review", body: "BODY" })
    expect(r.ok).toBe(true)
    const { prompts } = loadPrompts(deps)
    expect(prompts.length).toBe(1)
    expect(prompts[0]!.slug).toBe("review-pr")
    expect(prompts[0]!.body).toBe("BODY")
  })

  it("refuses a collision without overwrite", () => {
    createPrompt(deps, { name: "x", description: "", body: "one" })
    const r = createPrompt(deps, { name: "x", description: "", body: "two" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("already exists")
  })

  it("overwrites when asked", () => {
    createPrompt(deps, { name: "x", description: "", body: "one" })
    const r = createPrompt(deps, { name: "x", description: "", body: "two", overwrite: true })
    expect(r.ok).toBe(true)
    const { prompts } = loadPrompts(deps)
    expect(prompts[0]!.body).toBe("two")
  })

  it("rejects a bad name", () => {
    const r = createPrompt(deps, { name: "has space", description: "", body: "b" })
    expect(r.ok).toBe(false)
  })

  it("rejects a reserved name", () => {
    const r = createPrompt(deps, { name: "help", description: "", body: "b" })
    expect(r.ok).toBe(false)
  })

  it("rejects a body over the cap", () => {
    const small = defaultDeps({}, dir, false, {
      roots: [{ scope: "user", dir: join(dir, "prompts") }],
      maxBodyBytes: 4,
    })
    const r = createPrompt(small, { name: "x", description: "", body: "toolong" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("byte limit")
  })

  it("reports broken files instead of throwing", () => {
    const bad = defaultDeps({}, dir, false, {
      roots: [{ scope: "user", dir: join(dir, "prompts") }],
      readFile: () => "no frontmatter here",
      readDir: () => ["broken.md"],
    })
    const { prompts, broken } = loadPrompts(bad)
    expect(prompts.length).toBe(0)
    expect(broken.length).toBe(1)
  })
})

describe("edit + rename + delete", () => {
  it("edits the body", () => {
    createPrompt(deps, { name: "x", description: "d", body: "one" })
    const r = editPrompt(deps, { name: "x", body: "two" })
    expect(r.ok).toBe(true)
    expect(findPrompt(loadPrompts(deps), "x")!.body).toBe("two")
  })

  it("renames and removes the old file", () => {
    createPrompt(deps, { name: "old", description: "", body: "b" })
    const r = editPrompt(deps, { name: "old", rename: "new" })
    expect(r.ok).toBe(true)
    const { prompts } = loadPrompts(deps)
    expect(prompts.map((p) => p.slug)).toEqual(["new"])
  })

  it("refuses a rename onto an existing name", () => {
    createPrompt(deps, { name: "a", description: "", body: "b" })
    createPrompt(deps, { name: "b", description: "", body: "b" })
    const r = editPrompt(deps, { name: "a", rename: "b" })
    expect(r.ok).toBe(false)
  })

  it("deletes an existing prompt", () => {
    createPrompt(deps, { name: "x", description: "", body: "b" })
    const r = deletePrompt(deps, "x")
    expect(r.ok).toBe(true)
    expect(loadPrompts(deps).prompts.length).toBe(0)
  })

  it("errors when deleting a missing prompt", () => {
    const r = deletePrompt(deps, "nope")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("no prompt named")
  })
})

describe("scope precedence", () => {
  it("project shadows user by slug", () => {
    const userDir = join(dir, "prompts")
    const projDir = join(dir, ".agents", "prompts")
    const scoped = defaultDeps({}, dir, false, {
      roots: [
        { scope: "project", dir: projDir },
        { scope: "user", dir: userDir },
      ],
    })
    createPrompt(
      { ...scoped, roots: [{ scope: "user", dir: userDir }] },
      {
        name: "x",
        description: "user",
        body: "USER",
      },
    )
    createPrompt(
      { ...scoped, roots: [{ scope: "user", dir: projDir }] },
      {
        name: "x",
        description: "proj",
        body: "PROJECT",
      },
    )
    const { prompts } = loadPrompts(scoped)
    expect(prompts.length).toBe(1)
    expect(prompts[0]!.scope).toBe("project")
    expect(prompts[0]!.body).toBe("PROJECT")
  })
})
