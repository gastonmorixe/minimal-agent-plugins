/**
 * AST types for the security plugin shell parser (design H, section 3).
 * The parser never executes or expands shell. It only describes it.
 */

/** Hard limits for one parse. */
export interface ParseLimits {
  /** Max input size in bytes. Default 131072. */
  maxBytes: number
  /** Max words (argv words plus assigns) in one parse. Default 16384. */
  maxWords: number
  /** Max syntax nesting of `$()`, backticks, `( )`, `{ }`, `${ }`. Default 32. */
  maxDepth: number
  /** Max wrapper plus payload depth in the walker. Default 4. */
  maxWrapperDepth: number
  /** Max bytes kept per heredoc body. Default 65536. */
  maxHeredocBytes: number
}

export const DEFAULT_LIMITS: Readonly<ParseLimits> = Object.freeze({
  maxBytes: 131072,
  maxWords: 16384,
  maxDepth: 32,
  maxWrapperDepth: 4,
  maxHeredocBytes: 65536,
})

export type Root = "home" | "cwd" | "root"

export type PartKind =
  | "lit"
  | "sq"
  | "dq"
  | "ansic"
  | "param"
  | "cmdsub"
  | "arith"
  | "glob"
  | "brace"
  | "tilde"

export interface WordPart {
  kind: PartKind
  raw: string
  /** Resolved text when the part is static (or a param resolved from the static env). */
  text?: string
  /** Parsed script for `$()`, backtick, `<()`, `>()`. */
  sub?: Script
  /** Extra nested scripts inside one part, for example `${x:-$(a)$(b)}`. */
  subs?: Script[]
  /** Param name for `param` parts. */
  name?: string
  /** Unquoted param part: the shell splits and globs its value. */
  bare?: boolean
}

export interface Word {
  raw: string
  /** Best-effort resolved text. Dynamic parts stay as raw source. */
  text: string
  /** True when any part is param (unresolved), cmdsub, glob, brace, arith, or tilde. */
  dynamic: boolean
  /** Any quoting or backslash escape present. */
  quoted: boolean
  /** Anchor of a dynamic word: `~`, `$HOME`, `$PWD`, `*`, `/*`. */
  root?: Root
  /** True when a param part was resolved from the static env (`X=/; rm $X`). */
  viaVar?: boolean
  parts: WordPart[]
  /** Every nested script found anywhere in this word. */
  subs?: Script[]
  start: number
  end: number
}

export type RedirectOp =
  | "<"
  | ">"
  | ">>"
  | ">|"
  | "<>"
  | ">&"
  | "<&"
  | "&>"
  | "&>>"
  | "<<"
  | "<<-"
  | "<<<"

export interface Heredoc {
  delimiter: string
  quoted: boolean
  body: string
  stripTabs: boolean
  /** Body was cut at `maxHeredocBytes`. */
  truncated?: boolean
  /** Substitutions found in an unquoted body. The shell runs them even for `cat`. */
  subs: Script[]
}

export interface Redirect {
  op: RedirectOp
  fd?: number
  target?: Word
  heredoc?: Heredoc
}

export interface Assign {
  name: string
  value: Word
  append: boolean
  /** Array value `name=( ... )`. */
  array?: boolean
  /** Subscript of `name[i]=`. */
  index?: string
}

export interface SimpleCommand {
  type: "simple"
  assigns: Assign[]
  words: Word[]
  argv: string[]
  redirects: Redirect[]
  subs: Script[]
  start: number
  end: number
}

export interface Subshell {
  type: "subshell"
  body: Script
  redirects: Redirect[]
}
export interface Group {
  type: "group"
  body: Script
  redirects: Redirect[]
}
export interface Pipeline {
  type: "pipeline"
  negated: boolean
  stages: Node[]
}
export interface AndOr {
  type: "andor"
  op: "&&" | "||"
  left: Node
  right: Node
}
/** Arithmetic command `(( expr ))`, or a lone `$(( expr ))` word. Runs no program. */
export interface Arith {
  type: "arith"
  /** Expression text between the parens. */
  expr: string
  /** Substitutions inside the expression. */
  subs: Script[]
  start: number
  end: number
}
export type Node = SimpleCommand | Subshell | Group | Pipeline | AndOr | Arith

export interface Item {
  node: Node
  sep: ";" | "&" | "\n" | ""
}
export interface Script {
  items: Item[]
  start: number
  end: number
  /** Set on nested scripts: how the shell reaches them. */
  kind?: "cmdsub" | "procsub"
}

export interface RawScan {
  /** Comments removed. Quotes kept. */
  stripped: string
  /** Split on blanks and operators. Quote chars and backslashes removed. */
  tokens: string[]
  hasUnclosedQuote: boolean
  /** Input was over the parse byte limit (too-big). The parser did not see it. */
  truncated: boolean
  /**
   * False only when the scan skipped the middle: input over 4 MB, so only the
   * first 2 MB and the last 2 MB were scanned.
   */
  fullScan: boolean
}

export interface Stats {
  bytes: number
  words: number
  maxDepth: number
  micros: number
}

export type FailReason =
  | "too-big"
  | "too-many-words"
  | "too-deep"
  | "syntax"
  | "heredoc-eof"
  | "internal"

export type ParseResult =
  | { ok: true; tree: Script; plain: boolean; stats: Stats }
  | {
      ok: false
      reason: FailReason
      detail: string
      at: number
      partial: Script
      rawScan: RawScan
      stats: Stats
    }
