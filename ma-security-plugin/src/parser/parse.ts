/**
 * `parseCommand(source, limits)`: zero-dependency shell parser (design H, sections 4, 5, 7).
 * One recursive-descent parser over a hand-written char lexer. No regex.
 * It never throws: the body is one try/catch. A failure gives a reason, the
 * partial tree, and a raw-text scan.
 */

import type {
  Arith,
  Assign,
  Item,
  Node,
  ParseLimits,
  ParseResult,
  Redirect,
  RedirectOp,
  Script,
  SimpleCommand,
  Word,
  WordPart,
} from "./ast.ts"
import { DEFAULT_LIMITS } from "./ast.ts"
import { isDigit, isNameChar, isNameStart, isWordEnd, readOperator, stripNul } from "./lexer.ts"
import { rawScan, rawScanTruncated } from "./rawscan.ts"
import type { Ctx } from "./scan.ts"
import { hasArithOp, isBlank, isMetaChar, matchClose, ParseFail, utf8Length } from "./scan.ts"
import { applyWrites, EXPORTERS } from "./varwrites.ts"
import { arithWrites, WordReader } from "./wordread.ts"
import { finishWord, splitWord } from "./words.ts"

const REDIRECT_OPS: ReadonlySet<string> = new Set([
  "<",
  ">",
  ">>",
  ">|",
  "<>",
  ">&",
  "<&",
  "&>",
  "&>>",
  "<<",
  "<<-",
  "<<<",
])

/** Keywords dropped from command position (flat approximation, design H s4). */
const DROP_KEYWORDS: ReadonlySet<string> = new Set([
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "do",
  "done",
  "while",
  "until",
  "esac",
])

const CL_TOP = 0
const CL_PAREN = 1
const CL_BRACE = 2
const CL_CASE = 3

/** Script parser: lists, pipelines, compounds, simple commands, heredocs. */
class Parser extends WordReader {
  private pending: Redirect[] = []

  protected child(text: string, base: number): Parser {
    return new Parser(text, base, this.ctx, false, this.env)
  }

  /** Parse the whole input as a script. */
  parseAll(): Script {
    const items: Item[] = []
    if (this.top) this.ctx.topItems = items
    this.parseList(CL_TOP, items)
    if (this.pos < this.end) this.fail("syntax", `unexpected ${this.s.charAt(this.pos)}`)
    if (this.pending.length > 0) this.fail("heredoc-eof", "heredoc without body")
    return { items, start: this.base, end: this.base + this.end }
  }

  /** Skip blanks, line continuations, comments, and (when `nl`) newlines. */
  private skipSpace(nl: boolean): void {
    const s = this.s
    const end = this.end
    while (this.pos < end) {
      const c = s.charCodeAt(this.pos)
      if (isBlank(c) || c === 13) this.pos++
      else if (c === 92 && s.charCodeAt(this.pos + 1) === 10) this.pos += 2
      else if (c === 35) {
        const e = s.indexOf("\n", this.pos)
        this.pos = e < 0 ? end : e
      } else if (nl && c === 10) this.newline()
      else return
    }
  }

  private newline(): void {
    this.pos++
    if (this.pending.length > 0) this.drainHeredocs()
  }

  private peekOp(): string {
    return readOperator(this.s, this.pos)
  }

  /** True when the literal word `w` sits at pos and ends there. */
  private atWord(w: string): boolean {
    return this.s.startsWith(w, this.pos) && isWordEnd(this.ch(this.pos + w.length))
  }

  private atCloser(closer: number): boolean {
    const c = this.ch()
    switch (closer) {
      case CL_PAREN:
        return c === 41
      case CL_BRACE:
        return c === 125 && isWordEnd(this.ch(this.pos + 1))
      case CL_CASE: {
        const op = this.peekOp()
        return op === ";;" || op === ";&" || op === ";;&" || this.atWord("esac")
      }
      default:
        return false
    }
  }

  private parseList(closer: number, items: Item[]): void {
    for (;;) {
      this.skipSpace(true)
      if (this.pos >= this.end || this.atCloser(closer)) return
      const snap = new Map(this.env)
      const f = this.beginFrame("item")
      const node = this.parseAndOr()
      this.skipSpace(false)
      let sep: Item["sep"] = ""
      const op = this.peekOp()
      if (op === ";" || op === "&") {
        this.pos++
        sep = op
      } else if (op === "\n") {
        this.newline()
        sep = "\n"
      } else if (!(this.pos >= this.end || this.atCloser(closer))) {
        this.fail("syntax", `unexpected ${op || this.s.charAt(this.pos)}`)
      }
      // A background item runs in a subshell: its writes do not reach us (B1).
      this.endFrame(f, false)
      if (sep === "&") this.leaveSubshell(snap, f.names)
      if (node) items.push({ node, sep })
    }
  }

  /** After a subshell-like construct: restore `snap`, mark `names` unknown. */
  private leaveSubshell(snap: Map<string, string>, names: Set<string>): void {
    this.env = snap
    for (const n of names) this.dropVar(n)
  }

  private parseAndOr(): Node | null {
    let left = this.parsePipeline()
    for (;;) {
      this.skipSpace(false)
      const op = this.peekOp()
      if (op !== "&&" && op !== "||") return left
      this.pos += 2
      this.skipSpace(true)
      const f = this.beginFrame("andor")
      const right = this.parsePipeline()
      this.endFrame(f, true)
      if (!right) this.fail("syntax", `expected command after ${op}`)
      left = left ? { type: "andor", op, left, right } : right
    }
  }

  /** Pipeline prefixes: `!`, `time [-p]` (review B4). */
  private parsePrefixes(): boolean {
    let negated = false
    for (;;) {
      if (this.ch() === 33 && isWordEnd(this.ch(this.pos + 1)) && this.ch(this.pos + 1) !== 40) {
        negated = !negated
        this.pos++
      } else if (this.atWord("time")) {
        this.ctx.plain = false
        this.pos += 4
        this.skipSpace(false)
        if (this.atWord("-p")) this.pos += 2
        else if (this.atWord("--")) this.pos += 2
      } else return negated
      this.skipSpace(false)
    }
  }

  private parsePipeline(): Node | null {
    this.skipSpace(false)
    const negated = this.parsePrefixes()
    const snap = new Map(this.env)
    const f = this.beginFrame("pipe")
    const stages: Node[] = []
    const first = this.parseUnit()
    if (first) stages.push(first)
    for (;;) {
      this.skipSpace(false)
      const op = this.peekOp()
      if (op !== "|" && op !== "|&") break
      this.pos += op.length
      this.skipSpace(true)
      // Each stage runs in a subshell: no stage sees the writes of another.
      this.env = new Map(snap)
      for (const nm of f.names) this.env.delete(nm)
      const n = this.parseUnit()
      if (!n) this.fail("syntax", `expected command after ${op}`)
      stages.push(n)
    }
    this.endFrame(f, false)
    if (stages.length > 1) this.leaveSubshell(snap, f.names)
    if (stages.length === 0) return null
    if (stages.length === 1 && !negated) return stages[0] as Node
    return { type: "pipeline", negated, stages }
  }

  private parseUnit(): Node | null {
    this.skipSpace(false)
    if (this.pos >= this.end) return null
    const c = this.ch()
    if (c === 40) {
      if (this.ch(this.pos + 1) === 40) {
        const a = this.tryArith()
        if (a) return a
      }
      return this.parseCompound(CL_PAREN)
    }
    if (c === 123) {
      const n = this.ch(this.pos + 1)
      if (isBlank(n) || n === 10) return this.parseCompound(CL_BRACE)
    }
    if (this.atWord("coproc")) return this.parseCoproc()
    return this.parseSimple()
  }

  /** `(( expr ))` at pos, or null when the parens are two subshells. */
  private tryArith(): Arith | null {
    const outer = matchClose(this.s, this.pos, this.end, 41)
    const inner = matchClose(this.s, this.pos + 1, this.end, 41)
    if (outer < 0 || inner < 0 || inner + 1 !== outer) return null
    const expr = this.s.slice(this.pos + 2, inner)
    // `(((...)))`: keep the subshell reading. It over-reports, never hides a command.
    let k = 0
    while (k < expr.length && isBlank(expr.charCodeAt(k))) k++
    if (expr.charCodeAt(k) === 40 || !hasArithOp(expr)) return null
    const start = this.base + this.pos
    this.ctx.plain = false
    const subs = this.scanSubs(expr, this.base + this.pos + 2)
    if (arithWrites(expr)) this.dropIdents(expr)
    this.pos = outer + 1
    return { type: "arith", expr, subs, start, end: this.base + this.pos }
  }

  /** `coproc [NAME] command`: the command runs async in a subshell (review B4). */
  private parseCoproc(): Node | null {
    this.ctx.plain = false
    this.pos += 6
    this.skipSpace(false)
    let p = this.pos
    if (isNameStart(this.ch(p))) {
      while (isNameChar(this.ch(p))) p++
      let q = p
      while (isBlank(this.ch(q))) q++
      const n = this.ch(q)
      const brace = n === 123 && (isBlank(this.ch(q + 1)) || this.ch(q + 1) === 10)
      if (q > p && (n === 40 || brace)) {
        this.dropVar(this.s.slice(this.pos, p))
        this.pos = q
      }
    }
    this.dropVar("COPROC")
    const snap = new Map(this.env)
    const f = this.beginFrame("sub")
    const node = this.parseUnit()
    this.endFrame(f, false)
    this.leaveSubshell(snap, f.names)
    return node
  }

  private parseCompound(closer: number): Node {
    this.enter()
    const start = this.base + this.pos
    this.pos++
    const saved = this.env
    const f = closer === CL_PAREN ? this.beginFrame("sub") : undefined
    if (closer === CL_PAREN) this.env = new Map(saved)
    const items: Item[] = []
    this.parseList(closer, items)
    if (f) {
      this.endFrame(f, false)
      this.leaveSubshell(saved, f.names)
    }
    if (closer === CL_PAREN ? this.ch() !== 41 : !this.atCloser(CL_BRACE)) {
      this.fail("syntax", closer === CL_PAREN ? "expected )" : "expected }")
    }
    this.pos++
    this.leave()
    const body: Script = { items, start, end: this.base + this.pos }
    const redirects = this.parseTrailingRedirects()
    return closer === CL_PAREN
      ? { type: "subshell", body, redirects }
      : { type: "group", body, redirects }
  }

  private parseTrailingRedirects(): Redirect[] {
    const out: Redirect[] = []
    for (;;) {
      this.skipSpace(false)
      const r = this.tryRedirect()
      if (!r) return out
      out.push(r)
    }
  }

  /** Read a redirect at pos, or return null (pos unchanged). */
  private tryRedirect(): Redirect | null {
    const s = this.s
    let p = this.pos
    while (isDigit(s.charCodeAt(p))) p++
    const c = s.charCodeAt(p)
    const hasFd = p > this.pos
    if (c !== 60 && c !== 62 && !(c === 38 && !hasFd && s.charCodeAt(p + 1) === 62)) return null
    if ((c === 60 || c === 62) && s.charCodeAt(p + 1) === 40) return null
    const op = readOperator(s, p)
    if (!REDIRECT_OPS.has(op)) return null
    const r: Redirect = { op: op as RedirectOp }
    if (hasFd) r.fd = Number(s.slice(this.pos, p))
    this.pos = p + op.length
    this.skipSpace(false)
    const tc = this.ch()
    // `< <(cmd)`: the target is a process substitution (review M5).
    const procTarget = (tc === 60 || tc === 62) && this.ch(this.pos + 1) === 40
    if (this.pos >= this.end || (isMetaChar(tc) && !procTarget))
      this.fail("syntax", `expected target after ${op}`)
    const target = this.readWord()
    r.target = target
    if (op === "<<" || op === "<<-") {
      r.heredoc = {
        delimiter: target.text,
        quoted: target.quoted,
        body: "",
        stripTabs: op === "<<-",
        subs: [],
      }
      this.pending.push(r)
      this.ctx.plain = false
    } else {
      const t = target.text
      const quiet =
        ((op === ">&" || op === "<&") && (t === "1" || t === "2" || t === "-")) ||
        ((op === ">" || op === ">>" || op === "&>") && t === "/dev/null")
      if (!quiet) this.ctx.plain = false
    }
    return r
  }

  private drainHeredocs(): void {
    const s = this.s
    const end = this.end
    const max = this.ctx.lim.maxHeredocBytes
    const queue = this.pending
    this.pending = []
    for (const r of queue) {
      const h = r.heredoc
      if (!h) continue
      const lines: string[] = []
      let size = 0
      const bodyStart = this.pos
      for (;;) {
        if (this.pos >= end) {
          h.body = lines.join("\n")
          this.fail("heredoc-eof", `heredoc ${h.delimiter} not closed`)
        }
        let nl = s.indexOf("\n", this.pos)
        if (nl < 0) nl = end
        let ls = this.pos
        if (h.stripTabs) while (ls < nl && s.charCodeAt(ls) === 9) ls++
        const line = s.slice(ls, nl)
        this.pos = nl < end ? nl + 1 : end
        if (line === h.delimiter) break
        if (size + line.length + 1 > max) h.truncated = true
        else {
          lines.push(line)
          size += line.length + 1
        }
      }
      h.body = lines.join("\n")
      if (!h.quoted) h.subs = this.scanSubs(h.body, this.base + bodyStart)
    }
  }

  /** Length of an assignment prefix `NAME=`, `NAME+=`, `NAME[i]=` at pos, or 0. */
  private assignPrefix(): {
    name: string
    len: number
    append: boolean
    index: string | undefined
  } | null {
    const s = this.s
    let i = this.pos
    if (!isNameStart(s.charCodeAt(i))) return null
    i++
    while (isNameChar(s.charCodeAt(i))) i++
    const nameEnd = i
    if (s.charCodeAt(i) === 91) {
      let j = i + 1
      while (j < this.end && s.charCodeAt(j) !== 93 && !isWordEnd(s.charCodeAt(j))) j++
      if (s.charCodeAt(j) !== 93) return null
      i = j + 1
    }
    const index = i > nameEnd ? s.slice(nameEnd + 1, i - 1) : undefined
    let append = false
    if (s.charCodeAt(i) === 43 && s.charCodeAt(i + 1) === 61) {
      append = true
      i += 2
    } else if (s.charCodeAt(i) === 61) i++
    else return null
    return { name: s.slice(this.pos, nameEnd), len: i - this.pos, append, index }
  }

  /** Read `( ... )` of an array assign at pos as one literal word. */
  private readArrayValue(): Word {
    const e = matchClose(this.s, this.pos, this.end, 41)
    if (e < 0) this.fail("syntax", "unbalanced array assignment")
    const raw = this.s.slice(this.pos, e + 1)
    const subs = this.scanSubs(raw, this.base + this.pos)
    const part: WordPart = { kind: "lit", raw, text: raw }
    if (subs.length > 0) part.subs = subs
    const w = finishWord([part], raw, this.base + this.pos, this.base + e + 1, false)
    this.pos = e + 1
    return w
  }

  /** `name=( ... )` as an argument of declare and friends (review M6). */
  private readDeclArrayWord(): Word | null {
    const a = this.assignPrefix()
    if (!a || this.ch(this.pos + a.len) !== 40) return null
    this.countWord()
    const start = this.pos
    const head = this.s.slice(start, start + a.len)
    this.pos += a.len
    const v = this.readArrayValue()
    const raw = head + v.raw
    const part: WordPart = { kind: "lit", raw, text: raw }
    if (v.subs) part.subs = v.subs
    return finishWord([part], raw, this.base + start, this.base + this.pos, false)
  }

  /** Track frames for flat keywords (review B1). */
  private keyword(kw: string): void {
    switch (kw) {
      case "if":
        this.beginFrame("if")
        break
      case "elif":
      case "else":
        this.forgetFrame(this.topFrame("if"))
        break
      case "fi":
        this.endFrame(this.topFrame("if"), true)
        break
      case "while":
      case "until":
        this.beginLoop()
        break
      case "done":
        this.endLoop()
        break
      default:
        break
    }
  }

  /** Function body: own env, writes do not reach the outer env (review B2). */
  private parseFunctionBody(name: string): Node | null {
    if (name) this.ctx.funcs.add(name)
    this.skipSpace(true)
    const snap = this.env
    this.env = new Map()
    const f = this.beginFrame("func")
    const body = this.parseUnit()
    this.endFrame(f, false)
    this.leaveSubshell(snap, f.names)
    return body
  }

  /** Bare word at pos made of letters only, if it ends cleanly. */
  private peekBare(): string {
    const s = this.s
    let i = this.pos
    while (i < this.end) {
      const c = s.charCodeAt(i)
      if ((c >= 97 && c <= 122) || c === 91 || c === 93) i++
      else break
    }
    if (i === this.pos || !isWordEnd(s.charCodeAt(i))) return ""
    return s.slice(this.pos, i)
  }

  private addSubs(cmd: SimpleCommand, w: Word): void {
    if (w.subs) for (const x of w.subs) cmd.subs.push(x)
  }

  private parseSimple(): Node | null {
    const cmd: SimpleCommand = {
      type: "simple",
      assigns: [],
      words: [],
      argv: [],
      redirects: [],
      subs: [],
      start: this.base + this.pos,
      end: this.base + this.pos,
    }
    if (this.top) this.ctx.started.push(cmd)
    let bracket = false
    for (;;) {
      this.skipSpace(false)
      if (this.pos >= this.end) break
      const c = this.ch()
      if (bracket) {
        if (this.atWord("]]")) {
          bracket = false
        } else if (isMetaChar(c)) {
          const op = this.peekOp()
          if (op === "&&" || op === "||" || op === "<" || op === ">" || op === "(" || op === ")") {
            this.countWord()
            const w = finishWord(
              [{ kind: "lit", raw: op, text: op }],
              op,
              this.pos,
              this.pos + op.length,
              false,
            )
            this.pos += op.length
            cmd.words.push(w)
            cmd.argv.push(op)
            continue
          }
          break
        }
      } else {
        if (isDigit(c) || c === 60 || c === 62 || c === 38) {
          const r = this.tryRedirect()
          if (r) {
            cmd.redirects.push(r)
            if (r.target) this.addSubs(cmd, r.target)
            continue
          }
        }
        if (isMetaChar(c) && !((c === 60 || c === 62) && this.ch(this.pos + 1) === 40)) break
      }
      if (cmd.words.length === 0) {
        const a = this.assignPrefix()
        if (a) {
          this.countWord()
          this.pos += a.len
          const array = this.ch() === 40
          const value = array ? this.readArrayValue() : this.readWord()
          const as: Assign = { name: a.name, value, append: a.append }
          if (array) as.array = true
          if (a.index !== undefined) as.index = a.index
          cmd.assigns.push(as)
          this.addSubs(cmd, value)
          continue
        }
        if (cmd.assigns.length === 0) {
          const kw = this.peekBare()
          if (kw && DROP_KEYWORDS.has(kw)) {
            this.keyword(kw)
            this.pos += kw.length
            this.ctx.plain = false
            continue
          }
          if (kw === "for" || kw === "select") return this.parseForHeader(cmd, kw.length)
          if (kw === "case") return this.parseCase(cmd)
          if (kw === "function") return this.parseFunction()
        }
      }
      const w0 = cmd.words[0]
      const decl = !bracket && w0 !== undefined && !w0.dynamic && EXPORTERS.has(w0.text)
      const dw = decl ? this.readDeclArrayWord() : null
      const w = dw ?? this.readWord()
      this.addSubs(cmd, w)
      const split = bracket || dw ? null : splitWord(w)
      for (const x of split ?? [w]) {
        cmd.words.push(x)
        cmd.argv.push(x.text)
      }
      if (cmd.words.length === 1 && cmd.assigns.length === 0 && !split) {
        if (w.text === "[[" && !w.quoted) bracket = true
        else if (this.isFunctionDef()) {
          if (this.top) this.ctx.started.pop()
          this.ctx.plain = false
          return this.parseFunctionBody(w.text)
        }
      }
    }
    cmd.end = this.base + this.pos
    const arith = this.arithWord(cmd)
    if (arith) {
      this.dropStarted(cmd)
      return arith
    }
    applyWrites(this, this.ctx, cmd)
    if (
      cmd.words.length === 0 &&
      cmd.assigns.length === 0 &&
      cmd.redirects.length === 0 &&
      cmd.subs.length === 0
    ) {
      this.dropStarted(cmd)
      return null
    }
    return cmd
  }

  private dropStarted(cmd: SimpleCommand): void {
    if (!this.top) return
    const i = this.ctx.started.lastIndexOf(cmd)
    if (i >= 0) this.ctx.started.splice(i, 1)
  }

  /** A lone `$(( expr ))` word is an arith command, not a program (review minor). */
  private arithWord(cmd: SimpleCommand): Arith | null {
    if (cmd.words.length !== 1 || cmd.assigns.length > 0 || cmd.redirects.length > 0) return null
    const w = cmd.words[0] as Word
    const p = w.parts[0]
    if (w.parts.length !== 1 || !p || p.kind !== "arith") return null
    return {
      type: "arith",
      expr: p.raw.slice(3, -2),
      subs: p.subs ?? [],
      start: cmd.start,
      end: cmd.end,
    }
  }

  /** `name ( )` after the first word: consume and return true. */
  private isFunctionDef(): boolean {
    let p = this.pos
    while (isBlank(this.s.charCodeAt(p))) p++
    if (this.s.charCodeAt(p) !== 40) return false
    p++
    while (isBlank(this.s.charCodeAt(p))) p++
    if (this.s.charCodeAt(p) !== 41) return false
    this.pos = p + 1
    return true
  }

  private parseFunction(): Node | null {
    this.ctx.plain = false
    this.pos += "function".length
    this.skipSpace(false)
    let name = ""
    if (this.pos < this.end && !isMetaChar(this.ch())) name = this.readWord().text
    this.isFunctionDef()
    return this.parseFunctionBody(name)
  }

  private parseForHeader(cmd: SimpleCommand, kwLen: number): Node | null {
    this.ctx.plain = false
    this.pos += kwLen
    // The loop var and every var written in the body are unknown (review B1).
    this.beginLoop()
    let first = true
    for (;;) {
      this.skipSpace(false)
      if (this.pos >= this.end) break
      const c = this.ch()
      if (c === 40 && this.ch(this.pos + 1) === 40) {
        const e = matchClose(this.s, this.pos, this.end, 41)
        if (e < 0) this.fail("syntax", "unbalanced for (( ))")
        const text = this.s.slice(this.pos, e + 1)
        this.dropIdents(text)
        for (const x of this.scanSubs(text, this.base + this.pos)) cmd.subs.push(x)
        this.pos = e + 1
        first = false
        continue
      }
      if (isMetaChar(c) || this.atWord("do")) break
      const w = this.readWord()
      if (first) this.dropVar(w.text)
      first = false
      this.addSubs(cmd, w)
    }
    cmd.end = this.base + this.pos
    return cmd.subs.length > 0 ? cmd : null
  }

  private parseCase(cmd: SimpleCommand): Node {
    this.ctx.plain = false
    this.pos += 4
    this.skipSpace(false)
    if (this.pos >= this.end || isMetaChar(this.ch())) this.fail("syntax", "case without word")
    this.addSubs(cmd, this.readWord())
    this.skipSpace(true)
    if (!this.atWord("in")) this.fail("syntax", "case without in")
    this.pos += 2
    const start = cmd.start
    const items: Item[] = []
    if (cmd.subs.length > 0) items.push({ node: cmd, sep: "" })
    this.enter()
    const frame = this.beginFrame("case")
    for (;;) {
      this.skipSpace(true)
      if (this.pos >= this.end) this.fail("syntax", "case without esac")
      if (this.atWord("esac")) {
        this.pos += 4
        break
      }
      // Each arm may or may not run: writes of earlier arms are unknown.
      this.forgetFrame(frame)
      if (this.ch() === 40) this.pos++
      for (;;) {
        this.skipSpace(false)
        const c = this.ch()
        if (c === 41) {
          this.pos++
          break
        }
        if (c === 124) {
          this.pos++
          continue
        }
        if (this.pos >= this.end || isMetaChar(c)) this.fail("syntax", "bad case pattern")
        const w = this.readWord()
        this.addSubs(cmd, w)
      }
      this.parseList(CL_CASE, items)
      this.skipSpace(false)
      const op = this.peekOp()
      if (op === ";;" || op === ";&" || op === ";;&") this.pos += op.length
    }
    this.endFrame(frame, true)
    this.leave()
    const body: Script = { items, start, end: this.base + this.pos }
    return { type: "group", body, redirects: this.parseTrailingRedirects() }
  }
}

/** Collect every simple command reachable from `nodes` (iterative). */
function markReached(items: readonly Item[], seen: Set<SimpleCommand>): void {
  const stack: Node[] = items.map((it) => it.node)
  while (stack.length > 0) {
    const n = stack.pop() as Node
    switch (n.type) {
      case "simple":
        seen.add(n)
        break
      case "subshell":
      case "group":
        for (const it of n.body.items) stack.push(it.node)
        break
      case "pipeline":
        for (const st of n.stages) stack.push(st)
        break
      case "andor":
        stack.push(n.left, n.right)
        break
      case "arith":
        break
    }
  }
}

function emptyScript(): Script {
  return { items: [], start: 0, end: 0 }
}

/**
 * Parse `source` as a shell script. Never throws.
 * A failure gives `ok:false` with a reason, the partial tree, and a raw scan.
 */
export function parseCommand(source: string, limits?: Partial<ParseLimits>): ParseResult {
  const t0 = performance.now()
  const lim: ParseLimits = { ...DEFAULT_LIMITS, ...limits }
  const ctx: Ctx = {
    lim,
    words: 0,
    depth: 0,
    maxDepth: 0,
    plain: true,
    started: [],
    topItems: null,
    noTrack: false,
    tainted: new Set(),
    ifsAny: false,
    funcs: new Set(),
  }
  let src = ""
  try {
    // Bash drops NUL bytes when it reads a script (review M8).
    src = stripNul(typeof source === "string" ? source : String(source))
    ctx.ifsAny = src.includes("IFS")
    const tooBig =
      src.length > lim.maxBytes || (src.length * 3 > lim.maxBytes && utf8Length(src) > lim.maxBytes)
    if (tooBig) {
      return {
        ok: false,
        reason: "too-big",
        detail: `input over ${lim.maxBytes} bytes`,
        at: 0,
        partial: emptyScript(),
        rawScan: rawScanTruncated(src, lim.maxBytes),
        stats: {
          bytes: src.length,
          words: 0,
          maxDepth: 0,
          micros: (performance.now() - t0) * 1000,
        },
      }
    }
    const tree = new Parser(src, 0, ctx, true).parseAll()
    return {
      ok: true,
      tree,
      plain: ctx.plain,
      stats: {
        bytes: src.length,
        words: ctx.words,
        maxDepth: ctx.maxDepth,
        micros: (performance.now() - t0) * 1000,
      },
    }
  } catch (e) {
    const f = e instanceof ParseFail ? e : null
    const items = ctx.topItems ? ctx.topItems.slice() : []
    const seen = new Set<SimpleCommand>()
    markReached(items, seen)
    for (const c of ctx.started) {
      if (seen.has(c)) continue
      if (c.words.length + c.assigns.length + c.redirects.length + c.subs.length === 0) continue
      items.push({ node: c, sep: "" })
    }
    return {
      ok: false,
      reason: f ? f.reason : "internal",
      detail: f ? f.detail : e instanceof Error ? e.message : "internal error",
      at: f ? f.at : 0,
      partial: { items, start: 0, end: src.length },
      rawScan: src.length > lim.maxBytes ? rawScanTruncated(src, lim.maxBytes) : rawScan(src),
      stats: {
        bytes: src.length,
        words: ctx.words,
        maxDepth: ctx.maxDepth,
        micros: (performance.now() - t0) * 1000,
      },
    }
  }
}
