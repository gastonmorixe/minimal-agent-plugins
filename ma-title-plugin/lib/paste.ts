/**
 * Paste refs in the title text.
 *
 * The paste plugin (`ma-paste-plugin`) keeps a large paste in a session file
 * and puts a short ref node in the prompt text. The paste plugin expands the
 * ref only for the main model (`message.willSend`). The `prompt.submitted`
 * text that the title plugin gets still has the ref. Thus the title plugin
 * reads the file itself and puts the head of its text in place of the ref.
 *
 * The file path is `<sessionsDir>/<sid>.files/paste/<id>.txt`. The
 * `sessions:files` API of the host reads only the files of the calling plugin,
 * so the plugin reads the path with the `paths` capability. The checks are
 * strict: the id must agree with the paste id grammar, the sid must not hold a
 * path part, and the resolved path must stay in the paste dir of the sid.
 *
 * The functions are pure. The caller gives the file reader. The default
 * reader {@link readPasteFile} reads a maximum of {@link PASTE_READ_BYTES}
 * bytes.
 *
 * @module lib/paste
 */

import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs"
import { isAbsolute, resolve, sep } from "node:path"

import type { SidebandNodeView, TitleSideband } from "./host-types.ts"

/** The sideband kind of a paste ref (declared by `ma-paste-plugin`). */
export const PASTE_KIND = "paste"

/**
 * The rule for a paste id: 5 chars from `[0-9a-z]`. A copy of `PASTE_ID_RE`
 * in `ma-paste-plugin/lib/id.ts`. A plugin does not import another plugin.
 */
export const PASTE_ID_RE = /^[0-9a-z]{5}$/

/** The plugin id of the paste plugin: the name of its session file dir. */
export const PASTE_PLUGIN_DIR = "paste"

/** Max code points of the text of one paste. */
export const PASTE_MAX_CHARS = 600

/**
 * Max bytes that {@link readPasteFile} reads. A UTF-8 code point has 4 bytes
 * or fewer, and CRLF gives one code point for 2 bytes. Thus this many bytes
 * always give more than {@link PASTE_MAX_CHARS} code points when the file is
 * longer.
 */
export const PASTE_READ_BYTES = 8192

/** The text after the head of a long paste. */
export const PASTE_CUT_MARKER = "(rest of the pasted text omitted)"

/** The text in place of a ref with no readable file. */
export const PASTE_MISSING_MARKER = "(pasted text)"

/** Where to find the paste files of one session. */
export interface PasteSource {
  /** The sessions dir of the host (`PathsApi.sessionsDir()`). Must be absolute. */
  sessionsDir: string
  /** The captured sid. */
  sid: string
  /**
   * Read the text of a file. Gives null when the file is missing. A throw
   * counts as a missing file.
   */
  readFile: (path: string) => string | null
}

/** True when `id` is a valid paste id. */
export function isPasteId(id: unknown): id is string {
  return typeof id === "string" && PASTE_ID_RE.test(id)
}

/**
 * True when `sid` is safe as one path part: not empty, no `/`, no `\`, no
 * `..` and no NUL.
 */
export function isSafeSid(sid: unknown): sid is string {
  if (typeof sid !== "string" || sid.trim() === "") return false
  return !/[/\\\0]/.test(sid) && !sid.includes("..")
}

/**
 * The path of the file of paste `id` in session `sid`, or undefined when a
 * check fails: a bad id, a bad sid, a dir that is not absolute, or a path out
 * of the paste dir of the sid.
 */
export function pastePath(sessionsDir: string, sid: string, id: string): string | undefined {
  if (!isPasteId(id) || !isSafeSid(sid)) return undefined
  if (typeof sessionsDir !== "string" || sessionsDir === "" || !isAbsolute(sessionsDir)) {
    return undefined
  }
  const dir = resolve(sessionsDir, `${sid}.files`, PASTE_PLUGIN_DIR)
  const path = resolve(dir, `${id}.txt`)
  return path.startsWith(`${dir}${sep}`) ? path : undefined
}

/**
 * Read the start of a file as UTF-8 text: a maximum of
 * {@link PASTE_READ_BYTES} bytes. Gives null when the file is missing, when
 * the path is a symlink (`O_NOFOLLOW`), when it is not a regular file (a
 * dir, a FIFO, a device) or when a read fails. `O_NONBLOCK` makes sure that
 * the open of a FIFO does not stop the event loop. Both flags exist on Linux
 * and macOS.
 */
export function readPasteFile(path: string): string | null {
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    if (!fstatSync(fd).isFile()) return null
    const buf = Buffer.alloc(PASTE_READ_BYTES)
    const n = readSync(fd, buf, 0, PASTE_READ_BYTES, 0)
    return buf.subarray(0, n).toString("utf8")
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* the read result stays good */
      }
    }
  }
}

/** Change CRLF and CR to LF, then keep the head of a long text. */
function capPaste(text: string): string {
  const points = Array.from(text.replace(/\r\n?/g, "\n"))
  if (points.length <= PASTE_MAX_CHARS) return points.join("")
  return `${points.slice(0, PASTE_MAX_CHARS).join("")}\n${PASTE_CUT_MARKER}`
}

/** The text of one ref node. */
function pasteText(node: SidebandNodeView, source: PasteSource | undefined): string {
  if (!node.selfClosing) return capPaste(node.body ?? "")
  const id = node.attrs.id
  if (!source || !isPasteId(id)) return PASTE_MISSING_MARKER
  const path = pastePath(source.sessionsDir, source.sid, id)
  if (path === undefined) return PASTE_MISSING_MARKER
  let text: string | null
  try {
    text = source.readFile(path)
  } catch {
    text = null
  }
  return typeof text === "string" ? capPaste(text) : PASTE_MISSING_MARKER
}

/**
 * Put the text of each paste ref of `text` in place of the ref. A ref with a
 * body (an expanded ref) gives its body. A self-closing ref gives the head of
 * its file. A ref with a bad id, a bad sid, no source or no readable file
 * gives {@link PASTE_MISSING_MARKER}. Each text has a maximum of
 * {@link PASTE_MAX_CHARS} code points, then {@link PASTE_CUT_MARKER}.
 */
export function expandPasteRefs(
  text: string,
  sb: TitleSideband,
  source: PasteSource | undefined,
): string {
  if (!sb.has(text, { kinds: [PASTE_KIND] })) return text
  return sb.replace(text, (node) => pasteText(node, source), { kinds: [PASTE_KIND] })
}
