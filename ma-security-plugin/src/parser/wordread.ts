/**
 * Word reader: the char-level part of the lexer (design H, section 4).
 * Reads one word into typed parts. Substitution bodies are parsed by
 * `child()`, which the script parser provides.
 */

import type { FailReason, Script, Word, WordPart } from "./ast.ts"
import { decodeAnsiC, isDigit, isNameChar, isNameStart, isWordEnd } from "./lexer.ts"
import type { Ctx } from "./scan.ts"
import { backtickEnd, matchClose, ParseFail, unescapeBacktick } from "./scan.ts"
import { finishWord } from "./words.ts"

/** Names written while a construct (branch, loop, subshell) is open. */
export interface Frame {
  kind: string
  names: Set<string>
  /** Every var was wiped while the frame was open. */
  all?: boolean
  /** Loop frames: env before the loop. Unwritten names come back at `done`. */
  snap?: Map<string, string>
}

/** True when an arith expression can write a var (`=`, `++`, `--`). */
export function arithWrites(t: string): boolean {
  return t.includes("=") || t.includes("++") || t.includes("--")
}

/** Base class: shared state, depth and word counting, word reading. */
export abstract class WordReader {
  pos = 0
  protected env: Map<string, string>

  constructor(
    protected readonly s: string,
    protected readonly base: number,
    protected readonly ctx: Ctx,
    protected readonly top: boolean,
    env?: Map<string, string>,
  ) {
    this.env = env ? new Map(env) : new Map()
  }

  /** Open write frames: each collects the names written while it is open. */
  protected frames: Frame[] = []

  /** Parser for a nested script body. */
  protected abstract child(text: string, base: number): { parseAll(): Script }

  private noteWrite(name: string): void {
    for (const f of this.frames) f.names.add(name)
  }

  /** Static value of a var, or undefined. */
  getVar(name: string): string | undefined {
    return this.env.get(name)
  }

  /** Plain static assign. Tainted names and `noTrack` make it unknown. */
  setVar(name: string, value: string): void {
    if (this.ctx.noTrack || this.ctx.tainted.has(name)) this.dropVar(name)
    else {
      this.env.set(name, value)
      this.noteWrite(name)
    }
  }

  /** The var is written in a way the parser cannot follow: unknown from here. */
  dropVar(name: string): void {
    this.env.delete(name)
    this.noteWrite(name)
  }

  /** Every var is unknown from here (eval, source, function call). */
  wipeVars(): void {
    for (const k of this.env.keys()) this.noteWrite(k)
    for (const f of this.frames) f.all = true
    this.env.clear()
  }

  /** Open a loop: the body can run many times, so no var is static inside it. */
  protected beginLoop(): void {
    const f = this.beginFrame("loop")
    f.snap = new Map(this.env)
    this.env.clear()
  }

  /** Close the innermost loop. Names it wrote stay unknown. The rest come back. */
  protected endLoop(): void {
    const f = this.topFrame("loop")
    if (!f) return
    this.endFrame(f, true)
    if (f.all || !f.snap) return
    for (const [k, v] of f.snap) if (!f.names.has(k) && !this.env.has(k)) this.env.set(k, v)
  }

  /** Static value for a param read, or undefined. Unquoted reads respect IFS (B3). */
  private lookup(name: string, inDq: boolean): string | undefined {
    if (!inDq && this.ctx.ifsAny) return undefined
    return this.env.get(name)
  }

  /** Mark every identifier in `text` unknown (arith, let). */
  dropIdents(text: string): void {
    const n = text.length
    let i = 0
    while (i < n) {
      const c = text.charCodeAt(i)
      if (isNameStart(c) && (i === 0 || !isNameChar(text.charCodeAt(i - 1)))) {
        let j = i + 1
        while (j < n && isNameChar(text.charCodeAt(j))) j++
        this.dropVar(text.slice(i, j))
        i = j
      } else i++
    }
  }

  /** Open a write frame of `kind` (if, loop, case, andor, sub, pipe, bg). */
  protected beginFrame(kind: string): Frame {
    const f: Frame = { kind, names: new Set() }
    this.frames.push(f)
    return f
  }

  /** Close frame `f` (any stack position). With `forget`, its writes become unknown. */
  protected endFrame(f: Frame | undefined, forget: boolean): void {
    if (!f) return
    const i = this.frames.lastIndexOf(f)
    if (i >= 0) this.frames.splice(i, 1)
    if (forget) for (const n of f.names) this.dropVar(n)
  }

  /** Topmost open frame of `kind`. */
  protected topFrame(kind: string): Frame | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i] as Frame
      if (f.kind === kind) return f
    }
    return undefined
  }

  /** Make the writes so far in frame `f` unknown (branch switch: else, elif, `;;`). */
  protected forgetFrame(f: Frame | undefined): void {
    if (f) for (const n of f.names) this.dropVar(n)
  }

  protected get end(): number {
    return this.s.length
  }

  fail(reason: FailReason, detail: string, at = this.pos): never {
    throw new ParseFail(reason, detail, this.base + at)
  }

  protected enter(): void {
    const d = ++this.ctx.depth
    if (d > this.ctx.maxDepth) this.ctx.maxDepth = d
    if (d > this.ctx.lim.maxDepth) this.fail("too-deep", `nesting over ${this.ctx.lim.maxDepth}`)
  }

  protected leave(): void {
    this.ctx.depth--
  }

  protected ch(i = this.pos): number {
    return this.s.charCodeAt(i)
  }

  /** Find `$(...)` and backtick subs in free text (heredoc body, arith, `${...}`). */
  protected scanSubs(text: string, base: number): Script[] {
    const out: Script[] = []
    const n = text.length
    let i = 0
    while (i < n) {
      const c = text.charCodeAt(i)
      if (c === 92) {
        i += 2
      } else if (c === 36 && text.charCodeAt(i + 1) === 40) {
        if (text.charCodeAt(i + 2) === 40) {
          i += 3
          continue
        }
        const e = matchClose(text, i + 1, n, 41)
        if (e < 0) {
          i += 2
          continue
        }
        out.push(this.subParse(text.slice(i + 2, e), base + i + 2, "cmdsub"))
        i = e + 1
      } else if (c === 96) {
        const e = backtickEnd(text, i, n)
        if (e < 0) break
        out.push(this.subParse(unescapeBacktick(text.slice(i + 1, e)), base + i + 1, "cmdsub"))
        i = e + 1
      } else i++
    }
    return out
  }

  protected subParse(text: string, base: number, kind: "cmdsub" | "procsub"): Script {
    this.enter()
    this.ctx.plain = false
    const p = this.child(text, base)
    const script = p.parseAll()
    this.leave()
    script.kind = kind
    return script
  }

  protected countWord(): void {
    if (++this.ctx.words > this.ctx.lim.maxWords) {
      this.fail("too-many-words", `more than ${this.ctx.lim.maxWords} words`)
    }
  }

  /** Read one word at pos. An empty word is allowed (assignment value). */
  readWord(): Word {
    this.countWord()
    const s = this.s
    const end = this.end
    const start = this.pos
    const parts: WordPart[] = []
    let quoted = false
    let lit = start
    let p = start
    let bracketLimit = -1
    const flush = (to: number): void => {
      if (to > lit) {
        const t = s.slice(lit, to)
        parts.push({ kind: "lit", raw: t, text: t })
      }
    }
    while (p < end) {
      const c = s.charCodeAt(p)
      if (isWordEnd(c)) {
        if ((c === 60 || c === 62) && p === start && s.charCodeAt(p + 1) === 40) {
          const e = matchClose(s, p + 1, end, 41)
          if (e < 0) this.fail("syntax", "unbalanced process substitution", p)
          const sub = this.subParse(s.slice(p + 2, e), this.base + p + 2, "procsub")
          parts.push({ kind: "cmdsub", raw: s.slice(p, e + 1), sub })
          p = e + 1
          lit = p
          continue
        }
        break
      }
      switch (c) {
        case 92: {
          flush(p)
          if (p + 1 >= end) {
            parts.push({ kind: "lit", raw: "\\", text: "\\" })
            p++
          } else if (s.charCodeAt(p + 1) === 10) {
            p += 2
          } else {
            parts.push({ kind: "lit", raw: s.slice(p, p + 2), text: s.charAt(p + 1) })
            quoted = true
            p += 2
          }
          lit = p
          continue
        }
        case 39: {
          const e = s.indexOf("'", p + 1)
          if (e < 0) this.fail("syntax", "unterminated single quote", p)
          flush(p)
          parts.push({ kind: "sq", raw: s.slice(p, e + 1), text: s.slice(p + 1, e) })
          quoted = true
          p = e + 1
          lit = p
          continue
        }
        case 34:
          flush(p)
          p = this.readDq(p, parts)
          quoted = true
          lit = p
          continue
        case 36: {
          flush(p)
          const n = s.charCodeAt(p + 1)
          if (n === 39) {
            p = this.readAnsiC(p, parts)
            quoted = true
          } else if (n === 34) {
            p = this.readDq(p + 1, parts)
            quoted = true
          } else p = this.readDollar(p, false, parts)
          lit = p
          continue
        }
        case 96:
          flush(p)
          p = this.readBacktick(p, parts)
          lit = p
          continue
        case 42:
        case 63:
        case 64:
        case 43:
        case 33: {
          if (s.charCodeAt(p + 1) === 40) {
            const e = matchClose(s, p + 1, end, 41)
            if (e > 0) {
              flush(p)
              parts.push({ kind: "glob", raw: s.slice(p, e + 1) })
              p = e + 1
              lit = p
              continue
            }
          }
          if (c === 42 || c === 63) {
            flush(p)
            parts.push({ kind: "glob", raw: s.charAt(p) })
            p++
            lit = p
            continue
          }
          p++
          continue
        }
        case 91: {
          if (bracketLimit < p) bracketLimit = this.scanBracket(p)
          if (bracketLimit > p) {
            flush(p)
            parts.push({ kind: "glob", raw: "[" })
            p++
            lit = p
            continue
          }
          p++
          continue
        }
        case 123: {
          const e = this.scanBrace(p)
          if (e > p) {
            flush(p)
            parts.push({ kind: "brace", raw: s.slice(p, e + 1) })
            p = e + 1
            lit = p
            continue
          }
          p++
          continue
        }
        case 126: {
          if (p === start) {
            let q = p + 1
            while (
              q < end &&
              (isNameChar(s.charCodeAt(q)) || s.charCodeAt(q) === 43 || s.charCodeAt(q) === 45)
            )
              q++
            if (q >= end || s.charCodeAt(q) === 47 || isWordEnd(s.charCodeAt(q))) {
              parts.push({ kind: "tilde", raw: s.slice(p, q) })
              p = q
              lit = p
              continue
            }
          }
          p++
          continue
        }
        default:
          p++
      }
    }
    flush(p)
    this.pos = p
    for (const part of parts) {
      if (part.kind !== "lit" && part.kind !== "sq" && part.kind !== "dq") {
        this.ctx.plain = false
        break
      }
    }
    return finishWord(parts, s.slice(start, p), this.base + start, this.base + p, quoted)
  }

  /** Index of a `]` that closes the `[` at p within the word, or -1. Bounded. */
  protected scanBracket(p: number): number {
    const s = this.s
    const lim = Math.min(this.end, p + 1024)
    for (let i = p + 1; i < lim; i++) {
      const c = s.charCodeAt(i)
      if (c === 93) return i
      if (isWordEnd(c) || c === 39 || c === 34) return -1
    }
    return -1
  }

  /** End of a brace expansion `{a,b}` / `{1..3}` at p, or -1. Bounded. */
  protected scanBrace(p: number): number {
    const s = this.s
    const lim = Math.min(this.end, p + 1024)
    let depth = 0
    let hit = false
    for (let i = p + 1; i < lim; i++) {
      const c = s.charCodeAt(i)
      if (isWordEnd(c) || c === 39 || c === 34 || c === 92 || c === 36) return -1
      if (c === 123) depth++
      else if (c === 125) {
        if (depth === 0) return hit ? i : -1
        depth--
      } else if (depth === 0 && (c === 44 || (c === 46 && s.charCodeAt(i + 1) === 46))) hit = true
    }
    return -1
  }

  protected readAnsiC(p: number, parts: WordPart[]): number {
    const s = this.s
    let i = p + 2
    while (i < this.end) {
      const c = s.charCodeAt(i)
      if (c === 92) i += 2
      else if (c === 39) break
      else i++
    }
    if (i >= this.end) this.fail("syntax", "unterminated $'", p)
    parts.push({ kind: "ansic", raw: s.slice(p, i + 1), text: decodeAnsiC(s.slice(p + 2, i)) })
    return i + 1
  }

  /** Read `"..."` at p (the quote). Pushes dq / param / cmdsub parts. */
  protected readDq(p: number, parts: WordPart[]): number {
    const s = this.s
    const end = this.end
    const before = parts.length
    let i = p + 1
    let seg = i
    let segRaw = p
    let chunks: string[] = []
    const flushSeg = (to: number, rawTo: number): void => {
      if (to > seg) chunks.push(s.slice(seg, to))
      if (chunks.length > 0) {
        parts.push({ kind: "dq", raw: s.slice(segRaw, rawTo), text: chunks.join("") })
        chunks = []
      }
    }
    for (;;) {
      if (i >= end) this.fail("syntax", "unterminated double quote", p)
      const c = s.charCodeAt(i)
      if (c === 34) break
      if (c === 92) {
        const n = s.charCodeAt(i + 1)
        if (n === 36 || n === 96 || n === 34 || n === 92) {
          chunks.push(s.slice(seg, i), s.charAt(i + 1))
          i += 2
          seg = i
        } else if (n === 10) {
          chunks.push(s.slice(seg, i))
          i += 2
          seg = i
        } else i += 2
        continue
      }
      if (c === 36 || c === 96) {
        flushSeg(i, i)
        i = c === 36 ? this.readDollar(i, true, parts) : this.readBacktick(i, parts)
        seg = i
        segRaw = i
        continue
      }
      i++
    }
    flushSeg(i, i + 1)
    if (parts.length === before) parts.push({ kind: "dq", raw: s.slice(p, i + 1), text: "" })
    return i + 1
  }

  protected readBacktick(p: number, parts: WordPart[]): number {
    const e = backtickEnd(this.s, p, this.end)
    if (e < 0) this.fail("syntax", "unterminated backtick", p)
    const body = unescapeBacktick(this.s.slice(p + 1, e))
    const sub = this.subParse(body, this.base + p + 1, "cmdsub")
    parts.push({ kind: "cmdsub", raw: this.s.slice(p, e + 1), sub })
    return e + 1
  }

  protected literalDollar(p: number, inDq: boolean, parts: WordPart[]): number {
    parts.push({ kind: inDq ? "dq" : "lit", raw: "$", text: "$" })
    return p + 1
  }

  /** Read a `$` expansion at p. */
  protected readDollar(p: number, inDq: boolean, parts: WordPart[]): number {
    const s = this.s
    const end = this.end
    const n = s.charCodeAt(p + 1)
    if (n === 40) {
      if (s.charCodeAt(p + 2) === 40) {
        const inner = matchClose(s, p + 2, end, 41)
        if (inner >= 0 && s.charCodeAt(inner + 1) === 41) {
          const part: WordPart = { kind: "arith", raw: s.slice(p, inner + 2) }
          const expr = s.slice(p + 3, inner)
          if (arithWrites(expr)) this.dropIdents(expr)
          const subs = this.scanSubs(expr, this.base + p + 3)
          if (subs.length > 0) part.subs = subs
          parts.push(part)
          return inner + 2
        }
      }
      const e = matchClose(s, p + 1, end, 41)
      if (e < 0) this.fail("syntax", "unbalanced $(", p)
      const sub = this.subParse(s.slice(p + 2, e), this.base + p + 2, "cmdsub")
      parts.push({ kind: "cmdsub", raw: s.slice(p, e + 1), sub })
      return e + 1
    }
    if (n === 123) {
      const e = matchClose(s, p + 1, end, 125)
      if (e < 0) this.fail("syntax", "unbalanced ${", p)
      const inner = s.slice(p + 2, e)
      let j = 0
      while (j < inner.length && isNameChar(inner.charCodeAt(j))) j++
      const part: WordPart = { kind: "param", raw: s.slice(p, e + 1) }
      if (!inDq) part.bare = true
      if (j > 0 && j === inner.length) {
        part.name = inner
        const v = this.lookup(inner, inDq)
        if (v !== undefined) part.text = v
      } else {
        if (j > 0) {
          part.name = inner.slice(0, j)
          // `${X:=v}` and `${X=v}` assign X.
          let k = j
          if (inner.charCodeAt(k) === 91) {
            const close = inner.indexOf("]", k)
            k = close < 0 ? inner.length : close + 1
          }
          const op = inner.charCodeAt(k) === 58 ? inner.charCodeAt(k + 1) : inner.charCodeAt(k)
          if (op === 61) this.dropVar(part.name)
        }
        const subs = this.scanSubs(inner, this.base + p + 2)
        if (subs.length > 0) part.subs = subs
      }
      parts.push(part)
      return e + 1
    }
    if (isNameStart(n)) {
      let j = p + 2
      while (j < end && isNameChar(s.charCodeAt(j))) j++
      const name = s.slice(p + 1, j)
      const part: WordPart = { kind: "param", raw: s.slice(p, j), name }
      if (!inDq) part.bare = true
      const v = this.lookup(name, inDq)
      if (v !== undefined) part.text = v
      parts.push(part)
      return j
    }
    if (
      isDigit(n) ||
      n === 64 ||
      n === 42 ||
      n === 35 ||
      n === 63 ||
      n === 36 ||
      n === 33 ||
      n === 45
    ) {
      parts.push({ kind: "param", raw: s.slice(p, p + 2), name: s.charAt(p + 1) })
      return p + 2
    }
    return this.literalDollar(p, inDq, parts)
  }
}
