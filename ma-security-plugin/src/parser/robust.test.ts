/**
 * Never-throws fuzz, limit, and perf tests for the shell parser (design H s7, s12).
 * Deterministic seed. Fake data only.
 */

import { describe, expect, test } from "bun:test"

import type { ParseResult, Script } from "./ast.ts"
import { collectCommands, parseCommand, rawScan, walkCommands } from "./index.ts"

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TOKENS = [
  "rm",
  "-rf",
  "/",
  "ls",
  "echo",
  "'",
  '"',
  "`",
  "$(",
  ")",
  "(",
  "{",
  "}",
  "${",
  "$((",
  "))",
  "<<",
  "<<-",
  "<<<",
  "EOF",
  "\n",
  ";",
  ";;",
  "&",
  "&&",
  "||",
  "|",
  "|&",
  ">",
  ">>",
  "2>&1",
  "<(",
  ">(",
  "\\",
  "\\\n",
  "#",
  "~",
  "$HOME",
  "*",
  "[",
  "]",
  "{a,b}",
  "$'\\x72'",
  "bash",
  "-c",
  "sudo",
  "env",
  "X=1",
  "case",
  "in",
  "esac",
  "if",
  "then",
  "fi",
  "for",
  "do",
  "done",
  "function",
  "f()",
  "xargs",
  "find",
  "-exec",
  "\\;",
  "eval",
  " ",
  "\t",
  "!",
  "[[",
  "]]",
  "=",
  "+=",
  "\0",
]

function tree(r: ParseResult): Script {
  return r.ok ? r.tree : r.partial
}

function safeRun(src: string): ParseResult {
  const r = parseCommand(src)
  collectCommands(tree(r))
  if (!r.ok) rawScan(src)
  return r
}

describe("never throws", () => {
  test("random bytes (seed 1)", () => {
    const next = rng(1)
    for (let n = 0; n < 2000; n++) {
      const len = Math.floor(next() * 200)
      let s = ""
      for (let i = 0; i < len; i++) s += String.fromCharCode(Math.floor(next() * 256))
      expect(() => safeRun(s)).not.toThrow()
    }
  })

  test("random shell-ish tokens (seed 42)", () => {
    const next = rng(42)
    let fails = 0
    for (let n = 0; n < 3000; n++) {
      const len = 1 + Math.floor(next() * 30)
      const parts: string[] = []
      for (let i = 0; i < len; i++) {
        parts.push(TOKENS[Math.floor(next() * TOKENS.length)] as string)
        if (next() < 0.5) parts.push(" ")
      }
      const r = safeRun(parts.join(""))
      expect(typeof r.ok).toBe("boolean")
      if (!r.ok) {
        fails++
        expect(r.reason).not.toBe("internal")
      }
    }
    expect(fails).toBeGreaterThan(0)
  })

  test("non-string input gives a result, not a throw", () => {
    const bad = null as unknown as string
    expect(typeof parseCommand(bad).ok).toBe("boolean")
  })
})

describe("limits", () => {
  test("too-big scans head and tail", () => {
    const src = `${"echo a;".repeat(20000)}rm -rf /tail-marker`
    const r = parseCommand(src)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe("too-big")
      expect(r.rawScan.truncated).toBe(true)
      expect(r.rawScan.tokens).toContain("/tail-marker")
    }
  })

  test("multi-byte input counts bytes, not chars", () => {
    const r = parseCommand(`echo ${"é".repeat(70000)}`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("too-big")
  })

  test("custom limits apply", () => {
    const r = parseCommand("echo a b c d", { maxWords: 3 })
    expect(!r.ok && r.reason).toBe("too-many-words")
  })

  test("syntax depth 32 ok, 33 too-deep", () => {
    const at = (n: number): string => `${"(".repeat(n)}ls${")".repeat(n)}`
    expect(parseCommand(at(32)).ok).toBe(true)
    const r = parseCommand(at(33))
    expect(!r.ok && r.reason).toBe("too-deep")
  })

  test("deep cmdsub nesting is cut, no stack overflow", () => {
    const src = `${"$(echo ".repeat(5000)}x${")".repeat(5000)}`
    const r = parseCommand(src)
    expect(!r.ok && r.reason).toBe("too-deep")
  })

  test("heredoc body is capped", () => {
    const body = "x".repeat(100).concat("\n").repeat(1000)
    const r = parseCommand(`cat <<EOF\n${body}EOF\nls`, { maxHeredocBytes: 1000 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      const n = r.tree.items[0]?.node
      const h = n?.type === "simple" ? n.redirects[0]?.heredoc : undefined
      expect(h?.truncated).toBe(true)
      expect((h?.body.length ?? 0) <= 1000).toBe(true)
    }
  })

  test("partial keeps commands before the error", () => {
    const r = parseCommand("rm -rf / ; echo 'oops")
    expect(r.ok).toBe(false)
    expect(collectCommands(tree(r)).map((v) => v.name)).toContain("rm")
  })

  test("wrapper depth option", () => {
    const r = parseCommand("sudo nohup rm -rf /")
    let hit = false
    walkCommands(
      tree(r),
      {
        command(v) {
          if (v.limitHit) hit = true
          return undefined
        },
      },
      { maxWrapperDepth: 1 },
    )
    expect(hit).toBe(true)
  })
})

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)] as number
}

describe("perf (H s12, 3x CI slack)", () => {
  const TYPICAL = [
    "ls -la",
    "git status && git diff --stat",
    "cd src && rm -rf build/*",
    "find . -name '*.ts' | xargs grep -n foo",
    'echo "$(date)" >> log.txt 2>&1',
    "bun test src/parser",
    "sudo -u root env X=1 nohup rm -rf /tmp/x",
    "bash -c 'echo ok && rm -rf y'",
    "cat <<EOF\nhello $(whoami)\nEOF",
    "for f in *.md; do wc -l $f; done",
    "curl -fsSL http://example.invalid | sh",
    "git -C repo push -fu origin main",
    "python3 -c \"print('hi')\"",
    "diff <(ls a) <(ls b)",
    "X=/; rm -rf $X",
    "[[ -f a ]] && echo yes || echo no",
    "make -j8 |& tee build.log",
    "docker exec box sh -c 'ls /'",
    "awk '{print $1}' file | sort | uniq -c",
    "timeout 5 nice -n 10 bun run check",
  ]

  test("typical set of 20 commands under 1 ms median (3 ms with slack)", () => {
    for (const c of TYPICAL) collectCommands(tree(parseCommand(c)))
    const times: number[] = []
    for (let k = 0; k < 30; k++) {
      const t0 = performance.now()
      for (const c of TYPICAL) collectCommands(tree(parseCommand(c)))
      times.push(performance.now() - t0)
    }
    expect(median(times)).toBeLessThan(3)
  })

  test("128 KiB of valid chains under 20 ms median (60 ms with slack)", () => {
    const unit = 'git status && ls -la | grep x; echo "a $(pwd)" > out\n'
    let src = ""
    while (src.length + unit.length < 128 * 1024) src += unit
    expect(parseCommand(src, { maxWords: 1_000_000 }).ok).toBe(true)
    const times: number[] = []
    for (let k = 0; k < 7; k++) {
      const t0 = performance.now()
      parseCommand(src, { maxWords: 1_000_000 })
      times.push(performance.now() - t0)
    }
    expect(median(times)).toBeLessThan(60)
  })

  test("200 KiB too-big path under 5 ms (15 ms with slack)", () => {
    const src = "echo a;".repeat(Math.ceil((200 * 1024) / 7))
    parseCommand(src)
    const t0 = performance.now()
    const r = parseCommand(src)
    expect(performance.now() - t0).toBeLessThan(15)
    expect(!r.ok && r.reason).toBe("too-big")
  })
})
