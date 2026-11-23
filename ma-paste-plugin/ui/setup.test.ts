/**
 * U9: the text paste hook and `ui.setup`, with the real codec (the plugins
 * sideband fixture). No tag literals.
 *
 * @module ma-paste-plugin/ui/setup.test
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { createSessionFilesApi } from "@minimal-agent/core/host/session-files"
import { NO_SIDEBAND } from "@minimal-agent/core/host/sideband"
import type { SessionFileCreate } from "@minimal-agent/core/plugin-api/types/host-capabilities"
import type { SidebandApi } from "@minimal-agent/core/plugin-api/types/sideband"

import { pluginSideband } from "../../tests/support/sideband.ts"
import { defaultPasteConfig } from "../lib/config.ts"
import type {
  BoundSessionFiles,
  ChipDef,
  PasteUiContext,
  PluginPasteEvent,
  PluginPasteHook,
} from "../lib/host-types.ts"

import setup, { MAX_CREATE_TRIES, makeTextPasteHook, TEXT_HOOK_PRIORITY } from "./setup.ts"

/** A chip label: the text in square brackets. */
const chip = (inner: string): string => `[${inner}]`

const SB: SidebandApi = await pluginSideband()
const SID = "sid-setup"

const root = mkdtempSync(join(tmpdir(), "paste-setup-"))
const api = createSessionFilesApi({ sessionsDir: join(root, "sessions"), pluginId: "paste" })

/** The API asks for the session file of a sid (`<sid>.jsonl`). */
function openSession(dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${SID}.jsonl`), "")
}
openSession(join(root, "sessions"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A bound files api over the real core api, with a log of creates. */
function realFiles(): BoundSessionFiles & { creates: string[] } {
  const creates: string[] = []
  return {
    creates,
    create(name, data) {
      creates.push(name)
      return api.create(SID, name, data)
    },
    stat: (name) => api.stat(SID, name),
  }
}

/** A files api that answers with a fixed sequence of results. */
function fakeFiles(results: SessionFileCreate[]): BoundSessionFiles & { creates: string[] } {
  const creates: string[] = []
  return {
    creates,
    create(name) {
      creates.push(name)
      return results[creates.length - 1] ?? "ok"
    },
    stat: () => null,
  }
}

function ev(text: string, over: Partial<PluginPasteEvent> = {}): PluginPasteEvent {
  return { text, source: "bracketed", sid: SID, sideband: SB, ...over }
}

let idN = 0
const seqId = (): string => `s${String(++idN).padStart(4, "0")}`

const ALWAYS = { minLines: 0, minBytes: 0, floorBytes: 0 }

describe("text paste hook (U9)", () => {
  test("one create; the insert is the codec ref with bytes and lines; CRLF and CR become LF", () => {
    const files = realFiles()
    const hook = makeTextPasteHook({ collapse: ALWAYS, newId: seqId })
    const out = hook.onPaste(ev("a\r\nb\rcé\n", { files }))
    expect(files.creates.length).toBe(1)
    const id = files.creates[0]?.replace(/\.txt$/, "") ?? ""
    expect(out).toEqual({ insert: SB.render("paste", { attrs: { id, bytes: 8, lines: 3 } }) })
    expect(api.read(SID, `${id}.txt`)).toBe("a\nb\ncé\n")
    const node = SB.find(out?.insert ?? "", { kinds: ["paste"] })[0]
    expect(node?.selfClosing).toBe(true)
    expect(out?.insert).not.toContain("\n")
  })

  test("the default id is 5 chars of [0-9a-z]", () => {
    const files = realFiles()
    makeTextPasteHook({ collapse: ALWAYS }).onPaste(ev("x", { files }))
    expect(files.creates[0]).toMatch(/^[0-9a-z]{5}\.txt$/)
  })

  test("other text is kept exactly (tabs, spaces, trailing space)", () => {
    const files = realFiles()
    makeTextPasteHook({ collapse: ALWAYS, newId: seqId }).onPaste(ev("\t x  \n\n y ", { files }))
    expect(api.read(SID, files.creates[0] ?? "")).toBe("\t x  \n\n y ")
  })

  test("null on !sb.ready, no files, blank text", () => {
    const hook = makeTextPasteHook({ collapse: ALWAYS, newId: seqId })
    const files = fakeFiles([])
    expect(hook.onPaste(ev("text", { files, sideband: NO_SIDEBAND }))).toBeNull()
    expect(hook.onPaste(ev("text"))).toBeNull()
    expect(hook.onPaste(ev("", { files }))).toBeNull()
    expect(hook.onPaste(ev(" \n\t\r\n", { files }))).toBeNull()
    expect(files.creates).toEqual([])
  })

  test("null below the collapse threshold", () => {
    const files = fakeFiles([])
    const hook = makeTextPasteHook({
      collapse: { minLines: 3, minBytes: 200, floorBytes: 0 },
      newId: seqId,
    })
    expect(hook.onPaste(ev("one\ntwo", { files }))).toBeNull()
    expect(files.creates).toEqual([])
    expect(hook.onPaste(ev("1\n2\n3", { files }))).not.toBeNull()
    expect(hook.onPaste(ev("x".repeat(200), { files }))).not.toBeNull()
  })

  test("default limits: small stuff stays literal, a big paste collapses", () => {
    const files = fakeFiles([])
    const hook = makeTextPasteHook({ collapse: defaultPasteConfig().collapse, newId: seqId })
    expect(hook.onPaste(ev("npm run build", { files }))).toBeNull()
    expect(hook.onPaste(ev("a\nb\nc\nd\n", { files }))).toBeNull()
    expect(hook.onPaste(ev(`${"x".repeat(60)}\n`.repeat(3), { files }))).toBeNull()
    expect(files.creates).toEqual([])
    expect(hook.onPaste(ev(`${"x".repeat(40)}\n`.repeat(4), { files }))).not.toBeNull()
    expect(hook.onPaste(ev("y".repeat(1200), { files }))).not.toBeNull()
  })

  test("retry on exists, with a new id each time", () => {
    const files = fakeFiles(["exists", "exists", "ok"])
    const out = makeTextPasteHook({ collapse: ALWAYS, newId: seqId }).onPaste(ev("x", { files }))
    expect(files.creates.length).toBe(3)
    expect(new Set(files.creates).size).toBe(3)
    const id = files.creates[2]?.replace(/\.txt$/, "")
    expect(out).toEqual({ insert: SB.render("paste", { attrs: { id, bytes: 1, lines: 1 } }) })
  })

  test("a real exists: the hook takes the next id", () => {
    const files = realFiles()
    expect(api.create(SID, "dup01.txt", "old")).toBe("ok")
    const ids = ["dup01", "dup02"]
    const hook = makeTextPasteHook({ collapse: ALWAYS, newId: () => ids.shift() ?? "dup03" })
    const out = hook.onPaste(ev("new", { files }))
    expect(files.creates).toEqual(["dup01.txt", "dup02.txt"])
    expect(api.read(SID, "dup01.txt")).toBe("old")
    expect(out?.insert).toBe(SB.render("paste", { attrs: { id: "dup02", bytes: 3, lines: 1 } }))
  })

  test(`${MAX_CREATE_TRIES} exists in a row gives null and one warning`, () => {
    const warns: string[] = []
    const files = fakeFiles(Array(20).fill("exists"))
    const hook = makeTextPasteHook({
      collapse: ALWAYS,
      newId: seqId,
      warn: (c) => warns.push(c),
    })
    expect(hook.onPaste(ev("x", { files }))).toBeNull()
    expect(files.creates.length).toBe(MAX_CREATE_TRIES)
    expect(warns).toEqual(["paste.exists"])
  })

  test("over-cap and error give null and one warning each (not repeated)", () => {
    const warns: string[] = []
    const hook = makeTextPasteHook({
      collapse: ALWAYS,
      newId: seqId,
      warn: (c) => warns.push(c),
    })
    expect(hook.onPaste(ev("x", { files: fakeFiles(["over-cap"]) }))).toBeNull()
    expect(hook.onPaste(ev("x", { files: fakeFiles(["over-cap"]) }))).toBeNull()
    expect(hook.onPaste(ev("x", { files: fakeFiles(["error"]) }))).toBeNull()
    expect(warns).toEqual(["paste.over-cap", "paste.error"])
  })

  test("a real over-cap from the core caps", () => {
    const small = createSessionFilesApi({
      sessionsDir: join(root, "small"),
      pluginId: "paste",
      caps: { maxFileBytes: 4 },
    })
    openSession(join(root, "small"))
    const files: BoundSessionFiles = {
      create: (name, data) => small.create(SID, name, data),
      stat: (name) => small.stat(SID, name),
    }
    const hook = makeTextPasteHook({ collapse: ALWAYS, newId: seqId })
    expect(hook.onPaste(ev("12345", { files }))).toBeNull()
    expect(hook.onPaste(ev("1234", { files }))).not.toBeNull()
  })
})

describe("setup", () => {
  const base = { pluginId: "paste", packageDir: "/x", tui: {} } as unknown as PasteUiContext

  test("no ctx.paste and no ctx.chips: no throw, no-op", () => {
    expect(() => setup(base)).not.toThrow()
  })

  test("registers the text hook at priority 50 and the paste chip", () => {
    const hooks: PluginPasteHook[] = []
    const chips: ChipDef[] = []
    setup({
      ...base,
      paste: {
        registerHook: (h) => {
          hooks.push(h)
          return () => {}
        },
      },
      chips: {
        register: (c) => {
          chips.push(c)
          return () => {}
        },
      },
    })
    expect(hooks.map((h) => [h.id, h.priority])).toEqual([["paste.text", TEXT_HOOK_PRIORITY]])
    expect(chips.map((c) => c.kind)).toEqual(["paste"])
    expect(chips[0]?.label({ id: "u194m", bytes: "130", lines: "129" }, true)).toBe(
      chip("Paste #u194m 130B 129L"),
    )
    expect(chips[0]?.label({ id: "u194m" }, false)).toBe(chip("Paste #u194m missing"))
  })
})
