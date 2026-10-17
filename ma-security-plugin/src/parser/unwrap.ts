/**
 * Wrapper unwrap table (design H, section 9).
 * `classify(name, args)` says how to reach the real command behind a wrapper:
 * peel words, re-parse a text payload, read a shell from stdin, or keep
 * inline interpreter code for a keyword scan. Data tables, not code branches.
 */

import type { Assign, Word } from "./ast.ts"
import { basename } from "./lexer.ts"
import { dynamicCopy } from "./words.ts"

export { basename }

export type Interpreter =
  | "python"
  | "node"
  | "bun"
  | "deno"
  | "perl"
  | "ruby"
  | "php"
  | "lua"
  | "awk"

export type Unwrap =
  /** Inner command words. `inners` may hold more than one (find with two -exec). */
  | {
      k: "peel"
      inners: Word[][]
      assigns: Assign[]
      emitSelf: boolean
      origin?: "xargs" | "find-exec"
      unknownTail?: boolean
      remote?: boolean
    }
  /** Text to parse as a script. `dynamic` means the text is not known. */
  | { k: "payload"; text: string; dynamic: boolean; origin: "dash-c" | "eval"; remote?: boolean }
  /**
   * A shell (or `source /dev/stdin`) that reads its script from stdin.
   * `from` is a `<(...)` operand that feeds the script instead (review M4).
   */
  | { k: "stdin-shell"; from?: Word }
  /** Interpreter with inline code (or reading stdin when `text` is absent). */
  | { k: "interp"; interpreter: Interpreter; text?: string }
  | { k: "none" }

interface OptSpec {
  /** Short letters that take a value. */
  v: string
  /** Long names that take the next arg when no `=` is given. */
  lv?: readonly string[]
}

/** Index of the first operand after options. `--` is consumed. */
export function skipOptions(args: readonly Word[], spec: OptSpec, from = 0): number {
  let i = from
  while (i < args.length) {
    const t = (args[i] as Word).text
    if (t === "--") return i + 1
    if (t.length < 2 || t.charCodeAt(0) !== 45) return i
    if (t.charCodeAt(1) === 45) {
      const name = t.slice(2)
      i += name.indexOf("=") < 0 && spec.lv?.includes(name) ? 2 : 1
      continue
    }
    let take = 1
    for (let j = 1; j < t.length; j++) {
      if (spec.v.includes(t.charAt(j))) {
        if (j + 1 >= t.length) take = 2
        break
      }
    }
    i += take
  }
  return i
}

function isAssignWord(w: Word): boolean {
  const t = w.text
  const eq = t.indexOf("=")
  if (eq <= 0) return false
  for (let k = 0; k < eq; k++) {
    const c = t.charCodeAt(k)
    const ok =
      c === 95 || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (k > 0 && c >= 48 && c <= 57)
    if (!ok) return false
  }
  return true
}

function wordAssign(w: Word): Assign {
  const t = w.text
  const eq = t.indexOf("=")
  const value: Word = { ...w, raw: t.slice(eq + 1), text: t.slice(eq + 1) }
  return { name: t.slice(0, eq), value, append: false }
}

function peel(inner: Word[], extra: Partial<Extract<Unwrap, { k: "peel" }>> = {}): Unwrap {
  if (inner.length === 0) return { k: "none" }
  return { k: "peel", inners: [inner], assigns: [], emitSelf: false, ...extra }
}

function joinText(ws: readonly Word[]): { text: string; dynamic: boolean } {
  let dynamic = false
  const out: string[] = []
  for (const w of ws) {
    if (w.dynamic) dynamic = true
    out.push(w.text)
  }
  return { text: out.join(" "), dynamic }
}

const SIMPLE_WRAPPERS: Readonly<Record<string, OptSpec>> = {
  builtin: { v: "" },
  exec: { v: "a" },
  nohup: { v: "" },
  nice: { v: "n", lv: ["adjustment"] },
  time: { v: "fo", lv: ["format", "output"] },
  stdbuf: { v: "ioe", lv: ["input", "output", "error"] },
  // Review M1.
  busybox: { v: "" },
  setsid: { v: "" },
  ionice: { v: "cnpPu", lv: ["class", "classdata", "pid", "pgid", "uid"] },
  unshare: {
    v: "ST",
    lv: ["setuid", "setgid", "propagation", "map-user", "map-group", "wd", "root"],
  },
  nsenter: {
    v: "tSGwr",
    lv: ["target", "setuid", "setgid", "wd", "root", "env"],
  },
  firejail: { v: "" },
  caffeinate: { v: "tw" },
}

/** Wrappers that take options, then a fixed count of value args, then the command. */
const POSITIONAL_WRAPPERS: Readonly<Record<string, { spec: OptSpec; skip: number }>> = {
  chroot: { spec: { v: "", lv: ["userspec", "groups"] }, skip: 1 },
  chrt: { spec: { v: "T", lv: ["sched-runtime", "sched-period", "sched-deadline"] }, skip: 1 },
}

const FLOCK: OptSpec = { v: "wEc", lv: ["timeout", "wait", "conflict-exit-code", "command"] }
const SU: OptSpec = {
  v: "cgGsw",
  lv: ["command", "group", "supp-group", "shell", "whitelist-environment"],
}
const SCRIPT: OptSpec = {
  v: "cEeIOTtBm",
  lv: ["command", "echo", "log-in", "log-out", "log-timing", "timing", "logging-format"],
}

const SUDO: OptSpec = {
  v: "ughpCDRTrt",
  lv: ["user", "group", "host", "prompt", "close-from", "chdir", "chroot", "role", "type"],
}
const DOAS: OptSpec = { v: "uC" }
const TIMEOUT: OptSpec = { v: "sk", lv: ["signal", "kill-after"] }
const WATCH: OptSpec = { v: "nq", lv: ["interval", "equexit"] }
const XARGS: OptSpec = {
  v: "InPLsdaE",
  lv: [
    "replace",
    "max-args",
    "max-procs",
    "max-lines",
    "max-chars",
    "delimiter",
    "arg-file",
    "eof",
  ],
}
const SSH: OptSpec = { v: "piloJFLRDbcmSWEeIOBQw" }
const ENV: OptSpec = { v: "uCS", lv: ["unset", "chdir", "split-string"] }

export const SHELLS: ReadonlySet<string> = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "csh",
  "tcsh",
])

const INTERP: Readonly<Record<string, Interpreter>> = {
  python: "python",
  python2: "python",
  python3: "python",
  node: "node",
  nodejs: "node",
  bun: "bun",
  deno: "deno",
  perl: "perl",
  ruby: "ruby",
  php: "php",
  lua: "lua",
  awk: "awk",
  gawk: "awk",
  mawk: "awk",
  nawk: "awk",
}

/** Inline code flags per interpreter. */
const CODE_FLAGS: Readonly<Record<Interpreter, readonly string[]>> = {
  python: ["-c"],
  node: ["-e", "--eval", "-p", "--print"],
  bun: ["-e", "--eval", "-p", "--print"],
  deno: ["eval"],
  perl: ["-e", "-E"],
  ruby: ["-e"],
  php: ["-r"],
  lua: ["-e"],
  awk: [],
}

function classifyEnv(args: Word[]): Unwrap {
  const assigns: Assign[] = []
  let i = 0
  while (i < args.length) {
    const t = (args[i] as Word).text
    if (t === "-S" || t === "--split-string") {
      const s = args[i + 1]
      return s
        ? { k: "payload", text: s.text, dynamic: s.dynamic, origin: "dash-c" }
        : { k: "none" }
    }
    if (t.startsWith("--split-string=")) {
      return {
        k: "payload",
        text: t.slice(15),
        dynamic: (args[i] as Word).dynamic,
        origin: "dash-c",
      }
    }
    if (t.startsWith("-") && t !== "-") {
      i = skipOptions(args, ENV, i)
      if ((args[i - 1] as Word | undefined)?.text === "--") break
      continue
    }
    if (t === "-") {
      i++
      continue
    }
    if (isAssignWord(args[i] as Word)) {
      assigns.push(wordAssign(args[i] as Word))
      i++
      continue
    }
    break
  }
  while (i < args.length && isAssignWord(args[i] as Word))
    assigns.push(wordAssign(args[i++] as Word))
  const inner = args.slice(i)
  if (inner.length === 0) return { k: "none" }
  return { k: "peel", inners: [inner], assigns, emitSelf: false }
}

function classifyShell(args: Word[]): Unwrap {
  let i = 0
  let dashC = false
  let stdin = false
  while (i < args.length) {
    const t = (args[i] as Word).text
    if (t === "--" || t === "-") {
      i++
      break
    }
    const c0 = t.charCodeAt(0)
    if (t.length < 2 || (c0 !== 45 && c0 !== 43)) break
    if (t.charCodeAt(1) === 45) {
      i += t === "--rcfile" || t === "--init-file" ? 2 : 1
      continue
    }
    let take = 1
    for (let j = 1; j < t.length; j++) {
      const ch = t.charAt(j)
      if (ch === "c") dashC = true
      else if (ch === "s") stdin = true
      else if (ch === "o" || ch === "O") take = 2
    }
    i += take
  }
  if (dashC) {
    const p = args[i]
    if (!p) return { k: "none" }
    return { k: "payload", text: p.text, dynamic: p.dynamic, origin: "dash-c" }
  }
  if (stdin || i >= args.length) return { k: "stdin-shell" }
  return fedOperand(args[i] as Word)
}

/** Paths that name the shell's own stdin. */
const STDIN_PATHS: ReadonlySet<string> = new Set([
  "/dev/stdin",
  "/dev/fd/0",
  "-",
  "/proc/self/fd/0",
])

/** True when `w` is one `<(...)` process substitution. */
export function isProcsubIn(w: Word): boolean {
  const p = w.parts[0]
  return w.parts.length === 1 && p?.kind === "cmdsub" && p.raw.startsWith("<(") && !!p.sub
}

/** A script operand that is stdin or a `<(...)`: the shell is fed (review M4). */
function fedOperand(w: Word | undefined): Unwrap {
  if (!w) return { k: "none" }
  if (isProcsubIn(w)) return { k: "stdin-shell", from: w }
  if (!w.dynamic && STDIN_PATHS.has(w.text)) return { k: "stdin-shell" }
  return { k: "none" }
}

function classifyInterp(interp: Interpreter, args: Word[]): Unwrap {
  const flags = CODE_FLAGS[interp]
  if (interp === "awk") {
    let i = 0
    while (i < args.length) {
      const t = (args[i] as Word).text
      if (t === "--") {
        i++
        break
      }
      if (t === "-f") return { k: "interp", interpreter: interp }
      if (t.length < 2 || !t.startsWith("-")) break
      i += t === "-v" || t === "-F" ? 2 : 1
    }
    const prog = args[i]
    return prog
      ? { k: "interp", interpreter: interp, text: prog.text }
      : { k: "interp", interpreter: interp }
  }
  for (let i = 0; i < args.length; i++) {
    const t = (args[i] as Word).text
    for (const f of flags) {
      if (t === f) {
        const code = args[i + 1]
        return code
          ? { k: "interp", interpreter: interp, text: code.text }
          : { k: "interp", interpreter: interp }
      }
      if (f.startsWith("--") && t.startsWith(`${f}=`)) {
        return { k: "interp", interpreter: interp, text: t.slice(f.length + 1) }
      }
      if (
        f.length === 2 &&
        f.startsWith("-") &&
        t.startsWith(f) &&
        t.length > 2 &&
        !t.startsWith("--")
      ) {
        return { k: "interp", interpreter: interp, text: t.slice(2) }
      }
    }
  }
  return { k: "interp", interpreter: interp }
}

function classifyFind(args: Word[]): Unwrap {
  const inners: Word[][] = []
  for (let i = 0; i < args.length; i++) {
    const t = (args[i] as Word).text
    if (t !== "-exec" && t !== "-execdir" && t !== "-ok" && t !== "-okdir") continue
    const inner: Word[] = []
    let j = i + 1
    for (; j < args.length; j++) {
      const w = args[j] as Word
      if (w.text === ";" || (w.text === "+" && inner.length > 0)) break
      inner.push(w.text.includes("{}") ? dynamicCopy(w) : w)
    }
    if (inner.length > 0) inners.push(inner)
    i = j
  }
  return { k: "peel", inners, assigns: [], emitSelf: true, origin: "find-exec" }
}

function classifyXargs(args: Word[], parallel: boolean): Unwrap {
  const i = skipOptions(args, XARGS)
  let inner = args.slice(i)
  if (parallel) {
    const stop = inner.findIndex((w) => w.text === ":::" || w.text === "::::")
    if (stop >= 0) inner = inner.slice(0, stop)
  }
  if (inner.length === 0) return { k: "none" }
  return {
    k: "peel",
    inners: [inner],
    assigns: [],
    emitSelf: true,
    origin: "xargs",
    unknownTail: true,
  }
}

function classifyDocker(args: Word[]): Unwrap {
  const sub = args[0]?.text
  if (sub === "compose") return classifyCompose(args, 1)
  if (sub !== "exec" && sub !== "run") return { k: "none" }
  const spec: OptSpec =
    sub === "exec"
      ? { v: "euw", lv: ["env", "env-file", "user", "workdir", "detach-keys"] }
      : {
          v: "evwpuhmlc",
          lv: [
            "env",
            "env-file",
            "volume",
            "workdir",
            "publish",
            "user",
            "hostname",
            "memory",
            "label",
            "name",
            "network",
            "entrypoint",
            "mount",
            "platform",
          ],
        }
  const i = skipOptions(args, spec, 1)
  return peel(args.slice(i + 1), { emitSelf: true, remote: true })
}

/** Find a `-c CMD` / `--command[=]CMD` payload among options (su, script, flock). */
function dashCText(args: readonly Word[], spec: OptSpec): Word | string | undefined {
  for (let i = 0; i < args.length; i++) {
    const t = (args[i] as Word).text
    if (t === "--") return undefined
    if (t === "--command") return args[i + 1]
    if (t.startsWith("--command=")) return t.slice(10)
    if (t.length < 2 || t.charCodeAt(0) !== 45 || t.charCodeAt(1) === 45) continue
    for (let j = 1; j < t.length; j++) {
      const ch = t.charAt(j)
      if (ch === "c") return j + 1 < t.length ? t.slice(j + 1) : args[i + 1]
      if (spec.v.includes(ch)) break
    }
  }
  return undefined
}

function payloadOf(p: Word | string | undefined, origin: "dash-c" = "dash-c"): Unwrap {
  if (p === undefined) return { k: "none" }
  if (typeof p === "string") return { k: "payload", text: p, dynamic: false, origin }
  return { k: "payload", text: p.text, dynamic: p.dynamic, origin }
}

/** `flock [opts] FILE CMD...` or `flock [opts] FILE -c CMD`. */
function classifyFlock(args: Word[]): Unwrap {
  const c = dashCText(args, FLOCK)
  if (c !== undefined) return payloadOf(c)
  return peel(args.slice(skipOptions(args, FLOCK) + 1))
}

/** `script -c CMD`, or the BSD form `script [opts] FILE CMD...`. */
function classifyScript(args: Word[]): Unwrap {
  const c = dashCText(args, SCRIPT)
  if (c !== undefined) return payloadOf(c)
  return peel(args.slice(skipOptions(args, SCRIPT) + 1))
}

/** `taskset MASK CMD`, `taskset -c LIST CMD`. `-p` works on a pid. */
function classifyTaskset(args: Word[]): Unwrap {
  let i = 0
  while (i < args.length) {
    const t = (args[i] as Word).text
    if (t === "--") {
      i++
      break
    }
    if (t.length < 2 || t.charCodeAt(0) !== 45) break
    if (t === "-p" || t === "--pid" || (t.charCodeAt(1) !== 45 && t.includes("p"))) {
      return { k: "none" }
    }
    i++
  }
  return peel(args.slice(i + 1))
}

/** macOS `arch [-arch NAME | -x86_64 | -arm64 ...] [-e K=V] [-c] [-d K] CMD`. */
function classifyArch(args: Word[]): Unwrap {
  let i = 0
  while (i < args.length) {
    const t = (args[i] as Word).text
    if (t === "--") {
      i++
      break
    }
    if (t.length < 2 || t.charCodeAt(0) !== 45) break
    i += t === "-arch" || t === "-e" || t === "-d" ? 2 : 1
  }
  return peel(args.slice(i))
}

/** `docker compose [opts] exec|run [opts] SERVICE CMD...` (review M1). */
function classifyCompose(args: Word[], from: number): Unwrap {
  const top: OptSpec = {
    v: "fp",
    lv: ["file", "project-name", "profile", "env-file", "project-directory", "ansi", "parallel"],
  }
  const i = skipOptions(args, top, from)
  const sub = args[i]?.text
  if (sub !== "exec" && sub !== "run") return { k: "none" }
  const spec: OptSpec = {
    v: "euwlp",
    lv: ["env", "user", "workdir", "index", "label", "name", "entrypoint", "volume", "publish"],
  }
  const j = skipOptions(args, spec, i + 1)
  return peel(args.slice(j + 1), { emitSelf: true, remote: true })
}

function classifyKubectl(args: Word[]): Unwrap {
  if (args[0]?.text !== "exec") return { k: "none" }
  const dd = args.findIndex((w) => w.text === "--")
  return dd < 0 ? { k: "none" } : peel(args.slice(dd + 1), { emitSelf: true, remote: true })
}

/** Classify one command by its executable basename. */
export function classify(name: string, args: Word[]): Unwrap {
  const simple = SIMPLE_WRAPPERS[name]
  if (simple) return peel(args.slice(skipOptions(args, simple)))
  const positional = POSITIONAL_WRAPPERS[name]
  if (positional) return peel(args.slice(skipOptions(args, positional.spec) + positional.skip))
  const interp = INTERP[name]
  if (interp) return classifyInterp(interp, args)
  if (SHELLS.has(name)) return classifyShell(args)
  switch (name) {
    case "env":
      return classifyEnv(args)
    case "sudo":
      return peel(args.slice(skipOptions(args, SUDO)), { emitSelf: true })
    case "doas":
      return peel(args.slice(skipOptions(args, DOAS)), { emitSelf: true })
    case "command": {
      const i = skipOptions(args, { v: "" })
      for (let k = 0; k < i; k++) {
        const t = (args[k] as Word).text
        if (t !== "--" && (t.includes("v") || t.includes("V"))) return { k: "none" }
      }
      return peel(args.slice(i))
    }
    case "timeout":
      return peel(args.slice(skipOptions(args, TIMEOUT) + 1))
    case "watch": {
      const rest = args.slice(skipOptions(args, WATCH))
      if (rest.length === 1) {
        const w = rest[0] as Word
        return { k: "payload", text: w.text, dynamic: w.dynamic, origin: "dash-c" }
      }
      return peel(rest)
    }
    case "xargs":
      return classifyXargs(args, false)
    case "parallel":
      return classifyXargs(args, true)
    case "find":
      return classifyFind(args)
    case "eval": {
      if (args.length === 0) return { k: "none" }
      const j = joinText(args)
      return { k: "payload", text: j.text, dynamic: j.dynamic, origin: "eval" }
    }
    case "source":
    case ".":
      return fedOperand(args[0]?.text === "--" ? args[1] : args[0])
    case "ssh": {
      const i = skipOptions(args, SSH)
      const rest = args.slice(i + 1)
      if (rest.length === 0) return { k: "none" }
      const j = joinText(rest)
      return { k: "payload", text: j.text, dynamic: j.dynamic, origin: "dash-c", remote: true }
    }
    case "docker":
    case "podman":
      return classifyDocker(args)
    case "kubectl":
      return classifyKubectl(args)
    case "docker-compose":
    case "podman-compose":
      return classifyCompose(args, 0)
    case "flock":
      return classifyFlock(args)
    case "su":
      return payloadOf(dashCText(args, SU))
    case "script":
      return classifyScript(args)
    case "taskset":
      return classifyTaskset(args)
    case "arch":
      return classifyArch(args)
    default:
      return { k: "none" }
  }
}

/** Commands that only show text (design H s8). Rules do not match their argument text. */
export const DISPLAY_CMDS: ReadonlySet<string> = new Set([
  "echo",
  "printf",
  "cat",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "sed",
  "awk",
  "head",
  "tail",
  "less",
  "more",
  "wc",
  "sort",
  "uniq",
  "tr",
  "cut",
  "file",
  "stat",
  "ls",
  "man",
  "which",
  "type",
  "whereis",
  "test",
  "[",
])

/** Commands whose output feeds a shell as script text. */
export const TEXT_PRODUCERS: ReadonlySet<string> = new Set(["echo", "printf", "cat"])

/** Commands that fetch remote data (pipe-to-shell rule). */
export const FETCHERS: ReadonlySet<string> = new Set([
  "curl",
  "wget",
  "fetch",
  "nc",
  "ncat",
  "socat",
  "base64",
  "openssl",
])
