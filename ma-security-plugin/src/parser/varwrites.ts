/**
 * Static var tracking after one simple command (design H s5 step 9, review B1/B2).
 * Rule: the parser never keeps a static value that bash could have changed.
 * A plain top-level `NAME=value` sets a value. Every other write makes the
 * name unknown (dynamic). eval, source, trap, and function calls wipe all vars.
 */

import type { Assign, SimpleCommand, Word } from "./ast.ts"
import { isNameChar, isNameStart } from "./lexer.ts"
import type { Ctx } from "./scan.ts"

/** The var store of one parser. */
export interface VarSink {
  getVar(name: string): string | undefined
  setVar(name: string, value: string): void
  dropVar(name: string): void
  wipeVars(): void
  dropIdents(text: string): void
}

/** Declaration builtins. Their `NAME=value` args are assignments. */
export const EXPORTERS: ReadonlySet<string> = new Set([
  "export",
  "declare",
  "local",
  "readonly",
  "typeset",
])

/** Builtins whose identifier args are written. Value: names they write by default. */
const NAME_WRITERS: Readonly<Record<string, readonly string[]>> = {
  read: ["REPLY"],
  mapfile: ["MAPFILE"],
  readarray: ["MAPFILE"],
  getopts: ["OPTARG", "OPTIND"],
  unset: [],
  wait: [],
}

/** Builtins that can change any var. */
const WIPERS: ReadonlySet<string> = new Set(["eval", "source", ".", "trap", "enable"])

/** Leading identifier of `t` when it is all of `t` or ends at `[`, else "". */
export function identPrefix(t: string): string {
  if (!isNameStart(t.charCodeAt(0))) return ""
  let i = 1
  while (i < t.length && isNameChar(t.charCodeAt(i))) i++
  if (i === t.length || t.charCodeAt(i) === 91) return t.slice(0, i)
  return ""
}

function plainAssign(sink: VarSink, a: Assign): void {
  if (a.array || a.index !== undefined || a.value.dynamic) sink.dropVar(a.name)
  else if (a.append) {
    const old = sink.getVar(a.name)
    if (old === undefined) sink.dropVar(a.name)
    else sink.setVar(a.name, old + a.value.text)
  } else sink.setVar(a.name, a.value.text)
}

function declArgs(sink: VarSink, ctx: Ctx, args: readonly Word[]): void {
  let nameref = false
  let taint = false
  for (const a of args) {
    const t = a.text
    const eq = t.indexOf("=")
    const c0 = t.charCodeAt(0)
    if ((c0 === 45 || c0 === 43) && eq < 0) {
      for (let k = 1; k < t.length; k++) {
        const ch = t.charAt(k)
        if (ch === "n") nameref = true
        else if (ch === "i" || ch === "u" || ch === "l" || ch === "c") taint = true
      }
      continue
    }
    let head = eq < 0 ? t : t.slice(0, eq)
    const append = head.endsWith("+")
    if (append) head = head.slice(0, -1)
    const nm = identPrefix(head)
    if (!nm) {
      if (a.dynamic) sink.wipeVars()
      continue
    }
    if (taint) ctx.tainted.add(nm)
    if (eq < 0) {
      if (taint) sink.dropVar(nm)
      continue
    }
    const value = t.slice(eq + 1)
    const plain = !a.dynamic && !append && nm === head && !value.startsWith("(") && !taint
    if (plain) sink.setVar(nm, value)
    else sink.dropVar(nm)
  }
  if (nameref) {
    ctx.noTrack = true
    sink.wipeVars()
  }
}

/** `printf -v NAME` and `printf -vNAME`. */
function printfTarget(args: readonly Word[]): Word | string | undefined {
  for (let k = 0; k < args.length; k++) {
    const t = (args[k] as Word).text
    if (t === "--" || !t.startsWith("-")) return undefined
    if (t === "-v") return args[k + 1]
    if (t.startsWith("-v")) return t.slice(2)
  }
  return undefined
}

/** Update the static env after a complete simple command. */
export function applyWrites(sink: VarSink, ctx: Ctx, cmd: SimpleCommand): void {
  const ws = cmd.words
  if (ws.length === 0) {
    for (const a of cmd.assigns) plainAssign(sink, a)
    return
  }
  // Prefix assigns on a command: bash may keep them (special builtins). Unknown.
  for (const a of cmd.assigns) sink.dropVar(a.name)
  let i = 0
  while (i < ws.length) {
    const w = ws[i] as Word
    if (w.dynamic) {
      // Unknown command: it may be a function or eval.
      sink.wipeVars()
      return
    }
    if (w.text === "builtin") i++
    else if (w.text === "command") {
      i++
      while (i < ws.length && (ws[i] as Word).text.startsWith("-")) i++
    } else break
  }
  const w0 = ws[i]
  if (!w0) return
  const name = w0.text
  const args = ws.slice(i + 1)
  if (ctx.funcs.has(name) || WIPERS.has(name)) {
    if (name === "trap") ctx.noTrack = true
    sink.wipeVars()
    return
  }
  const defaults = NAME_WRITERS[name]
  if (defaults) {
    for (const d of defaults) sink.dropVar(d)
    for (const a of args) {
      // `mapfile -C callback` runs code. A dynamic arg may name anything.
      if (a.dynamic || a.text.startsWith("-C")) {
        sink.wipeVars()
        return
      }
      const nm = identPrefix(a.text)
      if (nm) sink.dropVar(nm)
    }
    return
  }
  if (name === "printf") {
    const t = printfTarget(args)
    if (t === undefined) return
    if (typeof t !== "string" && t.dynamic) sink.wipeVars()
    else {
      const nm = identPrefix(typeof t === "string" ? t : t.text)
      if (nm) sink.dropVar(nm)
    }
    return
  }
  if (name === "let") {
    for (const a of args) {
      if (a.dynamic) {
        sink.wipeVars()
        return
      }
      sink.dropIdents(a.text)
    }
    return
  }
  if (EXPORTERS.has(name)) declArgs(sink, ctx, args)
}
