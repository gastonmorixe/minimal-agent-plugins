/**
 * End-to-end handler tests: the `&` menu arm path and the turn expansion.
 *
 * These drive the REAL handlers (`on_buffer_changed`, `on_key`,
 * `on_turn_will_start`) with fake host contexts, so the wiring is exercised
 * end to end, not just the pure modules.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import onBufferChanged from "../handlers/on_buffer_changed.ts"
import onKey from "../handlers/on_key.ts"
import onTurnWillStart from "../handlers/on_turn_will_start.ts"
import type { EventHandlerContext, HookHandlerContext } from "../lib/host-types.ts"
import { _resetForTests, getFsmState } from "../lib/menu.ts"
import { createPrompt, defaultDeps } from "../lib/store.ts"

let dir: string
const savedHome = process.env.HOME
const savedMaHome = process.env.MINIMAL_AGENT_HOME

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ma-prompts-e2e-"))
  process.env.HOME = dir
  delete process.env.MINIMAL_AGENT_HOME
  _resetForTests()
  // Seed one prompt into the sandboxed user store.
  createPrompt(defaultDeps({ HOME: dir } as Record<string, string>, dir, false), {
    name: "review-pr",
    description: "review a PR",
    body: "REVIEW THE PR CAREFULLY",
  })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (savedHome !== undefined) process.env.HOME = savedHome
  if (savedMaHome !== undefined) process.env.MINIMAL_AGENT_HOME = savedMaHome
  _resetForTests()
})

function hookCtx(): { ctx: HookHandlerContext; emitted: Array<[string, unknown]> } {
  const emitted: Array<[string, unknown]> = []
  return {
    emitted,
    ctx: {
      channel: "editor.key",
      packageDir: dir,
      cwd: dir,
      env: { ...process.env } as Record<string, string>,
      abort: new AbortController().signal,
      priority: 60,
      emit: (channel, payload) => emitted.push([channel, payload]),
      stderr: process.stderr,
    },
  }
}

function eventCtx(payload: unknown): {
  ctx: EventHandlerContext
  emitted: Array<[string, unknown]>
} {
  const emitted: Array<[string, unknown]> = []
  return {
    emitted,
    ctx: {
      event: "editor.buffer.changed",
      payload,
      packageDir: dir,
      cwd: dir,
      env: { ...process.env } as Record<string, string>,
      emit: (channel, p) => emitted.push([channel, p]),
      abort: new AbortController().signal,
      stderr: process.stderr,
    },
  }
}

describe("menu arm path (real handlers)", () => {
  it("typing `&rev` opens the menu and paints a footer", async () => {
    const { ctx, emitted } = eventCtx({ text: "&rev", cursor: { row: 0, col: 4 } })
    await onBufferChanged(ctx)
    expect(getFsmState().kind).toBe("open")
    const footer = emitted.find(([c]) => c === "editor.footer.set")
    expect(footer).toBeDefined()
    const lines = (footer![1] as { lines: string[] }).lines
    expect(lines.length).toBeGreaterThan(0)
  })

  it("a buffer without `&` never opens the menu", async () => {
    const { ctx } = eventCtx({ text: "hello world", cursor: { row: 0, col: 11 } })
    await onBufferChanged(ctx)
    expect(getFsmState().kind).toBe("closed")
  })

  it("deleting the `&` from an open menu closes it", async () => {
    const opened = eventCtx({ text: "&rev", cursor: { row: 0, col: 4 } })
    await onBufferChanged(opened.ctx)
    expect(getFsmState().kind).toBe("open")

    const { ctx, emitted } = eventCtx({ text: "rev", cursor: { row: 0, col: 3 } })
    await onBufferChanged(ctx)
    expect(getFsmState().kind).toBe("closed")
    const footer = emitted.find(([c]) => c === "editor.footer.set")
    expect((footer![1] as { lines: string[] }).lines).toEqual([])
  })

  it("Enter on the open menu inserts the name and halts the key", async () => {
    const opened = eventCtx({ text: "&rev", cursor: { row: 0, col: 4 } })
    await onBufferChanged(opened.ctx)
    expect(getFsmState().kind).toBe("open")

    const { ctx } = hookCtx()
    const payload = {
      key: "Enter",
      buffer: "&rev",
      cursor: { row: 0, col: 4 },
      result: {} as Record<string, unknown>,
    }
    await onKey(payload, ctx)
    expect(payload.result.halt).toBe(true)
    expect(payload.result.buffer).toBe("&review-pr ")
  })

  it("Alt+Enter inserts the body and halts", async () => {
    const opened = eventCtx({ text: "&rev", cursor: { row: 0, col: 4 } })
    await onBufferChanged(opened.ctx)

    const { ctx } = hookCtx()
    const payload = {
      key: "Alt+Enter",
      buffer: "&rev",
      cursor: { row: 0, col: 4 },
      result: {} as Record<string, unknown>,
    }
    await onKey(payload, ctx)
    expect(payload.result.halt).toBe(true)
    expect(payload.result.buffer).toBe("REVIEW THE PR CAREFULLY")
  })

  it("Alt+Enter with the menu CLOSED does not halt (falls through to newline)", async () => {
    const { ctx } = hookCtx()
    const payload = {
      key: "Alt+Enter",
      buffer: "just text",
      cursor: { row: 0, col: 9 },
      result: {} as Record<string, unknown>,
    }
    await onKey(payload, ctx)
    expect(payload.result.halt).toBeUndefined()
  })
})

describe("turn.willStart expansion (real handler)", () => {
  it("expands `&name` to the body", () => {
    const { ctx } = hookCtx()
    const out = onTurnWillStart({ text: "please &review-pr now" }, ctx) as
      | { payload: { text: string } }
      | undefined
    expect(out?.payload.text).toBe("please REVIEW THE PR CAREFULLY now")
  })

  it("passes through text with no sigil", () => {
    const { ctx } = hookCtx()
    const out = onTurnWillStart({ text: "nothing here" }, ctx)
    expect(out).toBeUndefined()
  })

  it("leaves an unknown token untouched", () => {
    const { ctx } = hookCtx()
    const out = onTurnWillStart({ text: "&nope" }, ctx)
    expect(out).toBeUndefined()
  })
})
