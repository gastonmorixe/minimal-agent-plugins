/**
 * Word helpers: build a Word from typed parts, compute text, dynamic, and root tags
 * (design H, section 5 steps 8 and 9).
 */

import type { Root, Script, Word, WordPart } from "./ast.ts"

/** Part kinds whose value is not known at parse time. */
function partIsDynamic(p: WordPart): boolean {
  switch (p.kind) {
    case "lit":
    case "sq":
    case "dq":
    case "ansic":
      return false
    case "param":
      return p.text === undefined
    default:
      return true
  }
}

function rootOfParam(name: string | undefined): Root | undefined {
  if (name === "HOME") return "home"
  if (name === "PWD" || name === "OLDPWD") return "cwd"
  return undefined
}

/** Assemble a Word from its parts. `raw` is the exact source slice. */
export function finishWord(
  parts: WordPart[],
  raw: string,
  start: number,
  end: number,
  quoted: boolean,
): Word {
  const chunks: string[] = []
  let dynamic = false
  let viaVar = false
  let subs: Script[] | undefined
  let firstGlob = -1
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] as WordPart
    chunks.push(p.text ?? p.raw)
    if (partIsDynamic(p)) {
      dynamic = true
      if (firstGlob < 0 && p.kind === "glob") firstGlob = i
    } else if (p.kind === "param") {
      viaVar = true
    }
    if (p.subs) for (const s of p.subs) (subs ??= []).push(s)
    else if (p.sub) (subs ??= []).push(p.sub)
  }
  const text = chunks.join("")
  const w: Word = { raw, text, dynamic, quoted, parts, start, end }
  if (viaVar) w.viaVar = true
  if (subs) w.subs = subs
  const p0 = parts[0]
  if (p0) {
    if (p0.kind === "tilde") w.root = "home"
    else if (p0.kind === "param" && p0.text === undefined) {
      const r = rootOfParam(p0.name)
      if (r) w.root = r
    }
  }
  if (!w.root && firstGlob >= 0) {
    let prefix = ""
    let staticPrefix = true
    for (let i = 0; i < firstGlob; i++) {
      const p = parts[i] as WordPart
      if (partIsDynamic(p)) {
        staticPrefix = false
        break
      }
      prefix += p.text ?? p.raw
    }
    if (staticPrefix) {
      if (prefix === "/") w.root = "root"
      else if (prefix === "" || prefix === "./") w.root = "cwd"
    }
  }
  if (!w.root && !dynamic && (text === "." || text === "./")) w.root = "cwd"
  return w
}

/** Build a plain literal word (used for synthetic words and env-wrapper assigns). */
export function litWord(text: string, start = 0, end = start + text.length): Word {
  return finishWord([{ kind: "lit", raw: text, text }], text, start, end, false)
}

/** Word holding a static part for `{}` placeholders and similar: same text, but dynamic. */
export function dynamicCopy(w: Word): Word {
  return { ...w, dynamic: true }
}

function isIfs(c: number): boolean {
  return c === 32 || c === 9 || c === 10
}

function isGlobChar(c: number): boolean {
  return c === 42 || c === 63 || c === 91
}

/** Resolved unquoted param whose value the shell splits or globs (review B3). */
function needsSplit(p: WordPart): boolean {
  if (p.kind !== "param" || !p.bare || p.text === undefined) return false
  const t = p.text
  if (t === "") return true
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i)
    if (isIfs(c) || isGlobChar(c)) return true
  }
  return false
}

/**
 * Field splitting and globbing of resolved unquoted params (default IFS).
 * Returns null when the word is kept as is. Returns the fields otherwise
 * (none when the expansion is empty). A word that mixes quotes or other
 * dynamic parts with a split param becomes one dynamic word.
 */
export function splitWord(w: Word): Word[] | null {
  if (!w.parts.some(needsSplit)) return null
  for (const p of w.parts) {
    const litOk = p.kind === "lit" && p.raw === p.text
    const paramOk = p.kind === "param" && p.bare === true && p.text !== undefined
    if (!litOk && !paramOk) return [{ ...w, dynamic: true }]
  }
  const fields: WordPart[][] = []
  let cur: WordPart[] = []
  let buf = ""
  const flushBuf = (): void => {
    if (buf) cur.push({ kind: "lit", raw: buf, text: buf })
    buf = ""
  }
  const endField = (): void => {
    flushBuf()
    if (cur.length > 0) fields.push(cur)
    cur = []
  }
  for (const p of w.parts) {
    const t = p.text ?? ""
    if (p.kind === "lit") {
      buf += t
      continue
    }
    for (let i = 0; i < t.length; i++) {
      const c = t.charCodeAt(i)
      if (isIfs(c)) endField()
      else if (isGlobChar(c)) {
        flushBuf()
        cur.push({ kind: "glob", raw: t.charAt(i) })
      } else buf += t.charAt(i)
    }
  }
  endField()
  return fields.map((parts) => {
    const raw = parts.map((p) => p.text ?? p.raw).join("")
    const f = finishWord(parts, raw, w.start, w.end, false)
    f.viaVar = true
    return f
  })
}

/** True when the first part of the word is not literal text (fully unknown start). */
export function startsDynamic(w: Word): boolean {
  const p = w.parts[0]
  return p !== undefined && partIsDynamic(p)
}
