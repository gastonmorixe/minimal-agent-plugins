/**
 * P2: the paste display handler with the real codec (the plugins sideband
 * fixture) and the real core `sessions:files` API on a temp dir. No tag
 * literals: each tag comes from the codec.
 *
 * @module ma-paste-plugin/handlers/display.test
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { createSessionFilesApi } from "@minimal-agent/core/host/session-files"
import type {
  PluginHost,
  SessionFilesApi,
} from "@minimal-agent/core/plugin-api/types/host-capabilities"
import type { SidebandDisplayContext } from "@minimal-agent/core/plugin-api/types/plugin"
import type { SidebandApi, SidebandNode } from "@minimal-agent/core/plugin-api/types/sideband"

import { pluginSideband } from "../../tests/support/sideband.ts"

import display from "./display.ts"

const SB: SidebandApi = await pluginSideband()

/** A chip label from its inner text (no bracket literal in this file). */
const chip = (inner: string): string => `[${inner}]`
const SID = "sid-paste-display"

const root = mkdtempSync(join(tmpdir(), "paste-display-"))
const sessionsDir = join(root, "sessions")
const files: SessionFilesApi = createSessionFilesApi({ sessionsDir, pluginId: "paste" })
const pasteDir = join(sessionsDir, `${SID}.files`, "paste")
mkdirSync(sessionsDir, { recursive: true })
writeFileSync(join(sessionsDir, `${SID}.jsonl`), "")

/** The config path before this file: the default cap must not come from the developer config. */
const prevConfig = process.env.MINIMAL_AGENT_CONFIG
process.env.MINIMAL_AGENT_CONFIG = join(root, "no-config.jsonc")

afterAll(() => {
  if (prevConfig === undefined) delete process.env.MINIMAL_AGENT_CONFIG
  else process.env.MINIMAL_AGENT_CONFIG = prevConfig
  rmSync(root, { recursive: true, force: true })
})

let n = 0
/** Save a paste file and give its id. */
function save(content: string): string {
  n++
  const id = `d${String(n).padStart(4, "0")}`
  expect(files.create(SID, `${id}.txt`, content)).toBe("ok")
  return id
}

/** The parsed node of a ref (the attrs as the text hook writes them). */
function node(id: string, bytes = 7, lines = 3, body?: string): SidebandNode {
  const text = SB.render("paste", { attrs: { id, bytes, lines }, ...(body ? { body } : {}) })
  const found = SB.find(text, { kinds: ["paste"] })[0]
  if (!found) throw new Error("no node")
  return found
}

/** A spy host: it counts each call of the file API. */
function spyHost(api: SessionFilesApi = files) {
  const calls: string[] = []
  const spy: SessionFilesApi = {
    create: (...a) => api.create(...a),
    read: (...a) => (calls.push("read"), api.read(...a)),
    readHead: (...a) => (calls.push("readHead"), api.readHead?.(...a) ?? null),
    stat: (...a) => (calls.push("stat"), api.stat(...a)),
    usage: (...a) => api.usage(...a),
  }
  return { calls, host: { sessionFiles: spy } as unknown as PluginHost }
}

function ctx(over: Partial<SidebandDisplayContext> = {}): SidebandDisplayContext {
  return {
    sid: SID,
    mode: "full",
    sideband: SB,
    host: { sessionFiles: files } as unknown as PluginHost,
    ...over,
  }
}

describe("paste display: no file read", () => {
  test("label from attrs with no sid or no host", () => {
    const id = save("abc\n")
    expect(display(node(id), ctx({ sid: undefined }))).toEqual({
      label: chip(`Paste #${id} 7B 3L`),
    })
    expect(display(node(id), ctx({ host: undefined }))).toEqual({
      label: chip(`Paste #${id} 7B 3L`),
    })
  })

  test("bad id gives ? and missing, no read", () => {
    const { calls, host } = spyHost()
    for (const bad of ["ABCDE", "abc", "../../x", "abcdef"]) {
      const out = display(node(bad), ctx({ host }))
      expect(out).toEqual({ label: chip("Paste #? missing"), missing: true })
      expect(out?.label).not.toContain(bad)
    }
    expect(calls).toEqual([])
  })

  test("not self-closing gives the label and no text", () => {
    const id = save("abc\n")
    const { calls, host } = spyHost()
    const out = display(node(id, 3, 1, "body"), ctx({ host }))
    expect(out).toEqual({ label: chip(`Paste #${id} 3B 1L`) })
    expect(calls).toEqual([])
  })
})

describe("paste display: label mode", () => {
  test("stat hit and miss", () => {
    const id = save("hello\nworld\n")
    const { calls, host } = spyHost()
    // The bytes come from the file, the lines from the attrs.
    expect(display(node(id, 1, 9), ctx({ mode: "label", host }))).toEqual({
      label: chip(`Paste #${id} 12B 9L`),
    })
    expect(display(node("zzzzz"), ctx({ mode: "label", host }))).toEqual({
      label: chip("Paste #zzzzz missing"),
      missing: true,
    })
    expect(calls).toEqual(["stat", "stat"])
  })

  test("maxBytes 0 gives a label only", () => {
    const id = save("x".repeat(50))
    const { calls, host } = spyHost()
    const out = display(node(id, 1, 1), ctx({ maxBytes: 0, host }))
    expect(out).toEqual({ label: chip(`Paste #${id} 50B 1L`) })
    expect(calls).toEqual(["stat"])
  })
})

describe("paste display: full mode", () => {
  test("body is the exact file text, with the file size and lines", () => {
    const body = "line 1\r\nline 2\n\tx < y & z\n"
    const id = save(body)
    const { calls, host } = spyHost()
    const out = display(node(id, 1, 1), ctx({ host }))
    expect(out).toEqual({ label: chip(`Paste #${id} 26B 3L`), text: body })
    expect(calls).toEqual(["readHead"])
  })

  test("a nested ref in the file text stays as it is (no neutralize)", () => {
    const inner = SB.render("paste", { attrs: { id: "aaaaa" } })
    const id = save(`see ${inner}\n`)
    expect(display(node(id), ctx())?.text).toBe(`see ${inner}\n`)
  })

  test("cap with marker on a UTF-8 boundary", () => {
    // 3 bytes for each char: a cap of 10 keeps 3 chars (9 bytes).
    const body = "\u20ac".repeat(10)
    const id = save(body)
    const out = display(node(id, 1, 1), ctx({ maxBytes: 10 }))
    expect(out).toEqual({
      label: chip(`Paste #${id} 30B 1L`),
      text: `${"\u20ac".repeat(3)}\n[... 21 more bytes]`,
      truncated: true,
    })
  })

  test("the cap at the file size gives the whole file", () => {
    const id = save("abcd\nef\n")
    expect(display(node(id, 1, 1), ctx({ maxBytes: 8 }))).toEqual({
      label: chip(`Paste #${id} 8B 2L`),
      text: "abcd\nef\n",
    })
  })

  test("default cap is 65536 bytes from the config", () => {
    const id = save("y".repeat(70_000))
    const out = display(node(id, 1, 1), ctx())
    expect(out?.truncated).toBe(true)
    expect(out?.text).toBe(`${"y".repeat(65536)}\n[... ${70_000 - 65536} more bytes]`)
    expect(out?.label).toBe(chip(`Paste #${id} 70.0kB 1L`))
  })

  test("missing file gives the missing label, no text", () => {
    expect(display(node("nofil"), ctx())).toEqual({
      label: chip("Paste #nofil missing"),
      missing: true,
    })
  })

  test("a host with no readHead uses read and stat", () => {
    const id = save("q".repeat(20))
    const { readHead: _drop, ...rest } = files
    const out = display(node(id, 1, 1), ctx({ maxBytes: 5, host: { sessionFiles: rest } as never }))
    expect(out).toEqual({
      label: chip(`Paste #${id} 20B 1L`),
      text: "qqqqq\n[... 15 more bytes]",
      truncated: true,
    })
  })

  test("an old host read that ignores maxBytes: the plugin cuts on a UTF-8 boundary", () => {
    // 3 bytes for each char: a cap of 7 keeps 2 chars (6 bytes).
    const id = save("\u20ac".repeat(10))
    const { readHead: _drop, read, ...rest } = files
    const old = { ...rest, read: (s: string, name: string) => read(s, name) }
    const out = display(node(id, 1, 1), ctx({ maxBytes: 7, host: { sessionFiles: old } as never }))
    expect(out).toEqual({
      label: chip(`Paste #${id} 30B 1L`),
      text: `${"\u20ac".repeat(2)}\n[... 24 more bytes]`,
      truncated: true,
    })
  })
})

describe("paste display: unsafe files (real core API)", () => {
  test("a symlink is missing, in full and label mode", () => {
    const target = join(root, "secret.txt")
    writeFileSync(target, "secret\n")
    save("seed")
    symlinkSync(target, join(pasteDir, "slink.txt"))
    for (const mode of ["full", "label"] as const) {
      expect(display(node("slink"), ctx({ mode }))).toEqual({
        label: chip("Paste #slink missing"),
        missing: true,
      })
    }
  })

  const hasMkfifo = Bun.which("mkfifo") !== null
  test.skipIf(!hasMkfifo)("a FIFO is missing and does not block", () => {
    save("seed")
    const p = join(pasteDir, "fifo1.txt")
    expect(Bun.spawnSync(["mkfifo", p]).exitCode).toBe(0)
    const t0 = performance.now()
    for (const mode of ["full", "label"] as const) {
      expect(display(node("fifo1"), ctx({ mode }))).toEqual({
        label: chip("Paste #fifo1 missing"),
        missing: true,
      })
    }
    expect(performance.now() - t0).toBeLessThan(1000)
  })
})

describe("paste display: never throws", () => {
  test("a throwing host gives undefined", () => {
    const boom = (): never => {
      throw new Error("boom")
    }
    const host = {
      sessionFiles: { create: boom, read: boom, readHead: boom, stat: boom, usage: boom },
    } as unknown as PluginHost
    expect(display(node("abcde"), ctx({ host }))).toBeUndefined()
    expect(display(node("abcde"), ctx({ host, mode: "label" }))).toBeUndefined()
  })

  test("a throwing sideband gives undefined", () => {
    const sideband = {
      ...SB,
      attrs: () => {
        throw new Error("boom")
      },
    }
    expect(display(node("abcde"), ctx({ sideband }))).toBeUndefined()
  })
})
