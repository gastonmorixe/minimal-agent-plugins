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

/**
 * Runs `unitOfWork` repeatedly until `budgetMs` elapses and returns how many
 * times it ran. Time-boxed, so the test's own wall-clock duration is capped
 * regardless of machine speed; a slow or contended CPU just completes fewer
 * iterations rather than making the test take longer or flake. The caller
 * asserts a floor on the iteration count (the WORK done in that fixed
 * window), not on a single run's wall-clock time -- immune to a slow tick
 * here or there from a GC pause, JIT warmup, or a neighboring process
 * stealing a core, which is what made the old median-of-N-runs-under-X-ms
 * form flaky on a shared, multi-agent CI box.
 */
function iterationsInBudget(unitOfWork: () => void, budgetMs: number): number {
  const deadline = performance.now() + budgetMs
  let n = 0
  while (performance.now() < deadline) {
    unitOfWork()
    n++
  }
  return n
}

describe("perf (H s12, time-boxed work count: robust to CI CPU contention)", () => {
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

  test("typical set of 20 commands: at least 20 full passes complete in a 200 ms window", () => {
    for (const c of TYPICAL) collectCommands(tree(parseCommand(c)))
    const passes = iterationsInBudget(() => {
      for (const c of TYPICAL) collectCommands(tree(parseCommand(c)))
    }, 200)
    // A healthy parser clears one pass in well under 1 ms (the old bound,
    // with its 3x slack, was 3 ms/pass); 20 passes in 200 ms is 10 ms/pass,
    // ~3x more slack again on top of that, so this only trips on a real
    // regression, not ordinary CPU contention from other sessions.
    expect(passes).toBeGreaterThanOrEqual(20)
  })

  test("128 KiB of valid chains: at least 2 full parses complete in a 1 s window", () => {
    const unit = 'git status && ls -la | grep x; echo "a $(pwd)" > out\n'
    let src = ""
    while (src.length + unit.length < 128 * 1024) src += unit
    expect(parseCommand(src, { maxWords: 1_000_000 }).ok).toBe(true)
    const parses = iterationsInBudget(() => {
      parseCommand(src, { maxWords: 1_000_000 })
    }, 1000)
    // A healthy parser clears one parse in well under 20 ms (the old bound,
    // with its 3x slack, was 60 ms/parse); requiring 2 in a 1 s window
    // allows up to 500 ms/parse, ~8x more slack again, so this only trips on
    // a real regression, not ordinary CPU contention from other sessions.
    expect(parses).toBeGreaterThanOrEqual(2)
  })

  test("200 KiB too-big path: at least 10 rejections complete in a 300 ms window", () => {
    const src = "echo a;".repeat(Math.ceil((200 * 1024) / 7))
    const r = parseCommand(src)
    expect(!r.ok && r.reason).toBe("too-big")
    const rejections = iterationsInBudget(() => {
      parseCommand(src)
    }, 300)
    // The too-big guard should bail out before doing real parse work (the
    // old bound, with its 3x slack, was 15 ms/rejection); 10 in 300 ms is
    // 30 ms/rejection, another 2x on top of that, so this only trips if the
    // guard regresses into doing the full parse first, not on ordinary CPU
    // contention from other sessions.
    expect(rejections).toBeGreaterThanOrEqual(10)
  })
})
