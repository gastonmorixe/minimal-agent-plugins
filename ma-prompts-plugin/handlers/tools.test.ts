/**
 * Tool-handler tests for the prompt tools.
 *
 * `$HOME` is sandboxed to a temp dir and any inherited `MINIMAL_AGENT_HOME`
 * is cleared, because `agentHome` reads both. The real library is never
 * touched.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import promptDelete from "../handlers/prompt_delete.ts"
import promptEdit from "../handlers/prompt_edit.ts"
import promptList from "../handlers/prompt_list.ts"
import promptNew from "../handlers/prompt_new.ts"
import promptShow from "../handlers/prompt_show.ts"
import type { TUIContext } from "../lib/host-types.ts"
import { _resetForTests } from "../lib/menu.ts"

let dir: string
const savedHome = process.env.HOME
const savedMaHome = process.env.MINIMAL_AGENT_HOME

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ma-prompts-handler-"))
  process.env.HOME = dir
  delete process.env.MINIMAL_AGENT_HOME
  _resetForTests()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (savedHome !== undefined) process.env.HOME = savedHome
  if (savedMaHome !== undefined) process.env.MINIMAL_AGENT_HOME = savedMaHome
  _resetForTests()
})

function ctx(input: Record<string, unknown>): TUIContext {
  return {
    trigger: { type: "tool", name: "Prompt", input },
    packageDir: dir,
    cwd: dir,
    env: { ...process.env } as Record<string, string>,
    abort: new AbortController().signal,
    stdout: process.stdout,
    stdin: process.stdin,
    stderr: process.stderr,
    log: {
      emergency() {},
      alert() {},
      critical() {},
      error() {},
      warn() {},
      notice() {},
      info() {},
      debug() {},
    },
  }
}

describe("PromptNew", () => {
  it("saves a prompt and reports success", async () => {
    const r = await promptNew(ctx({ name: "review-pr", body: "BODY", description: "d" }))
    expect(r.kind).toBe("tool_result")
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBeFalsy()
    expect(r.content).toContain("review-pr")
  })

  it("errors without a name", async () => {
    const r = await promptNew(ctx({ body: "BODY" }))
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBe(true)
  })

  it("errors on a collision", async () => {
    await promptNew(ctx({ name: "x", body: "one" }))
    const r = await promptNew(ctx({ name: "x", body: "two" }))
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBe(true)
  })
})

describe("PromptList / Show / Edit / Delete", () => {
  it("lists saved prompts", async () => {
    await promptNew(ctx({ name: "a", body: "A" }))
    const r = await promptList(ctx({}))
    if (r.kind !== "tool_result") return
    expect(r.content).toContain("a")
  })

  it("shows a body", async () => {
    await promptNew(ctx({ name: "a", body: "THE BODY" }))
    const r = await promptShow(ctx({ name: "a" }))
    if (r.kind !== "tool_result") return
    expect(r.content).toBe("THE BODY")
  })

  it("errors showing a missing prompt", async () => {
    const r = await promptShow(ctx({ name: "nope" }))
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBe(true)
  })

  it("edits a body", async () => {
    await promptNew(ctx({ name: "a", body: "one" }))
    const r = await promptEdit(ctx({ name: "a", body: "two" }))
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBeFalsy()
    const shown = await promptShow(ctx({ name: "a" }))
    if (shown.kind === "tool_result") expect(shown.content).toBe("two")
  })

  it("deletes a prompt", async () => {
    await promptNew(ctx({ name: "a", body: "one" }))
    const r = await promptDelete(ctx({ name: "a" }))
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBeFalsy()
    const listed = await promptList(ctx({}))
    if (listed.kind === "tool_result") expect(listed.content).not.toContain('"a"')
  })

  it("errors deleting a missing prompt", async () => {
    const r = await promptDelete(ctx({ name: "nope" }))
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBe(true)
  })
})
