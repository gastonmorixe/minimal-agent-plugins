/**
 * Flag normalization (design H, section 6).
 * Bundled short flags split, long flags map to short through spec aliases,
 * flags after operands are accepted, `--` ends options.
 */

import type { Word } from "./ast.ts"
import { startsDynamic } from "./words.ts"

/** Per-tool option facts. */
export interface FlagSpec {
  /** Short option letters that take a value (glued rest of cluster, or next arg). */
  shortWithValue?: string
  /** Long option names (without `--`) that take the next arg when no `=` is given. */
  longWithValue?: readonly string[]
  /** Alias to canonical name, for example `R: "r"`, `recursive: "r"`. */
  aliases?: Readonly<Record<string, string>>
  /** Every `-word` is one long-style flag (find). */
  singleDashAll?: boolean
  /**
   * Known long options. With aliases and `longWithValue` they drive GNU
   * abbreviation: an unambiguous prefix maps to the full name (review M2).
   */
  longs?: readonly string[]
}

/** Full long option for `body` (GNU abbreviation), or undefined when unknown or ambiguous. */
function expandLong(body: string, spec: FlagSpec | undefined): string | undefined {
  if (!spec || body.length === 0) return undefined
  const names = new Set<string>(spec.longs ?? [])
  for (const n of spec.longWithValue ?? []) names.add(n)
  for (const n of Object.keys(spec.aliases ?? {})) if (n.length > 1) names.add(n)
  if (names.has(body)) return body
  let hit: string | undefined
  for (const n of names) {
    if (!n.startsWith(body)) continue
    if (hit !== undefined) return undefined
    hit = n
  }
  return hit
}

export interface Flag {
  /** Name as written, without dashes. */
  name: string
  /** Canonical name after alias mapping. */
  canon: string
  value?: string
  long: boolean
  word: Word
}

/** Normalized flags of one command, alias aware. */
export class FlagSet {
  readonly list: Flag[] = []
  /** Flag names as written (for case-sensitive checks such as `-R`). */
  readonly raw: string[] = []
  endOfOptions = false
  /** A fully dynamic arg was seen. It could expand to a flag. */
  unknownFlags = false
  private readonly aliases: Readonly<Record<string, string>>

  constructor(spec?: FlagSpec) {
    this.aliases = spec?.aliases ?? {}
  }

  canon(name: string): string {
    return this.aliases[name] ?? name
  }

  /** Add a flag. `full` is the expanded long name of an abbreviation. */
  add(name: string, long: boolean, word: Word, value?: string, full?: string): void {
    const f: Flag = { name, canon: this.canon(full ?? name), long, word }
    if (value !== undefined) f.value = value
    this.list.push(f)
    this.raw.push(name)
  }

  /** True when any of `names` (alias aware) is present. */
  has(...names: string[]): boolean {
    for (const n of names) {
      const c = this.canon(n)
      for (const f of this.list) if (f.canon === c || f.name === n) return true
    }
    return false
  }

  /** Value of the first flag that matches `name` (alias aware). */
  value(name: string): string | undefined {
    const c = this.canon(name)
    for (const f of this.list) if (f.canon === c || f.name === name) return f.value
    return undefined
  }
}

/** Split `args` into flags and operands. */
export function normalizeFlags(
  args: readonly Word[],
  spec?: FlagSpec,
): { flags: FlagSet; operands: Word[] } {
  const flags = new FlagSet(spec)
  const operands: Word[] = []
  const shortVal = spec?.shortWithValue ?? ""
  const longVal = spec?.longWithValue ?? []
  for (let i = 0; i < args.length; i++) {
    const w = args[i] as Word
    const t = w.text
    if (flags.endOfOptions) {
      operands.push(w)
      continue
    }
    if (w.dynamic && startsDynamic(w)) {
      flags.unknownFlags = true
      operands.push(w)
      continue
    }
    if (t === "--") {
      flags.endOfOptions = true
      continue
    }
    if (t.length < 2 || t.charCodeAt(0) !== 45) {
      operands.push(w)
      continue
    }
    if (t.charCodeAt(1) === 45 || spec?.singleDashAll) {
      const body = t.slice(t.charCodeAt(1) === 45 ? 2 : 1)
      const eq = body.indexOf("=")
      const key = eq >= 0 ? body.slice(0, eq) : body
      const full = spec?.singleDashAll ? undefined : expandLong(key, spec)
      if (eq >= 0) {
        flags.add(key, true, w, body.slice(eq + 1), full)
      } else if (longVal.includes(full ?? body) && i + 1 < args.length) {
        flags.add(body, true, w, (args[i + 1] as Word).text, full)
        i++
      } else {
        flags.add(body, true, w, undefined, full)
      }
      continue
    }
    for (let j = 1; j < t.length; j++) {
      const ch = t.charAt(j)
      if (shortVal.includes(ch)) {
        if (j + 1 < t.length) {
          flags.add(ch, false, w, t.slice(j + 1))
        } else if (i + 1 < args.length) {
          flags.add(ch, false, w, (args[i + 1] as Word).text)
          i++
        } else {
          flags.add(ch, false, w)
        }
        break
      }
      flags.add(ch, false, w)
    }
  }
  return { flags, operands }
}

const FIND_VALUE = [
  "name",
  "iname",
  "path",
  "ipath",
  "wholename",
  "iwholename",
  "regex",
  "iregex",
  "lname",
  "ilname",
  "type",
  "xtype",
  "maxdepth",
  "mindepth",
  "user",
  "group",
  "uid",
  "gid",
  "perm",
  "size",
  "mtime",
  "atime",
  "ctime",
  "mmin",
  "amin",
  "cmin",
  "newer",
  "samefile",
  "inum",
  "links",
  "fstype",
  "printf",
  "fprint",
  "fprintf",
  "fls",
  "used",
  "context",
]

const RECURSIVE_FORCE = { R: "r", recursive: "r", force: "f" } as const

/** Flag specs per executable basename. */
export const FLAG_SPECS: Readonly<Record<string, FlagSpec>> = {
  rm: {
    aliases: { ...RECURSIVE_FORCE, dir: "d", interactive: "i", verbose: "v" },
    longs: ["no-preserve-root", "preserve-root", "one-file-system", "help", "version"],
  },
  cp: {
    aliases: { ...RECURSIVE_FORCE, a: "a", archive: "a" },
    shortWithValue: "tS",
    longs: [
      "remove-destination",
      "reflink",
      "recursive",
      "target-directory",
      "no-target-directory",
      "no-clobber",
      "no-dereference",
      "dereference",
      "preserve",
      "no-preserve",
      "parents",
      "symbolic-link",
      "link",
      "update",
      "verbose",
      "one-file-system",
      "strip-trailing-slashes",
      "suffix",
      "sparse",
      "interactive",
      "backup",
      "attributes-only",
      "copy-contents",
      "context",
      "debug",
      "keep-directory-symlink",
      "help",
      "version",
    ],
  },
  mv: {
    aliases: { force: "f" },
    shortWithValue: "tS",
    longs: [
      "backup",
      "debug",
      "exchange",
      "interactive",
      "no-clobber",
      "no-copy",
      "no-target-directory",
      "strip-trailing-slashes",
      "suffix",
      "target-directory",
      "update",
      "verbose",
      "context",
      "help",
      "version",
    ],
  },
  chmod: {
    aliases: { recursive: "R" },
    longs: [
      "changes",
      "silent",
      "quiet",
      "verbose",
      "no-preserve-root",
      "preserve-root",
      "reference",
    ],
  },
  chown: {
    aliases: { recursive: "R" },
    longs: [
      "changes",
      "silent",
      "quiet",
      "verbose",
      "no-preserve-root",
      "preserve-root",
      "reference",
      "dereference",
      "no-dereference",
      "from",
    ],
  },
  chgrp: {
    aliases: { recursive: "R" },
    longs: [
      "changes",
      "silent",
      "quiet",
      "verbose",
      "no-preserve-root",
      "preserve-root",
      "reference",
      "dereference",
      "no-dereference",
    ],
  },
  find: { singleDashAll: true, longWithValue: FIND_VALUE },
  sed: { shortWithValue: "ef", aliases: { "in-place": "i", expression: "e" } },
  curl: { shortWithValue: "oHXduFTxAeEKrbcmwyYz", longWithValue: ["output", "data", "header"] },
  wget: { shortWithValue: "OoPUae", longWithValue: ["output-document"] },
  tar: { shortWithValue: "fCT", longWithValue: ["file", "directory"] },
  ln: { aliases: { force: "f", symbolic: "s" }, shortWithValue: "tS" },
  kill: { shortWithValue: "sn" },
  dd: {},
}

/** Flag specs for git subcommands. */
export const GIT_SPECS: Readonly<Record<string, FlagSpec>> = {
  push: {
    shortWithValue: "o",
    longWithValue: ["repo", "push-option", "receive-pack", "exec"],
    aliases: { force: "f", "set-upstream": "u", delete: "d", mirror: "mirror" },
  },
  commit: {
    shortWithValue: "mFCct",
    longWithValue: [
      "message",
      "file",
      "author",
      "date",
      "reuse-message",
      "reedit-message",
      "template",
      "fixup",
      "squash",
      "cleanup",
    ],
    aliases: { message: "m", file: "F", all: "a", amend: "amend" },
  },
  reset: {},
  clean: { shortWithValue: "e", aliases: { force: "f" } },
  checkout: { shortWithValue: "bB", aliases: { force: "f" } },
  branch: { aliases: { delete: "d", force: "f" } },
  stash: { shortWithValue: "m", aliases: { message: "m" } },
  tag: { shortWithValue: "mFu", aliases: { delete: "d", force: "f" } },
  rebase: { shortWithValue: "Xsx", longWithValue: ["onto", "exec", "strategy"] },
}
