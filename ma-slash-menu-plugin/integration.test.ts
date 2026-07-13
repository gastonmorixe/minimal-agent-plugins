/**
 * End-to-end-ish integration tests for the slash-menu plugin.
 *
 * These tests wire the real handlers (handlers/on_key.ts and
 * handlers/on_buffer_changed.ts) to a minimal fake of the
 * HookHandlerContext / EventHandlerContext shapes the loader
 * provides. The FSM, scoring, rendering, and effect-application all
 * run as they would in production.
 *
 * The host-side footer painter is mocked as a closure that captures
 * every editor.footer.set emit. Assertions are made against those
 * captured payloads.
 *
 * Each test calls _resetForTests() to discard the singleton state.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import onBufferChanged from "./handlers/on_buffer_changed.ts"
import onKey from "./handlers/on_key.ts"
import type { CommandInfo, EventHandlerContext, HookHandlerContext } from "./lib/host-types.ts"
import { stripSgr } from "./lib/palette.ts"
import { _resetForTests, _setSkillsForTests, getFsmState } from "./lib/state.ts"
import type { Item } from "./lib/types.ts"

/** Hermetic skill fixtures — CI has no ~/.agents/skills. */
const FIXTURE_SKILLS: Item[] = [
  {
    slug: "swiftui-pro",
    description: "SwiftUI patterns",
    category: "skl",
    payload: { skillPath: "/fixture/swiftui-pro/SKILL.md" },
  },
  {
    slug: "swiftui-liquid-glass",
    description: "Liquid glass materials",
    category: "skl",
    payload: { skillPath: "/fixture/swiftui-liquid-glass/SKILL.md" },
  },
  {
    slug: "swift-concurrency-expert",
    description: "Swift concurrency",
    category: "skl",
    payload: { skillPath: "/fixture/swift-concurrency-expert/SKILL.md" },
  },
]

beforeEach(() => {
  _resetForTests()
  _setSkillsForTests(FIXTURE_SKILLS)
})

afterEach(() => {
  _resetForTests()
})

/** Registered commands the fake host exposes via ctx.listCommands(). */
const COMMANDS: CommandInfo[] = [
  { name: "config", summary: "Edit minimal-agent settings interactively", pluginId: "config" },
  { name: "memory", summary: "manage saved memories", pluginId: "memory" },
  { name: "tasks", summary: "show task list", pluginId: "tasks" },
  { name: "help", summary: "list shortcuts & commands", pluginId: "core" },
]

interface FootSet {
  channel: string
  lines: string[]
}

function mkCtx(): {
  hookCtx: HookHandlerContext
  eventCtx: <P>(payload: P) => EventHandlerContext<P>
  footerEmits: FootSet[]
  commandRuns: string[]
} {
  const footerEmits: FootSet[] = []
  const commandRuns: string[] = []
  const emit = (channel: string, payload?: unknown): void => {
    if (channel === "editor.footer.set" && typeof payload === "object" && payload !== null) {
      const p = payload as { lines?: unknown }
      if (Array.isArray(p.lines)) {
        footerEmits.push({ channel, lines: p.lines as string[] })
      }
    }
    if (channel === "command.run" && typeof payload === "object" && payload !== null) {
      const p = payload as { line?: unknown }
      if (typeof p.line === "string") commandRuns.push(p.line)
    }
  }
  const listCommands = (): CommandInfo[] => COMMANDS
  const hookCtx: HookHandlerContext = {
    channel: "editor.key",
    packageDir: process.cwd(),
    cwd: process.cwd(),
    env: { ...process.env } as Record<string, string>,
    abort: new AbortController().signal,
    priority: 70,
    emit,
    listCommands,
    stderr: process.stderr,
  }
  const eventCtx = <P>(payload: P): EventHandlerContext<P> => ({
    event: "editor.buffer.changed",
    payload,
    packageDir: process.cwd(),
    cwd: process.cwd(),
    env: { ...process.env } as Record<string, string>,
    emit,
    listCommands,
    abort: new AbortController().signal,
    stderr: process.stderr,
  })
  return { hookCtx, eventCtx, footerEmits, commandRuns }
}

function keyPayload(key: string, buffer = "", col = buffer.length) {
  return {
    key,
    buffer,
    cursor: {
      row: 0,
      col,
      visualRow: 0,
      rowsInLogicalLine: 1,
      totalLines: 1,
    },
    result: {} as { halt?: boolean; buffer?: string; cursor?: { row: number; col: number } },
  }
}

describe("integration — menu activation", () => {
  it("typing slash opens the menu and paints the footer", async () => {
    const { eventCtx, footerEmits } = mkCtx()
    await onBufferChanged(eventCtx({ text: "/", cursor: { row: 0, col: 1 } }))
    expect(getFsmState().kind).toBe("open")
    expect(footerEmits.length).toBe(1)
    expect(footerEmits[0]!.lines.length).toBeGreaterThan(0)
  })

  it("typing slash-conf opens with config selected at top", async () => {
    const { eventCtx, footerEmits } = mkCtx()
    await onBufferChanged(eventCtx({ text: "/conf", cursor: { row: 0, col: 5 } }))
    const lines = footerEmits[footerEmits.length - 1]!.lines
    const visible = lines.map(stripSgr).join("\n")
    expect(visible).toContain("/config")
  })

  it("typing dollar opens scoped to skills only", async () => {
    const { eventCtx, footerEmits } = mkCtx()
    await onBufferChanged(eventCtx({ text: "$", cursor: { row: 0, col: 1 } }))
    const lines = footerEmits[footerEmits.length - 1]!.lines.map(stripSgr)
    // Item rows have a $ sigil prefix somewhere on the line (after the
    // selection-arrow + category-icon gutter). Action slugs would use /
    // and never share the $ menu.
    const itemRows = lines.filter((l) => /\$[a-zA-Z]/.test(l))
    expect(itemRows.length).toBeGreaterThan(0)
    for (const row of itemRows) {
      expect(row).not.toMatch(/\/config|\/memory|\/tasks|\/help/)
    }
  })

  it("non-trigger buffer does NOT open the menu", async () => {
    const { eventCtx, footerEmits } = mkCtx()
    await onBufferChanged(eventCtx({ text: "hello", cursor: { row: 0, col: 5 } }))
    expect(getFsmState().kind).toBe("closed")
    expect(footerEmits.length).toBe(0)
  })

  it("trailing space closes an open menu", async () => {
    const { eventCtx, footerEmits } = mkCtx()
    await onBufferChanged(eventCtx({ text: "/config", cursor: { row: 0, col: 7 } }))
    expect(getFsmState().kind).toBe("open")
    await onBufferChanged(eventCtx({ text: "/config ", cursor: { row: 0, col: 8 } }))
    expect(getFsmState().kind).toBe("closed")
    expect(footerEmits[footerEmits.length - 1]!.lines).toEqual([])
  })
})

describe("integration — navigation while open", () => {
  it("ArrowDown moves selection and re-emits footer; halts key", async () => {
    const { hookCtx, eventCtx, footerEmits } = mkCtx()
    await onBufferChanged(eventCtx({ text: "/", cursor: { row: 0, col: 1 } }))
    const initialFooter = footerEmits.length
    const payload = keyPayload("ArrowDown", "/")
    onKey(payload, hookCtx)
    expect(payload.result.halt).toBe(true)
    expect(footerEmits.length).toBeGreaterThan(initialFooter)
  })

  it("ArrowUp at top stays at index 0", async () => {
    const { hookCtx, eventCtx } = mkCtx()
    await onBufferChanged(eventCtx({ text: "/", cursor: { row: 0, col: 1 } }))
    const payload = keyPayload("ArrowUp", "/")
    onKey(payload, hookCtx)
    const state = getFsmState()
    if (state.kind !== "open") throw new Error("narrow")
    expect(state.selectedIndex).toBe(0)
  })
})

describe("integration — selection", () => {
  it("Tab completes via result.buffer and halts", async () => {
    const { hookCtx, eventCtx } = mkCtx()
    await onBufferChanged(eventCtx({ text: "/conf", cursor: { row: 0, col: 5 } }))
    const payload = keyPayload("Tab", "/conf")
    onKey(payload, hookCtx)
    expect(payload.result.halt).toBe(true)
    expect(payload.result.buffer).toBe("/config ")
  })

  it("Enter on a command row dispatches via command.run + halts (no buffer submit)", async () => {
    const { hookCtx, eventCtx, footerEmits, commandRuns } = mkCtx()
    await onBufferChanged(eventCtx({ text: "/conf", cursor: { row: 0, col: 5 } }))
    const payload = keyPayload("Enter", "/conf")
    onKey(payload, hookCtx)
    // Command row → dispatch directly, halt the key, leave the buffer alone.
    expect(commandRuns).toEqual(["/config"])
    expect(payload.result.buffer).toBeUndefined()
    expect(payload.result.halt).toBe(true)
    expect(footerEmits[footerEmits.length - 1]!.lines).toEqual([])
    expect(getFsmState().kind).toBe("closed")
  })

  it("Escape halts and clears footer; buffer left alone", async () => {
    const { hookCtx, eventCtx, footerEmits } = mkCtx()
    await onBufferChanged(eventCtx({ text: "/conf", cursor: { row: 0, col: 5 } }))
    const payload = keyPayload("Escape", "/conf")
    onKey(payload, hookCtx)
    expect(payload.result.halt).toBe(true)
    expect(payload.result.buffer).toBeUndefined()
    expect(footerEmits[footerEmits.length - 1]!.lines).toEqual([])
    expect(getFsmState().kind).toBe("closed")
  })
})

describe("integration — pass-through (menu closed)", () => {
  it("keys are no-ops when menu is closed; halt is left unset", () => {
    const { hookCtx } = mkCtx()
    for (const k of ["Tab", "Enter", "Escape", "ArrowUp", "ArrowDown"]) {
      const payload = keyPayload(k, "hello")
      onKey(payload, hookCtx)
      expect(payload.result.halt).toBeUndefined()
      expect(payload.result.buffer).toBeUndefined()
    }
  })

  it("unknown keys are silently dropped (no exception)", () => {
    const { hookCtx } = mkCtx()
    const payload = keyPayload("F1", "/conf")
    expect(() => onKey(payload, hookCtx)).not.toThrow()
  })
})

describe("integration — filter typing", () => {
  it("re-firing same buffer-changed preserves selection; different query resets to 0", async () => {
    const { hookCtx, eventCtx } = mkCtx()
    await onBufferChanged(eventCtx({ text: "/swift", cursor: { row: 0, col: 6 } }))
    onKey(keyPayload("ArrowDown", "/swift"), hookCtx)
    let state = getFsmState()
    if (state.kind !== "open") throw new Error("narrow")
    const moved = state.selectedIndex
    expect(moved).toBe(1)
    await onBufferChanged(eventCtx({ text: "/swift", cursor: { row: 0, col: 6 } }))
    state = getFsmState()
    if (state.kind !== "open") throw new Error("narrow")
    expect(state.selectedIndex).toBe(moved)
    await onBufferChanged(eventCtx({ text: "/swiftu", cursor: { row: 0, col: 7 } }))
    state = getFsmState()
    if (state.kind !== "open") throw new Error("narrow")
    expect(state.selectedIndex).toBe(0)
  })
})
