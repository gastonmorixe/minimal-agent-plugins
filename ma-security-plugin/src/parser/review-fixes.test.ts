import { describe, expect, test } from "bun:test"

import type { ParseResult, Script, Word } from "./ast.ts"
import { parseCommand, walkCommands } from "./index.ts"
import type { ExecView } from "./walk.ts"

/** Fixes for the B2 review (B1-B4 blockers, M1-M8 majors, minors). */

interface Run {
  r: ParseResult
  views: ExecView[]
  names: string[]
  v: (name: string) => ExecView
  has: (name: string) => boolean
}

function run(src: string): Run {
  const r = parseCommand(src)
  const tree: Script = r.ok ? r.tree : r.partial
  const views: ExecView[] = []
  walkCommands(tree, {
    command(view) {
      views.push(view)
      return undefined
    },
  })
  const names = views.map((x) => x.name)
  const v = (name: string): ExecView => {
    const hit = views.find((x) => x.name === name)
    if (!hit) throw new Error(`no view ${name} in [${names.join(",")}]`)
    return hit
  }
  return { r, views, names, v, has: (n) => names.includes(n) }
}

function op0(view: ExecView): Word {
  const w = view.operands[0]
  if (!w) throw new Error("no operand 0")
  return w
}

type Row = [input: string, check: (x: Run) => void]

/** The rm operand must be unknown (bash would not use /tmp). */
const RM_OP_DYNAMIC = (x: Run): void => {
  const w = op0(x.v("rm"))
  expect(w.dynamic).toBe(true)
}

/** rm view with flags r and f and operand `/`. */
const RM_RF_ROOT = (x: Run): void => {
  const rm = x.v("rm")
  expect(rm.flags.has("r")).toBe(true)
  expect(rm.flags.has("f")).toBe(true)
  expect(rm.operands.map((w) => w.text)).toContain("/")
}

const RM_RF = (x: Run): void => {
  const rm = x.v("rm")
  expect(rm.flags.has("r")).toBe(true)
  expect(rm.flags.has("f")).toBe(true)
}

function table(title: string, rows: Row[]): void {
  describe(title, () => {
    for (const [input, check] of rows) {
      test(JSON.stringify(input), () => check(run(input)))
    }
  })
}

table("B1 non-plain writes make the var unknown", [
  ["X=/tmp; for X in /; do rm -rf $X; done", RM_OP_DYNAMIC],
  ["X=/tmp; read X; rm -rf $X", RM_OP_DYNAMIC],
  ["X=/tmp; read -r -p q X; rm -rf $X", RM_OP_DYNAMIC],
  ["X=/tmp; while read X; do rm -rf $X; done", RM_OP_DYNAMIC],
  ["X=/tmp; printf -v X /; rm -rf $X", RM_OP_DYNAMIC],
  ["X=/tmp; printf -vX /; rm -rf $X", RM_OP_DYNAMIC],
  ["X=/tmp; : ${X:=/}; rm -rf $X", RM_OP_DYNAMIC],
  ["X=/tmp; : ${X=/}; rm -rf $X", RM_OP_DYNAMIC],
  ["X=/tmp; : ${X[0]:=/}; rm -rf $X", RM_OP_DYNAMIC],
  ["X=/tmp; mapfile -C cb Y < f; rm -rf $X", RM_OP_DYNAMIC],
  ["X=/tmp; eval X=/; rm -rf $X", RM_OP_DYNAMIC],
  ["X=/tmp; mapfile X < f; rm -rf $X", RM_OP_DYNAMIC],
  ["X=/tmp; readarray X < f; rm -rf $X", RM_OP_DYNAMIC],
  ["X=/tmp; getopts ab X; rm -rf $X", RM_OP_DYNAMIC],
  ["X=/tmp; let X=1; rm -rf $X", RM_OP_DYNAMIC],
  ["X=/tmp; (( X=1 )); rm -rf $X", RM_OP_DYNAMIC],
  ["X=/tmp; : $((X=1)); rm -rf $X", RM_OP_DYNAMIC],
  ["X=/tmp; declare -n R=X; R=/; rm -rf $X", RM_OP_DYNAMIC],
  ["X=/tmp; source ./f; rm -rf $X", RM_OP_DYNAMIC],
  ["X=/tmp; . ./f; rm -rf $X", RM_OP_DYNAMIC],
  ["X=/tmp; f(){ :; }; f; rm -rf $X", RM_OP_DYNAMIC],
  ["X=/tmp; export X=$(pwd); rm -rf $X", RM_OP_DYNAMIC],
  ["X=/tmp; declare X=$Y; rm -rf $X", RM_OP_DYNAMIC],
  ["X=/tmp; while :; do rm -rf $X; X=/; done", RM_OP_DYNAMIC],
  ["X=/tmp; for i in a; do X=/; done; rm -rf $X", RM_OP_DYNAMIC],
  ["X=/tmp; if c; then X=/; fi; rm -rf $X", RM_OP_DYNAMIC],
  ["X=/tmp; case a in a) X=/;; esac; rm -rf $X", RM_OP_DYNAMIC],
  ["X=/tmp; c && X=/; rm -rf $X", RM_OP_DYNAMIC],
  ["X=/tmp; c || X=/; rm -rf $X", RM_OP_DYNAMIC],
  ["X=/tmp; (X=/); rm -rf $X", RM_OP_DYNAMIC],
  ["X=/tmp; X=/ | :; rm -rf $X", RM_OP_DYNAMIC],
  ["X=/tmp; X=/ & rm -rf $X", RM_OP_DYNAMIC],
  ["X=/tmp; trap 'X=/' DEBUG; rm -rf $X", RM_OP_DYNAMIC],
  ["X=/tmp; unset X; rm -rf $X", RM_OP_DYNAMIC],
  ["X=/tmp; X=/ :; rm -rf $X", RM_OP_DYNAMIC],
  ["X=/tmp; builtin read X; rm -rf $X", RM_OP_DYNAMIC],
  ["X=/tmp; declare -u X; X=/tmp; rm -rf $X", RM_OP_DYNAMIC],
  ["IFS=/; X=a/b; rm -rf $X", RM_OP_DYNAMIC],
  ["a=(/ /tmp); rm -rf $a", RM_OP_DYNAMIC],
  ["X=/tmp; X[0]=/; rm -rf $X", RM_OP_DYNAMIC],
  [
    "X=rm; X=ls | $X -rf /",
    (x) => {
      expect(x.has("ls")).toBe(false)
    },
  ],
  // Precision kept where bash is sure.
  ["X=/; if c; then :; fi; rm -rf $X", (x) => expect(op0(x.v("rm")).text).toBe("/")],
  ["X=/; for i in a; do :; done; rm -rf $X", (x) => expect(op0(x.v("rm")).text).toBe("/")],
])

table("B2 function bodies do not feed the outer env", [
  ["X=/; f(){ X=/tmp; }; rm -rf $X", RM_OP_DYNAMIC],
  ["X=/; function f { X=/tmp; }; rm -rf $X", RM_OP_DYNAMIC],
  ["X=/tmp; f(){ rm -rf $X; }", RM_OP_DYNAMIC],
  ["f(){ X=/; rm -rf $X; }", (x) => expect(op0(x.v("rm")).text).toBe("/")],
])

table("B3 word splitting of resolved unquoted vars", [
  [
    'X="rm -rf /"; $X',
    (x) => {
      const hit = x.views.find((v) => v.name === "rm" || v.nameDynamic)
      expect(hit).toBeDefined()
      if (hit && !hit.nameDynamic) RM_RF_ROOT(x)
    },
  ],
  ['X="rm -rf"; $X /', RM_RF_ROOT],
  [
    'X="/ /tmp"; rm -rf $X',
    (x) => {
      const rm = x.v("rm")
      const texts = rm.operands.map((w) => w.text)
      const split = texts.length === 2 && texts[0] === "/" && texts[1] === "/tmp"
      expect(split || rm.operands.some((w) => w.dynamic)).toBe(true)
    },
  ],
  [
    'X="/*"; rm -rf $X',
    (x) => {
      const w = op0(x.v("rm"))
      expect(w.dynamic).toBe(true)
      expect(w.root).toBe("root")
    },
  ],
  ["X=; $X rm -rf /", RM_RF_ROOT],
  [
    'X="/ /tmp"; rm -rf "$X"',
    (x) => {
      const w = op0(x.v("rm"))
      expect(w.text).toBe("/ /tmp")
      expect(w.dynamic).toBe(false)
    },
  ],
])

table("B4 time and coproc prefixes", [
  ["time { rm -rf /; }", RM_RF_ROOT],
  ["time -p rm -rf /", RM_RF_ROOT],
  ["time (rm -rf /)", RM_RF_ROOT],
  ["coproc { rm -rf /; }", RM_RF_ROOT],
  ["coproc rm -rf /", RM_RF_ROOT],
  ["coproc X { rm -rf /; }", RM_RF_ROOT],
  ["coproc X (rm -rf /)", RM_RF_ROOT],
  ["! time rm -rf /", RM_RF_ROOT],
])

table("M1 more wrappers", [
  ["busybox rm -rf /", RM_RF_ROOT],
  ["setsid rm -rf /", RM_RF_ROOT],
  ["setsid -f rm -rf /", RM_RF_ROOT],
  ["ionice -c3 rm -rf /", RM_RF_ROOT],
  ["ionice -c 3 -n 7 rm -rf /", RM_RF_ROOT],
  ["chroot / rm -rf /", RM_RF_ROOT],
  ["chroot --userspec=a:b / rm -rf /", RM_RF_ROOT],
  ["flock /x rm -rf /", RM_RF_ROOT],
  ["flock -w 5 /x rm -rf /", RM_RF_ROOT],
  ['flock /x -c "rm -rf /"', RM_RF_ROOT],
  ["unshare -r rm -rf /", RM_RF_ROOT],
  ["nsenter -t 1 -m rm -rf /", RM_RF_ROOT],
  ["firejail --noprofile rm -rf /", RM_RF_ROOT],
  ["chrt -f 10 rm -rf /", RM_RF_ROOT],
  ["taskset 0x1 rm -rf /", RM_RF_ROOT],
  ["taskset -c 0 rm -rf /", RM_RF_ROOT],
  ["caffeinate -i rm -rf /", RM_RF_ROOT],
  ["caffeinate -t 5 rm -rf /", RM_RF_ROOT],
  ["arch -arm64 rm -rf /", RM_RF_ROOT],
  ["arch -arch x86_64 rm -rf /", RM_RF_ROOT],
  ["docker compose exec c rm -rf /", RM_RF_ROOT],
  ["docker compose -f a.yml exec -T c rm -rf /", RM_RF_ROOT],
  ["podman compose exec c rm -rf /", RM_RF_ROOT],
  ["docker-compose exec c rm -rf /", RM_RF_ROOT],
  ['su -c "rm -rf /"', RM_RF_ROOT],
  ['su root -c "rm -rf /"', RM_RF_ROOT],
  ['su -lc "rm -rf /"', RM_RF_ROOT],
  ['script -c "rm -rf /"', RM_RF_ROOT],
  ['script -qc "rm -rf /" /dev/null', RM_RF_ROOT],
  ["script -q /dev/null rm -rf /", RM_RF_ROOT],
])

table("M2 GNU long-option abbreviation", [
  ["rm --recur --forc /", RM_RF],
  ["rm --rec -f /", RM_RF],
  ["rm --no-p -rf /", (x) => expect(x.v("rm").flags.has("no-preserve-root")).toBe(true)],
  ["cp --re a b", (x) => expect(x.v("cp").flags.has("r")).toBe(false)],
])

table("M3 nameLower", [
  ["RM -rf /", (x) => expect(x.views[0]?.nameLower).toBe("rm")],
  ["/BIN/RM -rf /", (x) => expect(x.views[0]?.nameLower).toBe("rm")],
  ["RM -rf /", (x) => expect(x.views[0]?.name).toBe("RM")],
  ["RM --recur -f /", (x) => expect(x.views[0]?.flags.has("r")).toBe(true)],
  ["SUDO rm -rf /", RM_RF_ROOT],
])

table("M4/M5 procsub producer is the feed", [
  ["source <(curl -s x)", (x) => expect(x.v("source").viaPipeFrom?.name).toBe("curl")],
  ["sh < <(curl -s x)", (x) => expect(x.v("sh").viaPipeFrom?.name).toBe("curl")],
])

table("M4 shell fed through a file-like operand", [
  ['bash /dev/stdin <<< "rm -rf /"', RM_RF_ROOT],
  ['bash /dev/fd/0 <<< "rm -rf /"', RM_RF_ROOT],
  ['bash - <<< "rm -rf /"', RM_RF_ROOT],
  ["bash <(echo rm -rf /)", RM_RF_ROOT],
  ["source <(echo rm -rf /)", RM_RF_ROOT],
  [". <(echo rm -rf /)", RM_RF_ROOT],
  ["sh /dev/stdin < <(echo rm -rf /)", RM_RF_ROOT],
])

table("M5 redirect from a process substitution", [
  [
    "sh < <(echo rm -rf /)",
    (x) => {
      expect(x.r.ok).toBe(true)
      RM_RF_ROOT(x)
    },
  ],
  [
    "while read l; do :; done < <(ls)",
    (x) => {
      expect(x.r.ok).toBe(true)
      expect(x.v("ls").origin).toBe("procsub")
    },
  ],
])

table("M6 array words after declaration builtins", [
  [
    "declare -a a=($(rm -rf /))",
    (x) => {
      expect(x.r.ok).toBe(true)
      expect(x.v("rm").origin).toBe("cmdsub")
    },
  ],
  ["local x=(a b)", (x) => expect(x.r.ok).toBe(true)],
  ["export a=(1)", (x) => expect(x.r.ok).toBe(true)],
  ["readonly r=(1 2)", (x) => expect(x.r.ok).toBe(true)],
  ["typeset t=(1) u=2", (x) => expect(x.r.ok).toBe(true)],
])

describe("M7 raw scan of too-big input", () => {
  test("payload in the middle of 200 KB is seen", () => {
    const src = `${"x ".repeat(50000)}; rm -rf /; ${"x ".repeat(50000)}`
    const r = parseCommand(src)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe("too-big")
      expect(r.rawScan.tokens).toContain("rm")
      expect(r.rawScan.fullScan).toBe(true)
    }
  })
  test("over 4 MB scans 2 MB head and 2 MB tail", () => {
    const mb = 1024 * 1024
    const src = `head-mark ${"x ".repeat(2.5 * mb)} tail-mark`
    const r = parseCommand(src)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.rawScan.truncated).toBe(true)
      expect(r.rawScan.fullScan).toBe(false)
      expect(r.rawScan.tokens).toContain("head-mark")
      expect(r.rawScan.tokens).toContain("tail-mark")
    }
  })
})

table("M8 NUL bytes are stripped", [
  ["r\0m -rf /", RM_RF_ROOT],
  ["rm -r\0f /", RM_RF_ROOT],
])

table("minor: dynamic name uses the raw word", [
  ["$(rm -rf /)", (x) => expect(x.names).not.toContain(")")],
  ["{rm,-rf,/}", (x) => expect(x.names).not.toContain("}")],
  ["$HOME/bin/rm -rf /", (x) => expect(x.views[0]?.name).toBe("rm")],
])

table("minor: arith command", [
  [
    "(( x = 1 ))",
    (x) => {
      expect(x.r.ok).toBe(true)
      expect(x.r.ok && x.r.tree.items[0]?.node.type).toBe("arith")
      expect(x.has("x")).toBe(false)
    },
  ],
  [
    "$((1+2))",
    (x) => {
      expect(x.r.ok && x.r.tree.items[0]?.node.type).toBe("arith")
      expect(x.names.length).toBe(0)
    },
  ],
  ["(( $(rm -rf /) ))", (x) => expect(x.v("rm").origin).toBe("cmdsub")],
  [
    "((cd x); ls)",
    (x) => {
      expect(x.has("cd")).toBe(true)
      expect(x.has("ls")).toBe(true)
    },
  ],
])
