/**
 * The display handler of the `paste` kind (manifest `sideband[0].display`).
 * Core calls it when a consumer (a dump) shows a text with a paste ref.
 *
 * Rules:
 * - A bad id: the label has `?` for the id (never the raw string), and the
 *   result has `missing: true`. No file is read.
 * - A node with a body (not a ref): the label from the attrs, no text.
 * - No sid or no `ctx.host.sessionFiles`: the label from the attrs only.
 * - Label mode: one `stat`. No file gives the missing label and
 *   `missing: true`. Else the label has the file size and the attr lines.
 * - Full mode: one `readHead` with `ctx.maxBytes`, else
 *   `plugins.paste.display.maxBytes` (default 65536). A cap of 0 is label
 *   mode. The text is the exact file text (no line numbers, no neutralize:
 *   a consumer that sends the text to a model neutralizes it). A cut text
 *   ends with `\n[... N more bytes]` and has `truncated: true`. The label
 *   has the file size, and the lines of the file when the whole file was
 *   read (else the attr lines).
 * - `chipLabel` makes each label, so the TUI chip and the display agree.
 * - Never throws: a fault gives `undefined` (the consumer keeps its default).
 *
 * @module handlers/display
 */

import type { SessionFilesApi } from "@minimal-agent/core/plugin-api/types/host-capabilities"
import type {
  SidebandDisplayContext,
  SidebandDisplayHandler,
} from "@minimal-agent/core/plugin-api/types/plugin"
import type { SidebandDisplay, SidebandNode } from "@minimal-agent/core/plugin-api/types/sideband"

import { loadPasteConfig } from "../lib/config.ts"
import { countLines, utf8Bytes, utf8Head } from "../lib/count.ts"
import { chipLabel } from "../lib/format.ts"
import { isPasteId } from "../lib/id.ts"

/** One read of the head of a file. */
interface Head {
  text: string
  bytes: number
  truncated: boolean
}

/** The cap for one full-mode call: `ctx.maxBytes` when valid, else the config. */
function capOf(ctx: SidebandDisplayContext): number {
  const m = ctx.maxBytes
  if (typeof m === "number" && Number.isFinite(m) && m >= 0) return Math.floor(m)
  return loadPasteConfig().display.maxBytes
}

/**
 * The head of the file. A host with no `readHead` uses `read` and `stat`.
 * An older host can ignore the `maxBytes` of `read`, so the plugin cuts the
 * text to the cap too (`utf8Head`).
 */
function readHead(files: SessionFilesApi, sid: string, name: string, cap: number): Head | null {
  if (files.readHead) return files.readHead(sid, name, cap)
  const st = files.stat(sid, name)
  if (!st) return null
  const read = files.read(sid, name, { maxBytes: cap })
  if (read === null) return null
  const text = utf8Head(read, cap)
  const bytes = Math.max(st.bytes, utf8Bytes(read))
  return { text, bytes, truncated: utf8Bytes(text) < bytes }
}

/** The label mode result: one `stat`. */
function labelOf(
  files: SessionFilesApi,
  sid: string,
  name: string,
  attrs: Record<string, unknown>,
): SidebandDisplay {
  const st = files.stat(sid, name)
  if (!st) return { label: chipLabel(attrs, false), missing: true }
  return { label: chipLabel({ ...attrs, bytes: st.bytes }, true) }
}

/** The full mode result: one `readHead`. */
function fullOf(
  files: SessionFilesApi,
  sid: string,
  name: string,
  attrs: Record<string, unknown>,
  cap: number,
): SidebandDisplay {
  const head = readHead(files, sid, name, cap)
  if (!head) return { label: chipLabel(attrs, false), missing: true }
  if (!head.truncated) {
    const label = chipLabel({ ...attrs, bytes: head.bytes, lines: countLines(head.text) }, true)
    return { label, text: head.text }
  }
  const more = Math.max(0, head.bytes - utf8Bytes(head.text))
  return {
    label: chipLabel({ ...attrs, bytes: head.bytes }, true),
    text: `${head.text}\n[... ${more} more bytes]`,
    truncated: true,
  }
}

/** The display of one paste node. Can throw: the default export catches. */
function displayPaste(node: SidebandNode, ctx: SidebandDisplayContext): SidebandDisplay {
  const attrs: Record<string, unknown> = { ...ctx.sideband.attrs(node) }
  if (!isPasteId(attrs.id)) {
    return { label: chipLabel({ ...attrs, id: undefined }, false), missing: true }
  }
  if (!node.selfClosing) return { label: chipLabel(attrs, true) }
  const files = ctx.host?.sessionFiles
  const sid = ctx.sid
  if (!files || typeof sid !== "string" || sid === "") return { label: chipLabel(attrs, true) }
  const name = `${attrs.id}.txt`
  const cap = ctx.mode === "full" ? capOf(ctx) : 0
  return cap === 0 ? labelOf(files, sid, name, attrs) : fullOf(files, sid, name, attrs, cap)
}

/**
 * The display handler (default export for the manifest).
 *
 * @param node - A top-level `paste` node.
 * @param ctx - The display context (`host: true` in the manifest).
 * @returns The display, or undefined after a fault.
 */
const display: SidebandDisplayHandler = (node, ctx) => {
  try {
    return displayPaste(node, ctx)
  } catch {
    return undefined
  }
}

export default display
