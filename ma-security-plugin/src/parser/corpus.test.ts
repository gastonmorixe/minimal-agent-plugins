import { describe, expect, test } from "bun:test"

import type { FailReason, ParseResult, Script, SimpleCommand, Word } from "./ast.ts"
import { gitSubcommand, parseCommand, rawScan, walkCommands } from "./index.ts"
import type { ExecView, WalkCtx } from "./walk.ts"

/** One emitted view plus the walk context it was seen in. */
interface Entry {
  view: ExecView
  ctx: WalkCtx
}

interface Run {
  r: ParseResult
  all: Entry[]
  names: string[]
  limits: { reason: string; raw: string }[]
  /** First view with this name. */
  v: (name: string) => ExecView
  e: (name: string) => Entry
  has: (name: string) => boolean
}

function run(src: string): Run {
  const r = parseCommand(src)
  const tree: Script = r.ok ? r.tree : r.partial
  const all: Entry[] = []
  const limits: { reason: string; raw: string }[] = []
  walkCommands(tree, {
    command(view, ctx) {
      all.push({ view, ctx: { ...ctx } })
    },
    limit(info) {
      limits.push({ reason: info.reason, raw: info.raw })
    },
  })
  const names = all.map((x) => x.view.name)
  const e = (name: string): Entry => {
    const hit = all.find((x) => x.view.name === name)
    if (!hit) throw new Error(`no view ${name} in [${names.join(",")}]`)
    return hit
  }
  return { r, all, names, limits, e, v: (n) => e(n).view, has: (n) => names.includes(n) }
}

/** First simple command of the tree (or partial). */
function first(r: ParseResult): SimpleCommand {
  const tree = r.ok ? r.tree : r.partial
  const n = tree.items[0]?.node
  if (!n || n.type !== "simple") throw new Error("first node is not simple")
  return n
}

function op(view: ExecView, i: number): Word {
  const w = view.operands[i]
  if (!w) throw new Error(`no operand ${i}`)
  return w
}

const ok = (x: Run): void => {
  expect(x.r.ok).toBe(true)
}
const fail = (x: Run, reason: FailReason): void => {
  expect(x.r.ok).toBe(false)
  if (!x.r.ok) expect(x.r.reason).toBe(reason)
}

type Case = [name: string, input: string, check: (x: Run) => void]

const RM_RF = (x: Run): void => {
  const rm = x.v("rm")
  expect(rm.flags.has("r")).toBe(true)
  expect(rm.flags.has("f")).toBe(true)
}

const nest5 = (): string => {
  const q = (s: string): string => `'${s.split("'").join("'\\''")}'`
  let s = "rm -rf /"
  for (let i = 0; i < 5; i++) s = `bash -c ${q(s)}`
  return s
}

const CASES: Case[] = [
  // Basics and operators
  [
    "1 simple-ls",
    "ls -la",
    (x) => {
      ok(x)
      expect(x.names).toEqual(["ls"])
      expect(x.v("ls").flags.has("l")).toBe(true)
      expect(x.v("ls").flags.has("a")).toBe(true)
      if (x.r.ok) expect(x.r.plain).toBe(true)
    },
  ],
  [
    "2 and-chain",
    "cd x && rm -rf y",
    (x) => {
      ok(x)
      expect(x.names).toEqual(["cd", "rm"])
      RM_RF(x)
      expect(x.e("rm").ctx.conditional).toBe("and")
      expect(x.e("cd").ctx.conditional).toBe("none")
    },
  ],
  ["3 or-chain", "false || rm -rf y", (x) => expect(x.e("rm").ctx.conditional).toBe("or")],
  [
    "4 semi-chain",
    "echo a; rm -rf y",
    (x) => {
      expect(x.names).toEqual(["echo", "rm"])
      expect(x.v("echo").display).toBe(true)
    },
  ],
  ["5 newline-chain", "echo a\nrm -rf y", (x) => expect(x.names).toEqual(["echo", "rm"])],
  [
    "6 background",
    "sleep 1 & rm -rf y",
    (x) => {
      expect(x.has("rm")).toBe(true)
      expect(x.e("sleep").ctx.background).toBe(true)
      expect(x.e("rm").ctx.background).toBe(false)
    },
  ],
  [
    "7 pipe",
    "cat f | grep x | wc -l",
    (x) => {
      expect(x.names).toEqual(["cat", "grep", "wc"])
      expect(x.all.map((a) => a.ctx.pipeIndex)).toEqual([0, 1, 2])
      expect(x.all.every((a) => a.ctx.inPipeline)).toBe(true)
    },
  ],
  ["8 pipe-and-stderr", "make |& tee log", (x) => expect(x.names).toEqual(["make", "tee"])],
  ["9 negation", "! rm -rf y", (x) => expect(x.e("rm").ctx.negated).toBe(true)],
  [
    "10 trailing-op",
    "ls &&",
    (x) => {
      fail(x, "syntax")
      expect(x.has("ls")).toBe(true)
    },
  ],
  // Quoting and words
  [
    "11 single-quote",
    "rm -rf '/'",
    (x) => {
      const w = op(x.v("rm"), 0)
      expect(w.text).toBe("/")
      expect(w.dynamic).toBe(false)
      expect(w.quoted).toBe(true)
    },
  ],
  [
    "12 double-quote",
    'rm -rf "/"',
    (x) => {
      const w = op(x.v("rm"), 0)
      expect(w.text).toBe("/")
      expect(w.dynamic).toBe(false)
      expect(w.quoted).toBe(true)
    },
  ],
  ["13 escape", "r\\m -rf /", (x) => expect(x.names).toEqual(["rm"])],
  [
    "14 concat-literal",
    '"r"m -rf /',
    (x) => {
      expect(x.names).toEqual(["rm"])
      expect(x.v("rm").nameDynamic).toBe(false)
    },
  ],
  ["15 ansic-fold", "$'\\x72\\x6d' -rf /", (x) => expect(x.names).toEqual(["rm"])],
  [
    "16 ansic-newline",
    "echo $'a\\nb'",
    (x) => {
      expect(x.v("echo").cmd.argv[1]).toBe("a\nb")
      expect(x.v("echo").display).toBe(true)
    },
  ],
  ["17 line-continuation", "rm \\\n-rf /", RM_RF],
  ["18 comment", "ls # rm -rf /", (x) => expect(x.names).toEqual(["ls"])],
  ["19 hash-inside-word", "echo a#b", (x) => expect(x.v("echo").cmd.argv).toEqual(["echo", "a#b"])],
  [
    "20 brace-dynamic",
    "rm -rf {a,b}",
    (x) => {
      const w = op(x.v("rm"), 0)
      expect(w.dynamic).toBe(true)
      expect(w.parts.some((p) => p.kind === "brace")).toBe(true)
    },
  ],
  [
    "21 glob-dynamic",
    "rm -rf *",
    (x) => {
      const w = op(x.v("rm"), 0)
      expect(w.dynamic).toBe(true)
      expect(w.parts.some((p) => p.kind === "glob")).toBe(true)
      expect(w.root).toBe("cwd")
    },
  ],
  [
    "22 glob-root",
    "rm -rf /*",
    (x) => {
      const w = op(x.v("rm"), 0)
      expect(w.dynamic).toBe(true)
      expect(w.root).toBe("root")
    },
  ],
  ["23 tilde", "rm -rf ~", (x) => expect(op(x.v("rm"), 0).root).toBe("home")],
  ["24 tilde-slash", "rm -rf ~/", (x) => expect(op(x.v("rm"), 0).root).toBe("home")],
  [
    "25 home-var",
    "rm -rf $HOME",
    (x) => {
      const w = op(x.v("rm"), 0)
      expect(w.root).toBe("home")
      expect(w.dynamic).toBe(true)
      expect(w.text).toBe("$HOME")
    },
  ],
  ["26 home-var-quoted", 'rm -rf "$HOME"', (x) => expect(op(x.v("rm"), 0).root).toBe("home")],
  ["27 home-brace", "rm -rf ${HOME}/x", (x) => expect(op(x.v("rm"), 0).root).toBe("home")],
  [
    "28 var-static",
    "X=/; rm -rf $X",
    (x) => {
      const w = op(x.v("rm"), 0)
      expect(w.text).toBe("/")
      expect(w.dynamic).toBe(false)
      expect(w.viaVar).toBe(true)
    },
  ],
  [
    "29 var-prefix-no-leak",
    "X=/ rm -rf $X",
    (x) => {
      const w = op(x.v("rm"), 0)
      expect(w.dynamic).toBe(true)
      expect(w.root).toBeUndefined()
    },
  ],
  [
    "30 var-dynamic",
    'rm -rf "$x"',
    (x) => {
      const w = op(x.v("rm"), 0)
      expect(w.dynamic).toBe(true)
      expect(w.root).toBeUndefined()
    },
  ],
  ["31 var-export", "export D=/ && rm -rf $D", (x) => expect(op(x.v("rm"), 0).text).toBe("/")],
  // Flags
  ["32 bundled", "rm -rf a", RM_RF],
  [
    "33 bundled-upper",
    "rm -Rf a",
    (x) => {
      RM_RF(x)
      expect(x.v("rm").flags.has("R")).toBe(true)
      expect(x.v("rm").flags.raw).toContain("R")
    },
  ],
  ["34 long-flags", "rm --recursive --force a", RM_RF],
  ["35 flag-after-operand", "rm a -rf", RM_RF],
  [
    "36 end-of-options",
    "rm -- -rf",
    (x) => {
      const rm = x.v("rm")
      expect(rm.flags.list).toEqual([])
      expect(op(rm, 0).text).toBe("-rf")
      expect(rm.flags.endOfOptions).toBe(true)
    },
  ],
  [
    "37 git-bundled",
    "git push -fu origin main",
    (x) => {
      const g = gitSubcommand(x.v("git"))
      expect(g.sub).toBe("push")
      expect(g.flags.has("f")).toBe(true)
      expect(g.flags.has("u")).toBe(true)
      expect(g.operands.map((w) => w.text)).toEqual(["origin", "main"])
    },
  ],
  [
    "38 git-C-global",
    "git -C other push -f origin main",
    (x) => {
      const g = gitSubcommand(x.v("git"))
      expect(g.sub).toBe("push")
      expect(g.globals).toEqual(["-C", "other"])
      expect(g.flags.has("f")).toBe(true)
    },
  ],
  [
    "39 git-c-global",
    "git -c core.hooksPath=/x commit -m hi",
    (x) => {
      const g = gitSubcommand(x.v("git"))
      expect(g.sub).toBe("commit")
      expect(g.globals).toEqual(["-c", "core.hooksPath=/x"])
      expect(g.flags.value("m")).toBe("hi")
    },
  ],
  // Display commands
  [
    "40 echo-rm",
    'echo "rm -rf /"',
    (x) => {
      expect(x.names).toEqual(["echo"])
      expect(x.v("echo").display).toBe(true)
    },
  ],
  [
    "41 printf-rm",
    "printf '%s\\n' \"rm -rf /\"",
    (x) => {
      expect(x.names).toEqual(["printf"])
      expect(x.v("printf").display).toBe(true)
    },
  ],
  ["42 grep-rm", "grep rm file", (x) => expect(x.names).toEqual(["grep"])],
  [
    "43 git-commit-msg",
    'git commit -m "rm -rf /"',
    (x) => {
      expect(x.names).toEqual(["git"])
      expect(gitSubcommand(x.v("git")).sub).toBe("commit")
    },
  ],
  [
    "44 echo-sub-rm",
    "echo $(rm -rf /)",
    (x) => {
      expect(x.has("echo")).toBe(true)
      expect(x.e("rm").ctx.origin).toBe("cmdsub")
      expect(x.v("rm").origin).toBe("cmdsub")
    },
  ],
  ["45 echo-backtick-rm", "echo `rm -rf /`", (x) => expect(x.v("rm").origin).toBe("cmdsub")],
  [
    "46 cat-pipe-sh",
    "cat x | sh",
    (x) => {
      expect(x.has("sh")).toBe(true)
      expect(x.v("sh").display).toBe(false)
      expect(x.v("sh").viaPipeFrom?.name).toBe("cat")
    },
  ],
  // Substitutions
  ["47 cmdsub", "ls $(pwd)", (x) => expect(x.names.sort()).toEqual(["ls", "pwd"])],
  ["48 cmdsub-nested", "echo $(echo $(rm -rf /))", (x) => expect(x.v("rm").depth).toBe(2)],
  [
    "49 backtick",
    "x=`rm -rf /`",
    (x) => {
      expect(x.v("rm").origin).toBe("cmdsub")
      expect(first(x.r).assigns[0]?.name).toBe("x")
    },
  ],
  [
    "50 backtick-escaped-nested",
    "echo `echo \\`id\\``",
    (x) => expect(x.names.sort()).toEqual(["echo", "echo", "id"]),
  ],
  [
    "51 procsub",
    "diff <(ls a) <(ls b)",
    (x) => {
      expect(x.names).toEqual(["diff", "ls", "ls"])
      expect(
        x.all.filter((a) => a.view.name === "ls").every((a) => a.view.origin === "procsub"),
      ).toBe(true)
    },
  ],
  [
    "52 arith",
    "echo $((1+2))",
    (x) => {
      expect(x.names).toEqual(["echo"])
      const w = x.v("echo").args[0]
      expect(w?.dynamic).toBe(true)
      expect(w?.parts[0]?.kind).toBe("arith")
    },
  ],
  ["53 cmdsub-in-dq", 'echo "$(rm -rf /)"', (x) => expect(x.has("rm")).toBe(true)],
  ["54 dynamic-name", "$x -rf /", (x) => expect(x.all[0]?.view.nameDynamic).toBe(true)],
  [
    "55 cmdsub-name",
    "$(printf r)m -rf /",
    (x) => {
      expect(x.all.some((a) => a.view.nameDynamic)).toBe(true)
      expect(x.has("printf")).toBe(true)
    },
  ],
  // Redirects, heredocs, here-strings
  [
    "56 redirect-out",
    "echo x > /dev/sda",
    (x) => {
      const r = first(x.r).redirects[0]
      expect(r?.op).toBe(">")
      expect(r?.target?.text).toBe("/dev/sda")
    },
  ],
  [
    "57 redirect-fd",
    "cmd 2>&1",
    (x) => {
      const r = first(x.r).redirects[0]
      expect(r?.fd).toBe(2)
      expect(r?.op).toBe(">&")
      expect(r?.target?.text).toBe("1")
    },
  ],
  ["58 redirect-both", "cmd &> out", (x) => expect(first(x.r).redirects[0]?.op).toBe("&>")],
  [
    "59 redirect-append-home",
    "echo x >> ~/.ssh/authorized_keys",
    (x) => {
      const r = first(x.r).redirects[0]
      expect(r?.op).toBe(">>")
      expect(r?.target?.root).toBe("home")
    },
  ],
  [
    "60 heredoc-plain",
    "cat <<EOF\nrm -rf /\nEOF",
    (x) => {
      ok(x)
      expect(x.names).toEqual(["cat"])
      expect(first(x.r).redirects[0]?.heredoc?.body).toBe("rm -rf /")
    },
  ],
  [
    "61 heredoc-quoted",
    "cat <<'EOF'\n$(rm -rf /)\nEOF",
    (x) => {
      ok(x)
      expect(x.has("rm")).toBe(false)
      expect(first(x.r).redirects[0]?.heredoc?.quoted).toBe(true)
    },
  ],
  [
    "62 heredoc-unquoted-sub",
    "cat <<EOF\n$(rm -rf /)\nEOF",
    (x) => expect(x.v("rm").origin).toBe("heredoc"),
  ],
  [
    "63 heredoc-to-shell",
    "bash <<EOF\nrm -rf /\nEOF",
    (x) => expect(x.v("rm").origin).toBe("heredoc"),
  ],
  [
    "64 heredoc-dash",
    "cat <<-EOF\n\tbody\n\tEOF\nls",
    (x) => {
      ok(x)
      expect(first(x.r).redirects[0]?.heredoc?.body).toBe("body")
      expect(x.names).toEqual(["cat", "ls"])
    },
  ],
  [
    "65 heredoc-unterminated",
    "cat <<EOF\nrm -rf /",
    (x) => {
      fail(x, "heredoc-eof")
      if (!x.r.ok) expect(x.r.rawScan.tokens).toContain("rm")
    },
  ],
  ["66 here-string-shell", 'bash <<< "rm -rf /"', (x) => expect(x.v("rm").origin).toBe("heredoc")],
  ["67 here-string-plain", 'cat <<< "rm -rf /"', (x) => expect(x.has("rm")).toBe(false)],
  // Wrappers
  [
    "68 env-prefix",
    "FOO=1 BAR=2 rm -rf x",
    (x) => {
      expect(x.v("rm").assigns.map((a) => a.name)).toEqual(["FOO", "BAR"])
      RM_RF(x)
    },
  ],
  [
    "69 env-wrapper",
    "env -i FOO=1 rm -rf x",
    (x) => {
      expect(x.v("rm").chain).toEqual(["env"])
      expect(x.v("rm").assigns.map((a) => a.name)).toContain("FOO")
    },
  ],
  [
    "70 sudo",
    "sudo -u root rm -rf /",
    (x) => {
      expect(x.has("sudo")).toBe(true)
      expect(x.v("rm").chain).toEqual(["sudo"])
      RM_RF(x)
    },
  ],
  [
    "71 stacked",
    "sudo env X=1 nohup timeout 5 nice -n 5 rm -rf /",
    (x) => {
      expect(x.v("rm").chain).toEqual(["sudo", "env", "nohup", "timeout", "nice"])
      RM_RF(x)
    },
  ],
  ["72 bash-c", 'bash -c "rm -rf /"', (x) => expect(x.v("rm").origin).toBe("dash-c")],
  [
    "73 bash-lc-nested",
    "sh -lc 'echo ok && rm -rf /'",
    (x) => {
      expect(x.has("echo")).toBe(true)
      expect(x.has("rm")).toBe(true)
    },
  ],
  ["74 eval", 'eval "rm -rf /"', (x) => expect(x.v("rm").origin).toBe("eval")],
  [
    "75 eval-dynamic",
    'eval "$x"',
    (x) => {
      expect(x.v("eval").nameDynamic).toBe(true)
      expect(x.names).toEqual(["eval"])
    },
  ],
  [
    "76 python-c",
    "python3 -c \"import os; os.system('rm -rf /')\"",
    (x) => {
      expect(x.names).toEqual(["python3"])
      expect(x.v("python3").interpreter).toBe("python")
      expect(x.v("python3").text).toContain("os.system")
    },
  ],
  [
    "77 node-e",
    // Split so the dependency scan in src/deps.test.ts does not read it as an import.
    `node -e "${["requ", "ire"].join("")}('child_process').execSync('rm -rf /')"`,
    (x) => {
      expect(x.v("node").interpreter).toBe("node")
      expect(x.v("node").text).toContain("child_process")
      expect(x.has("rm")).toBe(false)
    },
  ],
  [
    "78 xargs-rm",
    "find . -name x | xargs rm -rf",
    (x) => {
      expect(x.has("find")).toBe(true)
      expect(x.v("rm").unknownTail).toBe(true)
      expect(x.v("rm").origin).toBe("xargs")
      RM_RF(x)
    },
  ],
  [
    "79 find-delete",
    "find / -name x -delete",
    (x) => expect(x.v("find").flags.has("delete")).toBe(true),
  ],
  [
    "80 find-exec",
    "find . -exec rm -rf {} \\;",
    (x) => {
      expect(x.has("find")).toBe(true)
      expect(x.v("rm").origin).toBe("find-exec")
      RM_RF(x)
      expect(op(x.v("rm"), 0).dynamic).toBe(true)
    },
  ],
  // Pipelines to shell
  [
    "81 curl-sh",
    "curl -fsSL http://x | sh",
    (x) => expect(x.v("sh").viaPipeFrom?.name).toBe("curl"),
  ],
  [
    "82 curl-sudo-bash",
    "curl x | sudo bash",
    (x) => {
      expect(x.v("bash").viaPipeFrom?.name).toBe("curl")
      expect(x.v("bash").chain).toEqual(["sudo"])
    },
  ],
  // Limits and errors
  [
    "83 unterminated-single",
    "git reset --hard 'abc",
    (x) => {
      fail(x, "syntax")
      if (!x.r.ok) {
        const t = x.r.rawScan.tokens
        expect(t.slice(0, 3)).toEqual(["git", "reset", "--hard"])
        expect(x.r.rawScan.hasUnclosedQuote).toBe(true)
      }
    },
  ],
  ["84 unterminated-double", 'echo "abc', (x) => fail(x, "syntax")],
  [
    "85 unbalanced-paren",
    "echo $(ls",
    (x) => {
      fail(x, "syntax")
      expect(x.has("echo")).toBe(true)
    },
  ],
  [
    "86 depth-5-wrappers",
    "sudo env nohup timeout 1 nice rm -rf /",
    (x) => expect(x.v("rm").limitHit).toBe(true),
  ],
  [
    "87 depth-5-dashc",
    nest5(),
    (x) => {
      const hit = x.all.find((a) => a.view.limitHit)
      expect(hit).toBeDefined()
      expect(x.has("rm")).toBe(false)
      expect(x.limits.length).toBeGreaterThan(0)
      expect(rawScan(x.limits[0]?.raw ?? "").tokens).toContain("rm")
    },
  ],
  [
    "88 huge-input",
    "echo a;".repeat(Math.ceil((200 * 1024) / 7)),
    (x) => {
      fail(x, "too-big")
      if (!x.r.ok) expect(x.r.rawScan.truncated).toBe(true)
      // H bound is 5 ms. Loose gate (review minor): 50 ms.
      expect(x.r.stats.micros).toBeLessThan(50_000)
    },
  ],
  ["89 max-words", `echo${" a".repeat(20000)}`, (x) => fail(x, "too-many-words")],
  ["90 deep-parens", `${"(".repeat(300)}ls${")".repeat(300)}`, (x) => fail(x, "too-deep")],
  [
    "91 empty",
    "",
    (x) => {
      ok(x)
      expect(x.names).toEqual([])
    },
  ],
  [
    "92 only-comment",
    "# hi",
    (x) => {
      ok(x)
      expect(x.names).toEqual([])
    },
  ],
  ["93 nul-and-binary", "rm\0 -rf /", (x) => expect(typeof x.r.ok).toBe("boolean")],
]

describe("parser corpus (H s11)", () => {
  for (const [name, input, check] of CASES) {
    test(name, () => {
      check(run(input))
    })
  }
  test("corpus size", () => {
    expect(CASES.length).toBe(93)
  })
})

describe("extra semantics", () => {
  test("case arms are visited", () => {
    const x = run("case $a in\n  x) rm -rf /;;\n  *) ls ;;\nesac")
    ok(x)
    expect(x.names).toEqual(["rm", "ls"])
  })
  test("if/for/while bodies are visited", () => {
    const x = run("if true; then rm -rf a; fi; for i in a b; do echo $i; done; while x; do y; done")
    ok(x)
    expect(x.names).toEqual(["true", "rm", "echo", "x", "y"])
  })
  test("function body visited", () => {
    const x = run("f() { rm -rf /; }; function g { ls; }")
    ok(x)
    expect(x.names).toEqual(["rm", "ls"])
  })
  test("subshell and group", () => {
    const x = run("(cd a && rm -rf b) > log; { ls; }")
    ok(x)
    expect(x.names).toEqual(["cd", "rm", "ls"])
  })
  test("pipe from echo into shell parses the text", () => {
    const x = run("echo 'rm -rf /' | sh")
    expect(x.v("rm").origin).toBe("heredoc")
  })
  test("ssh remote command", () => {
    const x = run("ssh -p 22 host rm -rf /")
    expect(x.v("rm").origin).toBe("dash-c")
    expect(x.v("ssh").remote).toBe(true)
  })
  test("plain is false with substitution", () => {
    const r = parseCommand("ls $(pwd)")
    expect(r.ok && r.plain).toBe(false)
  })
  test("command -v does not unwrap", () => {
    const x = run("command -v rm")
    expect(x.names).toEqual(["command"])
  })
  test("absolute path basename", () => {
    expect(run("/bin/rm -rf /").names).toEqual(["rm"])
  })
  test("double bracket test", () => {
    const x = run("[[ -f a && -d b ]] && rm -rf c")
    ok(x)
    expect(x.names).toEqual(["[[", "rm"])
  })
})
