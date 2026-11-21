import { v1Qname } from "./levels.ts"
import { makeContext, parseAt } from "./parse.ts"
import { parseStrictAt } from "./scanner-strict.ts"
import type {
  ReadonlySidebandRegistry,
  SidebandNode,
  StreamScanner,
  StreamScanOptions,
} from "./types.ts"

const OPEN_CAP = 1024
const BODY_CAP = 65536

// v1 escape (SB-SCN-10): a backslash before the emit-level opener stops
// detection, and the text channel gets the opener without the backslash.
const ESC_OPENER = "<ma::emit::"
const ESC = `\\${ESC_OPENER}`
const ESC_RE = /\\<ma::emit::/g

function countRun(s: string, from: number, ch: string): number {
  let i = from
  while (i < s.length && s.charAt(i) === ch) i++
  return i - from
}

/**
 * True when the scan reads emit-level kinds: no `kinds` filter, or a filter
 * with a kind whose v1 name is `ma::emit::*`. Only then the v1 escape applies.
 */
function readsEmit(registry: ReadonlySidebandRegistry, only: Set<string> | undefined): boolean {
  if (only === undefined) return true
  for (const name of only) {
    const decl = registry.kind(name)
    if (decl !== undefined && v1Qname(decl).startsWith("ma::emit::")) return true
  }
  return false
}

/**
 * Make a streaming scanner. It fires onNode only for registered from-model
 * kinds. Other text passes through unchanged and in order. An opener split
 * across chunks is held until the next chunk.
 *
 * `codeAware` (default true) is the code rule of the old core TagScanner: no
 * node starts in a code span (a backtick run, closed by a run of the same
 * length) or in a fenced block (3 or more backticks or tildes at column 0,
 * closed by a run of the same char, of the same or more length, at column 0).
 * A run at the end of a chunk is held until its length is known.
 *
 * The v1 escape `\<ma::emit::` applies when the scan reads emit-level kinds
 * (see `readsEmit`). Outside code, it stops detection. In all text, the
 * backslash is removed.
 *
 * `strictV1` (default false) uses the grammar of the old core TagScanner (see
 * `scanner-strict.ts`): the core stream sets it, so its events do not change.
 * Then `kinds` limits the names as written, the registry is not read, the v1
 * escape is on, and the open part has no hold limit unless `maxOpenUnits` is set.
 */
export function createScanner(
  registry: ReadonlySidebandRegistry,
  opts: StreamScanOptions = {},
): StreamScanner {
  const ctx = makeContext(registry)
  const only = opts.kinds === undefined ? undefined : new Set(opts.kinds)
  const accept = (kind: string): boolean =>
    ctx.kind(kind)?.direction === "from-model" && (only === undefined || only.has(kind))
  const strict = opts.strictV1 === true
  const openCap = opts.maxOpenUnits ?? (strict ? Number.POSITIVE_INFINITY : OPEN_CAP)
  const bodyCap = opts.maxSpanUnits ?? BODY_CAP
  const code = opts.codeAware ?? true
  const escape = strict || readsEmit(registry, only)
  const acceptName = (name: string): boolean => only === undefined || only.has(name)
  let buf = ""
  let textCb: ((text: string) => void) | undefined
  let nodeCb: ((node: SidebandNode, raw: string) => void) | undefined

  // Code state. It stays across writes.
  let atLineStart = true
  let inline = 0
  let fence: { ch: string; len: number } | undefined

  const text = (t: string): void => {
    if (t.length > 0) textCb?.(escape ? t.replace(ESC_RE, ESC_OPENER) : t)
  }

  const toggleInline = (run: number): void => {
    if (inline === 0) inline = run
    else if (run === inline) inline = 0
  }

  const pumpInner = (final: boolean): void => {
    const n = buf.length
    let pos = 0
    let hold = n
    let i = 0
    while (i < n) {
      const ch = buf.charAt(i)
      if (code) {
        if (ch === "\n") {
          atLineStart = true
          i++
          continue
        }
        if (fence !== undefined) {
          if (atLineStart && ch === fence.ch) {
            const run = countRun(buf, i, ch)
            if (i + run >= n && !final) {
              hold = i
              break
            }
            if (run >= fence.len) fence = undefined
            i += run
          } else {
            i++
          }
          atLineStart = false
          continue
        }
        if (ch === "`" || (atLineStart && ch === "~")) {
          const run = countRun(buf, i, ch)
          if (i + run >= n && !final) {
            hold = i
            break
          }
          if (atLineStart && run >= 3) fence = { ch, len: run }
          else if (ch === "`") toggleInline(run)
          atLineStart = false
          i += run
          continue
        }
        if (inline > 0) {
          atLineStart = false
          i++
          continue
        }
      }
      if (escape && ch === "\\") {
        if (buf.startsWith(ESC, i)) {
          atLineStart = false
          i += ESC.length
          continue
        }
        if (!final && n - i < ESC.length && ESC.startsWith(buf.slice(i))) {
          if (strict) atLineStart = false
          hold = i
          break
        }
      }
      if (ch === "<") {
        const r = strict ? parseStrictAt(buf, i, acceptName) : parseAt(buf, i, ctx, accept)
        if (r.status === "node") {
          text(buf.slice(pos, i))
          nodeCb?.(r.node, buf.slice(i, r.end))
          if (r.node.selfClosing) atLineStart = false
          i = r.end
          pos = r.end
          continue
        }
        if (r.status === "incomplete") {
          // At the end, or past a hold limit, the rest goes out as text
          // without a scan (the raw fallback of TagScanner and the stripper).
          if (final || n - i > (r.phase === "open" ? openCap : bodyCap)) break
          // strictV1: core TagScanner walks over a held part of the opener
          // name (shorter than `<ma::emit::`) and so clears its line-start
          // flag before the next chunk. Core events depend on the cut here.
          if (strict && n - i < ESC_OPENER.length) atLineStart = false
          hold = i
          break
        }
      }
      atLineStart = false
      i++
    }
    text(buf.slice(pos, hold))
    buf = buf.slice(hold)
  }

  const pump = (final: boolean): void => {
    try {
      pumpInner(final)
    } catch {
      const rest = buf
      buf = ""
      text(rest)
    }
  }

  return {
    write(chunk: string): void {
      buf += chunk
      pump(false)
    },
    end(): void {
      pump(true)
      buf = ""
    },
    onText(cb): void {
      textCb = cb
    },
    onNode(cb): void {
      nodeCb = cb
    },
  }
}
