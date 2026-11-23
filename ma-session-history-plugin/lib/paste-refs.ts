/**
 * Paste refs in a session dump.
 *
 * The paste plugin keeps each pasted text in
 * `<sessionsDir>/<sid>.files/paste/<id>.txt`. The user message holds only a
 * self-closing `paste` sideband node. A dump shows the chip label and the
 * file text in place of that node, never the raw node.
 *
 * Twin: `minimal-agent-cli/src/commands/session-dump-paste.ts`
 * (the `sessions dump` command). Keep the two files equal in behavior: the two
 * dumps must give the same text for the same session.
 *
 * The id rule, the size text and the label are copies of the paste plugin
 * (`ma-paste-plugin/lib/id.ts` and `lib/format.ts`). This plugin does not
 * import another plugin package, so it keeps a small local copy.
 *
 * @module plugins/session-history/lib/paste-refs
 */

import { lstatSync, readFileSync } from "node:fs"
import { join } from "node:path"

import type { SidebandApi } from "@minimal-agent/core/plugin-api/types/sideband"

/** The sideband kind of a paste ref. */
const PASTE_KIND = "paste"

/** The plugin dir of the paste files under `<sid>.files/`. */
const PASTE_DIR = "paste"

/** The paste id rule (copy of `ma-paste-plugin/lib/id.ts`). */
const PASTE_ID_RE = /^[0-9a-z]{5}$/

/** The sideband slice that the paste step uses. */
export type PasteSideband = Pick<SidebandApi, "find">

/** Gives the text of paste `id`, or null when there is no file. */
export type PasteReader = (id: string) => string | null

/** One part of a user text: plain text, or one paste ref. */
export type PasteSegment =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "paste"
      /** The raw id attr (can be invalid). */
      readonly id: string
      /** The chip label: `[Paste #<id> <size> <lines>L]` or `[Paste #<id> missing]`. */
      readonly label: string
      /** The file text, or null when the file is missing or the id is bad. */
      readonly body: string | null
    }

/** True when `id` is a valid paste id. */
export function isPasteId(id: unknown): id is string {
  return typeof id === "string" && PASTE_ID_RE.test(id)
}

/** True when `sid` is safe to join into a file name (same rule as core). */
function isSafeSid(sid: string): boolean {
  return (
    sid.length > 0 &&
    sid.length <= 128 &&
    !sid.includes("/") &&
    !sid.includes("\\") &&
    !sid.includes("..") &&
    !sid.includes("\0")
  )
}

/**
 * A read-only paste reader for session `sid` under `sessionsDir`. It checks
 * the id before it builds a path, and it reads only a regular file (no
 * symlink). It never writes and never throws.
 */
export function pasteFileReader(sessionsDir: string, sid: string): PasteReader {
  if (!isSafeSid(sid)) return () => null
  const dir = join(sessionsDir, `${sid}.files`, PASTE_DIR)
  return (id) => {
    if (!isPasteId(id)) return null
    const path = join(dir, `${id}.txt`)
    try {
      if (!lstatSync(path).isFile()) return null
      return readFileSync(path, "utf8")
    } catch {
      return null
    }
  }
}

const UNITS = ["kB", "MB", "GB", "TB"] as const

/** SI size with one decimal (copy of `ma-paste-plugin/lib/format.ts`). */
function formatSize(bytes: number): string {
  const b = Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0
  if (b < 1000) return `${b}B`
  let v = b / 1000
  let u = 0
  while (u < UNITS.length - 1 && Math.round(v * 10) / 10 >= 1000) {
    v /= 1000
    u++
  }
  return `${(Math.round(v * 10) / 10).toFixed(1)}${UNITS[u]}`
}

/** The LF count, plus 1 when the text is not empty and does not end with LF. */
function countLines(text: string): number {
  if (text.length === 0) return 0
  let n = 0
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++
  return text.endsWith("\n") ? n : n + 1
}

/** The chip label. Size and lines come from the file, not from the attrs. */
function chipLabel(id: string, body: string | null): string {
  const parts = ["Paste", `#${id}`]
  if (body === null) parts.push("missing")
  else parts.push(formatSize(Buffer.byteLength(body, "utf8")), `${countLines(body)}L`)
  return ["[", parts.join(" "), "]"].join("")
}

/**
 * Split `text` at each top-level, self-closing paste node. With no codec
 * or no reader, or with no paste node, the result is one text segment.
 */
export function pasteSegments(
  text: string,
  sb: PasteSideband | undefined,
  read: PasteReader | undefined,
): PasteSegment[] {
  if (sb === undefined || read === undefined || text.length === 0) return [{ kind: "text", text }]
  const nodes = sb.find(text, { kinds: [PASTE_KIND] }).filter((n) => n.selfClosing)
  if (nodes.length === 0) return [{ kind: "text", text }]
  const out: PasteSegment[] = []
  let at = 0
  for (const n of nodes) {
    if (n.span.start < at) continue
    if (n.span.start > at) out.push({ kind: "text", text: text.slice(at, n.span.start) })
    const id = typeof n.attrs.id === "string" ? n.attrs.id : "?"
    const body = isPasteId(id) ? read(id) : null
    out.push({ kind: "paste", id, label: chipLabel(id, body), body })
    at = n.span.end
  }
  if (at < text.length) out.push({ kind: "text", text: text.slice(at) })
  return out
}

/** A backtick fence longer than each backtick run in `body` (3 or more). */
function fenceFor(body: string): string {
  let longest = 0
  for (const m of body.matchAll(/`+/g)) longest = Math.max(longest, m[0].length)
  return "`".repeat(Math.max(3, longest + 1))
}

/**
 * Markdown of a user text: each paste ref becomes its chip label. With a
 * file, a fenced block with the file text follows the label, on its own
 * lines. Other text does not change.
 */
export function pasteMarkdown(
  text: string,
  sb: PasteSideband | undefined,
  read: PasteReader | undefined,
): string {
  const segs = pasteSegments(text, sb, read)
  if (segs.length === 1 && segs[0]?.kind === "text") return text
  let out = ""
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]
    if (s === undefined) continue
    if (s.kind === "text") {
      out += s.text
      continue
    }
    if (s.body === null) {
      out += s.label
      continue
    }
    const fence = fenceFor(s.body)
    const lead = out.length > 0 && !out.endsWith("\n") ? "\n" : ""
    const bodyNl = s.body.length === 0 || s.body.endsWith("\n") ? "" : "\n"
    const next = segs[i + 1]
    const trail = next !== undefined && !(next.kind === "text" && next.text.startsWith("\n"))
    out += `${lead}${s.label}\n${fence}\n${s.body}${bodyNl}${fence}${trail ? "\n" : ""}`
  }
  return out
}

/**
 * XML content of a user text (the text between the `<text>` tags). Plain
 * text goes through `escape`. Each paste ref becomes a `paste` element with
 * the id and label attrs. With a file, the escaped file text is the element
 * text. Without, the element is empty and has `missing="true"`.
 */
export function pasteXml(
  text: string,
  sb: PasteSideband | undefined,
  read: PasteReader | undefined,
  escape: (s: string) => string,
): string {
  let out = ""
  for (const s of pasteSegments(text, sb, read)) {
    if (s.kind === "text") {
      out += escape(s.text)
      continue
    }
    const attrs = `id="${escape(s.id)}" label="${escape(s.label)}"`
    out +=
      s.body === null
        ? `<paste ${attrs} missing="true"/>`
        : `<paste ${attrs}>${escape(s.body)}</paste>`
  }
  return out
}
