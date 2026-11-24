/**
 * S1, S2 and A5: paste refs in the `SessionHistory` dump. The real sideband
 * boot (`loadSidebandOnly` with `display`) loads the real paste display
 * handler, with the real core `sessions:files` host on a temp sessions dir.
 * The dumped sid is an old session (not owned by this process): the core
 * display read scope lets the handler read its files.
 *
 * @module plugins/session-history/lib/dump-display.test
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { loadSidebandOnly, type SidebandApi } from "@minimal-agent/core/host/sideband"

import handler, { MODEL_DUMP_PASTE_MAX_BYTES } from "../handlers/session_history.ts"

import { dumpMarkdown, dumpXml } from "./dump-from-data.ts"
import type { MessageLike, SessionRecordsView, SessionsReadApi } from "./host-types.ts"

const PLUGINS = resolve(import.meta.dir, "../..")
const SID = "old-dump-sid-1"

const root = mkdtempSync(join(tmpdir(), "sh-dump-display-"))
const sessionsDir = join(root, "sessions")
const pasteDir = join(sessionsDir, `${SID}.files`, "paste")
mkdirSync(pasteDir, { recursive: true })
writeFileSync(join(sessionsDir, `${SID}.jsonl`), "")
afterAll(() => rmSync(root, { recursive: true, force: true }))

const BODY = "line one\nhas ``` fence\nline three\n"
const CRLF = "a\r\nb\r\n"
writeFileSync(join(pasteDir, "abc12.txt"), BODY)
writeFileSync(join(pasteDir, "crlf1.txt"), CRLF)
writeFileSync(join(pasteDir, "big01.txt"), "z".repeat(MODEL_DUMP_PASTE_MAX_BYTES + 100))
// A secret next to the sessions dir: a bad id or a link must never reach it.
writeFileSync(join(root, "secret.txt"), "SECRET")
symlinkSync(join(root, "secret.txt"), join(pasteDir, "lnk99.txt"))

const noop = (): void => {}
const sb: SidebandApi = await loadSidebandOnly({
  roots: { embedded: [PLUGINS], user: [join(root, "none")], project: [join(root, "none")] },
  enabledPluginIds: new Set(["sideband", "paste", "session-history"]),
  display: { hostOptions: { sessionsDir } },
  diagnostics: {
    sessionId: undefined,
    emit: noop,
    emergency: noop,
    alert: noop,
    critical: noop,
    error: noop,
    warn: noop,
    notice: noop,
    info: noop,
    debug: noop,
  },
})

function ref(id: string): string {
  return sb.render("paste", { attrs: { id, bytes: 1, lines: 1 } })
}

function session(content: MessageLike["content"], role = "user"): SessionRecordsView {
  return { sid: SID, meta: null, records: [], messages: [{ role, content }] }
}

const OPTS = { sid: SID }

describe("dump of paste refs through the display handler", () => {
  test("the boot has the paste display", () => {
    expect(sb.hasDisplay("paste")).toBe(true)
  })

  test("found paste: label and fenced body, no raw tag (markdown)", () => {
    const md = dumpMarkdown(session(`see ${ref("abc12")} done`), sb, OPTS)
    expect(md).toBe(
      "## User\n\nsee \n[Paste #abc12 34B 3L]\n````\nline one\nhas ``` fence\nline three\n````\n done\n",
    )
    expect(sb.has(md, { kinds: ["paste"] })).toBe(false)
  })

  test("found paste in a text block (xml)", () => {
    const xml = dumpXml(session([{ type: "text", text: `a ${ref("abc12")}` }]), sb, OPTS)
    expect(xml).toBe(
      '<session>\n  <turn role="user">\n    <text>a <display kind="paste" label="[Paste #abc12 34B 3L]">line one\nhas ``` fence\nline three\n</display></text>\n  </turn>\n</session>\n',
    )
  })

  test("missing paste: the missing label, no text", () => {
    const t = `x ${ref("nofil")}`
    expect(dumpMarkdown(session(t), sb, OPTS)).toBe("## User\n\nx [Paste #nofil missing]\n")
    expect(dumpXml(session(t), sb, OPTS)).toContain(
      '<text>x <display kind="paste" label="[Paste #nofil missing]" missing="true"/></text>',
    )
  })

  test("a symlink is missing; its target is never read", () => {
    const md = dumpMarkdown(session(ref("lnk99")), sb, OPTS)
    expect(md).toBe("## User\n\n[Paste #lnk99 missing]\n")
    expect(md).not.toContain("SECRET")
  })

  test("bad id: the label has ?, and no file is read", () => {
    const bad = sb.render("paste", { attrs: { id: "../../secret" } })
    const md = dumpMarkdown(session(`q ${bad}`), sb, OPTS)
    expect(md).toBe("## User\n\nq [Paste #? missing]\n")
    expect(md).not.toContain("secret")
  })

  test("two refs in one text", () => {
    const md = dumpMarkdown(session(`${ref("abc12")} and ${ref("crlf1")}`), sb, OPTS)
    expect(md).toBe(
      "## User\n\n[Paste #abc12 34B 3L]\n````\nline one\nhas ``` fence\nline three\n````\n and \n[Paste #crlf1 6B 2L]\n```\na\r\nb\r\n```\n",
    )
  })

  test("CRLF body stays exact", () => {
    const xml = dumpXml(session(ref("crlf1")), sb, OPTS)
    expect(xml).toContain('label="[Paste #crlf1 6B 2L]">a\r\nb\r\n</display>')
  })

  test("a harness-marked block (compaction) keeps its ref raw", () => {
    const raw = `summary ${ref("abc12")}`
    const msgs: MessageLike["content"] = [
      { type: "text", text: raw, sideband: { kind: "compaction" } } as never,
    ]
    expect(dumpMarkdown(session(msgs), sb, OPTS)).toBe(`## User\n\n${raw}\n`)
    expect(sb.has(dumpXml(session(msgs), sb, OPTS), { kinds: ["paste"] })).toBe(false)
    expect(dumpXml(session(msgs), sb, OPTS)).not.toContain("<display")
  })

  test("assistant text and text with no ref do not change", () => {
    const a = `${ref("abc12")} plain`
    expect(dumpMarkdown(session(a, "assistant"), sb, OPTS)).toBe(`## Assistant\n\n${a}\n`)
    expect(dumpMarkdown(session("no ref <b>"), sb, OPTS)).toBe("## User\n\nno ref <b>\n")
    expect(dumpXml(session("no ref <b>"), sb, OPTS)).toContain("<text>no ref &lt;b&gt;</text>")
  })

  test("no sid: the attrs label, no file text", () => {
    expect(dumpMarkdown(session(ref("abc12")), sb)).toBe("## User\n\n[Paste #abc12 1B 1L]\n")
  })

  test("the display text is neutralized (the dump goes to the model)", () => {
    const inner = sb.render("paste", { attrs: { id: "abc12" } })
    writeFileSync(join(pasteDir, "nest1.txt"), `has ${inner}\n`)
    const md = dumpMarkdown(session(ref("nest1")), sb, OPTS)
    expect(md).toContain(sb.neutralize(`has ${inner}\n`))
    expect(sb.has(md, { kinds: ["paste"] })).toBe(false)
  })

  test("the display label is neutralized too (a third-party handler gives it)", () => {
    const tag = ref("abc12")
    // A fake display: one node with a label that holds a raw tag.
    const fake = {
      ...sb,
      display: (text: string) => ({
        changed: true,
        segments: [
          {
            type: "node" as const,
            span: { start: 0, end: text.length },
            node: sb.find(text, { kinds: ["paste"] })[0] as never,
            display: { label: `L ${tag}`, text: "body" },
          },
        ],
      }),
    }
    const md = dumpMarkdown(session(ref("crlf1")), fake as never, OPTS)
    expect(md).toContain(sb.neutralize(`L ${tag}`))
    expect(sb.has(md, { kinds: ["paste"] })).toBe(false)
  })

  /**
   * XML parity with the cli dump. The cli test `src/commands/session-dump.test.ts`
   * ("xml parity: ...") has the same input and the same expected text. Keep
   * the two copies equal.
   */
  test("xml parity: a C0 char and a lone surrogate give the same XML as the cli dump", () => {
    const v: SessionRecordsView = {
      sid: SID,
      meta: null,
      records: [],
      messages: [
        { role: "user", content: "u\u0001s\uD800r" },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "c\u0001", content: "x\u0001y\uDC00z" } as never,
          ],
        },
      ],
    }
    expect(dumpXml(v, sb, OPTS)).toBe(
      '<session>\n  <turn role="user">\n    <text>usr</text>\n  </turn>\n  <turn role="user">\n    <tool_result tool_use_id="c">\n      <content>xyz</content>\n    </tool_result>\n  </turn>\n</session>\n',
    )
  })
})

describe("SessionHistory dump with a paste", () => {
  function sessions(content: MessageLike["content"]): SessionsReadApi {
    return {
      async records(sid: string) {
        return sid === SID ? session(content) : null
      },
      async list() {
        return { items: [], total: 0 }
      },
    } as unknown as SessionsReadApi
  }

  async function dump(content: MessageLike["content"]): Promise<string> {
    const r = await handler({
      trigger: { type: "tool", name: "SessionHistory", input: { action: "dump", sid: SID } },
      cwd: "/proj",
      host: { sessions: sessions(content) },
      sideband: sb,
    })
    expect(r.is_error).toBeFalsy()
    return r.content
  }

  test("dump reads the paste of an old session; no paths capability needed", async () => {
    const out = await dump(`see ${ref("abc12")}`)
    expect(out).toContain("[Paste #abc12 34B 3L]\n````\nline one\n")
    expect(sb.has(out, { kinds: ["paste"] })).toBe(false)
  })

  test("dump caps the paste at 8192 bytes", async () => {
    expect(MODEL_DUMP_PASTE_MAX_BYTES).toBe(8192)
    const out = await dump(ref("big01"))
    expect(out).toBe(
      `## User\n\n[Paste #big01 8.3kB 1L]\n\`\`\`\n${"z".repeat(8192)}\n[... 100 more bytes]\n\`\`\`\n`,
    )
  })
})
