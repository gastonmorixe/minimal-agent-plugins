/**
 * Guard-facing walk (design H, sections 3 ExecView and 10).
 * Visits every simple command in lists, pipelines, groups, subshells,
 * command and process substitutions, heredoc subs, and unwrapped payloads.
 * Unwrap runs after parse and has its own depth limit (wrapper depth 4).
 */

import type { Assign, Node, Redirect, Script, SimpleCommand, Word } from "./ast.ts"
import { DEFAULT_LIMITS } from "./ast.ts"
import type { FlagSet } from "./flags.ts"
import { FLAG_SPECS, GIT_SPECS, normalizeFlags } from "./flags.ts"
import { parseCommand } from "./parse.ts"
import type { Interpreter } from "./unwrap.ts"
import { basename, classify, DISPLAY_CMDS, isProcsubIn, TEXT_PRODUCERS } from "./unwrap.ts"

export type Origin =
  | "top"
  | "cmdsub"
  | "procsub"
  | "heredoc"
  | "dash-c"
  | "eval"
  | "source"
  | "xargs"
  | "find-exec"

export interface ExecView {
  /** Original simple command node. */
  cmd: SimpleCommand
  /** Basename of the resolved executable, after unwrap, as written. */
  name: string
  /**
   * `name` in lower case. macOS file systems are case-insensitive, so `RM`
   * runs /bin/rm. Guards must match command names on `nameLower`.
   */
  nameLower: string
  /** Name is not a literal word (`$x`, `$(..)m`), or an eval of dynamic text. */
  nameDynamic: boolean
  /** Words after the name. */
  args: Word[]
  flags: FlagSet
  operands: Word[]
  /** Wrappers peeled, outer first, for example `["sudo", "env"]`. */
  chain: string[]
  /** Prefix assigns plus those of `env K=V`. */
  assigns: Assign[]
  redirects: Redirect[]
  /** Display command: rules must not match argument text. */
  display: boolean
  /** xargs: operands are not known at parse time. */
  unknownTail: boolean
  /** Main view of the previous pipeline stage. */
  viaPipeFrom?: ExecView
  origin: Origin
  /** Wrapper plus nesting depth. */
  depth: number
  /** Inline interpreter code, for a keyword scan. */
  text?: string
  interpreter?: Interpreter
  /** Wrapper depth cut: inner command or payload not unwrapped. */
  limitHit?: boolean
  /** Command runs on another host or container (ssh, docker, kubectl). */
  remote?: boolean
}

export interface WalkCtx {
  depth: number
  origin: Origin
  inPipeline: boolean
  /** Stage number, 0 for the first. */
  pipeIndex: number
  /** Item is followed by `&`. */
  background: boolean
  /** Reached after `&&` or `||`. */
  conditional: "none" | "and" | "or"
  negated: boolean
}

export interface LimitInfo {
  reason: string
  at: number
  /** Text that was not walked. Feed it to `rawScan`. */
  raw: string
}

export interface Visitor {
  command?(view: ExecView, ctx: WalkCtx): undefined | "stop"
  redirect?(r: Redirect, view: ExecView | null, ctx: WalkCtx): void
  assign?(a: Assign, ctx: WalkCtx): void
  inlineCode?(text: string, interpreter: string, view: ExecView): void
  limit?(info: LimitInfo): void
}

export interface WalkOptions {
  /** Wrapper plus payload depth. Default 4. */
  maxWrapperDepth?: number
}

const TOP_CTX: WalkCtx = {
  depth: 0,
  origin: "top",
  inPipeline: false,
  pipeIndex: 0,
  background: false,
  conditional: "none",
  negated: false,
}

/** Text that a producer stage writes into a shell. */
function producedText(v: ExecView): string | undefined {
  for (const r of v.redirects) {
    if (r.heredoc) return r.heredoc.body
    if (r.op === "<<<" && r.target) return r.target.text
  }
  if (!TEXT_PRODUCERS.has(v.name) || v.name === "cat") return undefined
  let args = v.args
  if (v.name === "echo") {
    let i = 0
    while (i < args.length && /* -n -e -E */ isEchoFlag((args[i] as Word).text)) i++
    args = args.slice(i)
  } else if (args.length > 1 && (args[0] as Word).text.includes("%")) {
    args = args.slice(1)
  }
  return args.map((w) => w.text).join(" ")
}

/**
 * Name of a dynamic first word (review minor). A `/` inside a substitution or
 * brace must not split it. Only a static last part with a `/` gives a basename
 * (`$HOME/bin/rm` gives `rm`). Otherwise the name is the raw word.
 */
function dynamicName(w: Word): string {
  const last = w.parts[w.parts.length - 1]
  const t = last && (last.kind === "lit" || last.kind === "sq") ? (last.text ?? "") : ""
  return t.includes("/") ? basename(t) : w.raw
}

function isEchoFlag(t: string): boolean {
  if (t.length < 2 || t.charCodeAt(0) !== 45) return false
  for (let i = 1; i < t.length; i++) {
    const c = t.charAt(i)
    if (c !== "n" && c !== "e" && c !== "E") return false
  }
  return true
}

class Walker {
  limited = false
  stopped = false

  constructor(
    private readonly v: Visitor,
    private readonly maxW: number,
  ) {}

  script(s: Script, c: WalkCtx, wd: number): void {
    for (const it of s.items) {
      if (this.stopped) return
      this.node(it.node, { ...c, background: it.sep === "&" || c.background }, wd, undefined)
    }
  }

  /** Walk a node. Returns the main view of a simple command (for pipes). */
  node(n: Node, c: WalkCtx, wd: number, feed: ExecView | undefined): ExecView | undefined {
    switch (n.type) {
      case "simple":
        return this.simple(n, c, wd, feed)
      case "subshell":
      case "group":
        this.script(n.body, c, wd)
        for (const r of n.redirects) this.redirect(r, null, c, wd)
        return undefined
      case "arith":
        for (const s of n.subs) this.sub(s, c, wd)
        return undefined
      case "andor":
        this.node(n.left, c, wd, undefined)
        if (!this.stopped) {
          this.node(n.right, { ...c, conditional: n.op === "&&" ? "and" : "or" }, wd, undefined)
        }
        return undefined
      case "pipeline": {
        let prev: ExecView | undefined
        const multi = n.stages.length > 1
        for (let i = 0; i < n.stages.length && !this.stopped; i++) {
          const sc: WalkCtx = {
            ...c,
            inPipeline: multi || c.inPipeline,
            pipeIndex: i,
            negated: n.negated || c.negated,
          }
          prev = this.node(n.stages[i] as Node, sc, wd, prev)
        }
        return undefined
      }
    }
  }

  private emit(view: ExecView, c: WalkCtx): void {
    if (this.stopped) return
    if (this.v.command?.(view, { ...c, origin: view.origin, depth: view.depth }) === "stop") {
      this.stopped = true
    }
  }

  private redirect(r: Redirect, view: ExecView | null, c: WalkCtx, wd: number): void {
    this.v.redirect?.(r, view, c)
    if (r.target?.subs) for (const s of r.target.subs) this.sub(s, c, wd)
    if (r.heredoc) {
      const hc: WalkCtx = { ...c, origin: "heredoc", depth: c.depth + 1 }
      for (const s of r.heredoc.subs) this.script(s, hc, wd)
    }
  }

  private sub(s: Script, c: WalkCtx, wd: number): void {
    const origin: Origin = s.kind === "procsub" ? "procsub" : "cmdsub"
    this.script(s, { ...c, origin, depth: c.depth + 1, inPipeline: false, pipeIndex: 0 }, wd)
  }

  private limit(reason: string, at: number, raw: string): void {
    this.limited = true
    this.v.limit?.({ reason, at, raw })
  }

  /** Parse payload text and walk it, or report a limit. */
  private payload(text: string, origin: Origin, c: WalkCtx, wd: number, at: number): void {
    const r = parseCommand(text)
    const pc: WalkCtx = { ...c, origin, depth: c.depth + 1, inPipeline: false, pipeIndex: 0 }
    if (!r.ok) this.limit(`payload-${r.reason}`, at, text)
    this.script(r.ok ? r.tree : r.partial, pc, wd)
  }

  private simple(
    cmd: SimpleCommand,
    c: WalkCtx,
    wd: number,
    feed: ExecView | undefined,
  ): ExecView | undefined {
    let main: ExecView | undefined
    if (cmd.words.length > 0) {
      main = this.resolve(cmd, cmd.words, cmd.assigns, [], c, wd, c.origin, false, feed)
    }
    for (const a of cmd.assigns) this.v.assign?.(a, c)
    for (const r of cmd.redirects) this.redirect(r, main ?? null, c, wd)
    const seen = new Set<Script>()
    for (const r of cmd.redirects) if (r.target?.subs) for (const s of r.target.subs) seen.add(s)
    for (const s of cmd.subs) {
      if (this.stopped) break
      if (!seen.has(s)) this.sub(s, c, wd)
    }
    return main
  }

  private makeView(
    cmd: SimpleCommand,
    words: Word[],
    assigns: Assign[],
    chain: string[],
    origin: Origin,
    depth: number,
    unknownTail: boolean,
    feed: ExecView | undefined,
  ): ExecView {
    const w0 = words[0] as Word
    const name = w0.dynamic ? dynamicName(w0) : basename(w0.text)
    const nameLower = name.toLowerCase()
    const args = words.slice(1)
    const { flags, operands } = normalizeFlags(args, FLAG_SPECS[nameLower])
    const view: ExecView = {
      cmd,
      name,
      nameLower,
      nameDynamic: w0.dynamic,
      args,
      flags,
      operands,
      chain,
      assigns,
      redirects: cmd.redirects,
      display: false,
      unknownTail,
      origin,
      depth,
    }
    if (feed) view.viaPipeFrom = feed
    return view
  }

  /**
   * Script text that a `<(...)` word produces (its last producer). The producer
   * view is also set as `view.viaPipeFrom`, so `source <(curl x)` reads like a pipe.
   */
  private procsubText(w: Word, view: ExecView): string | undefined {
    const sub = w.parts[0]?.sub
    const last = sub?.items[sub.items.length - 1]?.node
    const n = last?.type === "pipeline" ? last.stages[last.stages.length - 1] : last
    if (!n || n.type !== "simple" || n.words.length === 0) return undefined
    const v = this.makeView(n, n.words, n.assigns, [], "procsub", 0, false, undefined)
    view.viaPipeFrom ??= v
    return producedText(v)
  }

  /** `sh < <(producer)`: text of the procsub behind a `<` redirect (review M5). */
  private redirectProcsubText(view: ExecView): string | undefined {
    for (const r of view.redirects) {
      if (r.op === "<" && r.target && isProcsubIn(r.target)) return this.procsubText(r.target, view)
    }
    return undefined
  }

  /** Resolve wrappers for `words`, emit views. Returns the innermost view. */
  private resolve(
    cmd: SimpleCommand,
    words: Word[],
    assigns: Assign[],
    chain: string[],
    c: WalkCtx,
    wd: number,
    origin: Origin,
    unknownTail: boolean,
    feed: ExecView | undefined,
  ): ExecView {
    const depth = c.depth + chain.length
    const view = this.makeView(cmd, words, assigns, chain, origin, depth, unknownTail, feed)
    if (view.nameDynamic) {
      this.emit(view, c)
      return view
    }
    // Wrappers match case-insensitively (`SUDO rm` runs sudo on macOS). Safe side.
    const u = classify(view.nameLower, view.args)
    switch (u.k) {
      case "peel": {
        if (u.remote) view.remote = true
        if (u.emitSelf) this.emit(view, c)
        let last = view
        for (const inner of u.inners) {
          if (this.stopped) break
          const chain2 = [...chain, view.name]
          const all = u.assigns.length > 0 ? [...assigns, ...u.assigns] : assigns
          const tail = unknownTail || u.unknownTail === true
          const org = u.origin ?? origin
          if (wd + 1 > this.maxW) {
            const iv = this.makeView(cmd, inner, all, chain2, org, depth + 1, tail, feed)
            iv.limitHit = true
            iv.display = DISPLAY_CMDS.has(iv.name)
            this.limit("wrapper-depth", cmd.start, inner.map((w) => w.text).join(" "))
            this.emit(iv, c)
            last = iv
          } else {
            last = this.resolve(cmd, inner, all, chain2, c, wd + 1, org, tail, feed)
          }
        }
        return last
      }
      case "payload": {
        if (u.remote) view.remote = true
        if (u.dynamic) {
          view.nameDynamic = true
          this.emit(view, c)
          return view
        }
        if (wd + 1 > this.maxW) {
          view.limitHit = true
          this.limit("wrapper-depth", cmd.start, u.text)
          this.emit(view, c)
          return view
        }
        this.emit(view, c)
        this.payload(u.text, u.origin, { ...c, depth }, wd + 1, cmd.start)
        return view
      }
      case "stdin-shell": {
        this.emit(view, c)
        const text = u.from
          ? this.procsubText(u.from, view)
          : (producedText(view) ??
            this.redirectProcsubText(view) ??
            (feed ? producedText(feed) : undefined))
        if (text !== undefined && !this.stopped) {
          if (wd + 1 > this.maxW) {
            view.limitHit = true
            this.limit("wrapper-depth", cmd.start, text)
          } else this.payload(text, "heredoc", { ...c, depth }, wd + 1, cmd.start)
        }
        return view
      }
      case "interp": {
        view.interpreter = u.interpreter
        if (u.text !== undefined) view.text = u.text
        view.display =
          u.interpreter === "awk" &&
          DISPLAY_CMDS.has(view.name) &&
          !(u.text ?? "").includes("system(")
        this.emit(view, c)
        if (u.text !== undefined) this.v.inlineCode?.(u.text, u.interpreter, view)
        return view
      }
      default:
        view.display = DISPLAY_CMDS.has(view.name)
        this.emit(view, c)
        return view
    }
  }
}

/** Walk every command view in `tree`. Never throws for a parsed tree. */
export function walkCommands(
  tree: Script,
  visitor: Visitor,
  opts?: WalkOptions,
): { limited: boolean } {
  const w = new Walker(visitor, opts?.maxWrapperDepth ?? DEFAULT_LIMITS.maxWrapperDepth)
  w.script(tree, TOP_CTX, 0)
  return { limited: w.limited }
}

/** All views of `tree`, in walk order. */
export function collectCommands(tree: Script, opts?: WalkOptions): ExecView[] {
  const out: ExecView[] = []
  walkCommands(
    tree,
    {
      command(view) {
        out.push(view)
        return undefined
      },
    },
    opts,
  )
  return out
}

const GIT_GLOBAL_VALUE: ReadonlySet<string> = new Set([
  "-c",
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
  "--exec-path",
])

export interface GitCall {
  sub?: string
  /** Words after the subcommand. */
  args: Word[]
  /** Global options before the subcommand, as written. */
  globals: string[]
  flags: FlagSet
  operands: Word[]
}

/** Split a `git` view into global options, subcommand, and its flags. */
export function gitSubcommand(view: ExecView): GitCall {
  const globals: string[] = []
  const a = view.args
  let i = 0
  while (i < a.length) {
    const t = (a[i] as Word).text
    if (t.length < 2 || t.charCodeAt(0) !== 45) break
    globals.push(t)
    if (GIT_GLOBAL_VALUE.has(t) && i + 1 < a.length) {
      globals.push((a[i + 1] as Word).text)
      i += 2
    } else i++
  }
  const subWord = a[i]
  const args = a.slice(i + 1)
  const sub = subWord?.text
  const { flags, operands } = normalizeFlags(args, sub ? GIT_SPECS[sub] : undefined)
  const out: GitCall = { args, globals, flags, operands }
  if (sub !== undefined) out.sub = sub
  return out
}
