/**
 * Paste refs in the `SessionHistory` dump. The expected strings are the same
 * as in the twin test of the CLI `sessions dump`
 * (`minimal-agent-cli/src/commands/session-dump-paste.test.ts`): the two
 * dumps must stay equal.
 */

import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { pluginSideband } from "../../tests/support/sideband.ts"
import handler from "../handlers/session_history.ts"

import { dumpMarkdown, dumpXml } from "./dump-from-data.ts"
import type { MessageLike, SessionRecordsView, SessionsReadApi } from "./host-types.ts"
import { pasteFileReader, pasteMarkdown } from "./paste-refs.ts"

const sb = await pluginSideband()

const SID = "paste-dump-sid"
const dir = join(import.meta.dir, ".paste-dump-sessions")
const pasteDir = join(dir, `${SID}.files`, "paste")
mkdirSync(pasteDir, { recursive: true })
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const BODY = "line one\nhas ``` fence\nline three\n"
writeFileSync(join(pasteDir, "abc12.txt"), BODY)
// A secret next to the sessions dir: a bad id must never reach it.
writeFileSync(join(dir, "secret.txt"), "SECRET")
writeFileSync(join(pasteDir, "ok.txt"), "SECRET")
symlinkSync(join(dir, "secret.txt"), join(pasteDir, "lnk99.txt"))

const read = pasteFileReader(dir, SID)

function ref(id: string): string {
  return sb.render("paste", { attrs: { id, bytes: 1, lines: 1 } })
}

function session(content: MessageLike["content"]): SessionRecordsView {
  return { sid: SID, meta: null, records: [], messages: [{ role: "user", content }] }
}

describe("dump of paste refs", () => {
  test("paste ref with a file: label and body, no raw tag (markdown)", () => {
    const md = dumpMarkdown(session(`see ${ref("abc12")} done`), sb, { readPaste: read })
    expect(md).toBe(
      "## User\n\nsee \n[Paste #abc12 34B 3L]\n````\nline one\nhas ``` fence\nline three\n````\n done\n",
    )
    expect(sb.has(md, { kinds: ["paste"] })).toBe(false)
  })

  test("paste ref with a file in a text block (xml)", () => {
    const xml = dumpXml(session([{ type: "text", text: `a ${ref("abc12")}` }]), sb, {
      readPaste: read,
    })
    expect(xml).toBe(
      '<session>\n  <turn role="user">\n    <text>a <paste id="abc12" label="[Paste #abc12 34B 3L]">line one\nhas ``` fence\nline three\n</paste></text>\n  </turn>\n</session>\n',
    )
    expect(sb.has(xml, { kinds: ["paste"] })).toBe(false)
  })

  test("missing file: missing label (markdown and xml)", () => {
    const s = session(`x ${ref("zzzzz")} y`)
    expect(dumpMarkdown(s, sb, { readPaste: read })).toBe("## User\n\nx [Paste #zzzzz missing] y\n")
    const xml = dumpXml(s, sb, { readPaste: read })
    expect(xml).toContain('<paste id="zzzzz" label="[Paste #zzzzz missing]" missing="true"/>')
    expect(sb.has(xml, { kinds: ["paste"] })).toBe(false)
  })

  test("no reader: each ref shows as missing", () => {
    const md = dumpMarkdown(session(ref("abc12")), sb)
    expect(md).toContain("Paste #abc12 missing")
    expect(md).not.toContain("line one")
  })

  test("bad id: no file read outside the paste dir", () => {
    for (const id of ["../../secret", "ok", "../ok", "ABC12"]) {
      const md = dumpMarkdown(session(ref(id)), sb, { readPaste: read })
      expect(md).not.toContain("SECRET")
      expect(md).toContain(`Paste #${id} missing`)
      expect(sb.has(md, { kinds: ["paste"] })).toBe(false)
    }
  })

  test("a symlink in the paste dir is not followed", () => {
    expect(read("lnk99")).toBeNull()
    const md = dumpMarkdown(session(ref("lnk99")), sb, { readPaste: read })
    expect(md).not.toContain("SECRET")
  })

  test("unsafe sid: the reader finds nothing", () => {
    expect(pasteFileReader(dir, "../x")("abc12")).toBeNull()
  })

  test("assistant text and text with no ref do not change", () => {
    const s: SessionRecordsView = {
      sid: SID,
      meta: null,
      records: [],
      messages: [
        { role: "user", content: "plain `text`" },
        { role: "assistant", content: [{ type: "text", text: ref("abc12") }] },
      ],
    }
    const md = dumpMarkdown(s, sb, { readPaste: read })
    expect(md).toContain("plain `text`")
    expect(md).not.toContain("line one")
  })

  test("no codec: the text does not change", () => {
    const t = `a ${ref("abc12")}`
    expect(pasteMarkdown(t, undefined, read)).toBe(t)
  })

  test("SessionHistory dump reads the paste file through host.paths", async () => {
    const sessions = {
      async records(sid: string) {
        return sid === SID ? session(`see ${ref("abc12")}`) : null
      },
      async list() {
        return { items: [], total: 0 }
      },
    } as unknown as SessionsReadApi
    const r = await handler({
      trigger: { type: "tool", name: "SessionHistory", input: { action: "dump", sid: SID } },
      cwd: "/proj",
      host: { sessions, paths: { sessionsDir: () => dir } },
      sideband: sb,
    })
    expect(r.is_error).toBeFalsy()
    expect(r.content).toContain("[Paste #abc12 34B 3L]\n````\nline one\n")
    expect(sb.has(r.content, { kinds: ["paste"] })).toBe(false)
  })
})
