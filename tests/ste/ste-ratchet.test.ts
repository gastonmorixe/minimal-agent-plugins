/**
 * Tests for the ratchet bookkeeping and the ratchet lock (REVIEW-C B1, B2,
 * M8, m5).
 *
 * The merge base (origin/main) has no pending.json and an empty baseline, so
 * a guard that reads the merge base sees "first landing" and allows anything.
 * The committed lock `ratchet-lock.json` is the ceiling instead:
 *
 * 1. Unit tests: `regressions`, `improvements`, `promotionsDue`, the lock
 *    helpers, and the `--introduce` refusal.
 * 2. Real tree: the tree is not above the lock, the lock agrees with the
 *    baseline file, and the lock is not above any committed copy of itself.
 *
 * The s19 pending counts against the lock are in `ste-dictionary.test.ts`.
 *
 * @module tests/ste/ste-ratchet.test
 */

import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import extraRules, { isVerb } from "./extra-rules.ts"
import {
  BASELINE_PATH,
  type Baseline,
  entriesToCounts,
  improvements,
  introduceRefusal,
  knownRules,
  LOCK_PATH,
  LOCK_REL,
  lockBaseline,
  lockCeiling,
  lockHistory,
  lockKey,
  lockProblems,
  lockRaises,
  lockText,
  meetLocks,
  normalizeLock,
  promotionsDue,
  type RatchetLock,
  readBaseline,
  readLock,
  regressions,
  reportByFile,
  ruleIdsInSource,
  splitLockKey,
  toEntries,
  ZERO_TOLERANCE,
} from "./ratchet.ts"
import { RULE_IDS } from "./ste-rules.ts"
import { allSurfaces, CORE_ROOT, coreSurfaces, PLUGINS_ROOT } from "./surfaces.ts"

/** A baseline with the given entries. */
function baseline(entries: Baseline["entries"]): Baseline {
  return { version: 1, generated: "x", entries }
}

/** A small lock for the unit tests. */
function lock(extra: Partial<RatchetLock> = {}): RatchetLock {
  return {
    version: 1,
    rules: ["ste-s13-paragraph", "ste-s15-slash", "ste-s7-passive"],
    zeroTolerance: ["ste-s7-passive"],
    baseline: { [lockKey("ste-s15-slash", "a.md")]: 2 },
    pending: { [lockKey("frob", "a.md")]: 2, [lockKey("zork", "b.md")]: 1 },
    ...extra,
  }
}

describe("regressions (REVIEW-C M8)", () => {
  const base = baseline([{ file: "a.md", rule: "r", count: 2 }])

  test("a count of baseline + 1 regresses (no slack)", () => {
    expect(regressions([{ file: "a.md", rule: "r", count: 3 }], base)).toEqual([
      { file: "a.md", rule: "r", baseline: 2, current: 3, reason: "above-baseline" },
    ])
  })

  test("a count at or below the baseline is no regression", () => {
    expect(regressions([{ file: "a.md", rule: "r", count: 2 }], base)).toEqual([])
    expect(regressions([{ file: "a.md", rule: "r", count: 1 }], base)).toEqual([])
    expect(regressions([], base)).toEqual([])
  })

  test("a new pair is `new`: a new file or a new rule in a known file", () => {
    const current = [
      { file: "b.md", rule: "r", count: 1 },
      { file: "a.md", rule: "s", count: 1 },
    ]
    expect(regressions(current, base)).toEqual([
      { file: "a.md", rule: "s", baseline: 0, current: 1, reason: "new" },
      { file: "b.md", rule: "r", baseline: 0, current: 1, reason: "new" },
    ])
  })
})

describe("improvements", () => {
  const base = baseline([
    { file: "a.md", rule: "r", count: 2 },
    { file: "b.md", rule: "r", count: 1 },
  ])

  test("a lower count and a gone pair are improvements", () => {
    expect(improvements([{ file: "a.md", rule: "r", count: 1 }], base)).toEqual(base.entries)
  })

  test("the same or a higher count is no improvement", () => {
    const same = [
      { file: "a.md", rule: "r", count: 2 },
      { file: "b.md", rule: "r", count: 5 },
    ]
    expect(improvements(same, base)).toEqual([])
  })
})

describe("promotionsDue (REVIEW-C m5)", () => {
  // PROMOTE_AT_ZERO is empty since 2026-11-17 (every rule is zero-tolerance),
  // so these tests use a fixture set with the 4 rules it held.
  const promote = new Set([
    "ste-s13-paragraph",
    "ste-s15-slash",
    "ste-s16-progressive",
    "ste-s18-fragment",
  ])
  const zeroBefore = new Set([...ZERO_TOLERANCE].filter((rule) => !promote.has(rule)))

  test("every PROMOTE_AT_ZERO rule with no debt is due", () => {
    expect(promotionsDue([], promote, zeroBefore)).toEqual([
      "ste-s13-paragraph",
      "ste-s15-slash",
      "ste-s16-progressive",
      "ste-s18-fragment",
    ])
    // The real sets: nothing is due.
    expect(promotionsDue([])).toEqual([])
  })

  test("a rule with debt, or already zero-tolerance, is not due", () => {
    const entries = [{ file: "a.md", rule: "ste-s13-paragraph", count: 1 }]
    const zero = new Set([...zeroBefore, "ste-s15-slash"])
    expect(promotionsDue(entries, promote, zero)).toEqual([
      "ste-s16-progressive",
      "ste-s18-fragment",
    ])
  })
})

describe("lock helpers", () => {
  test("lockKey and splitLockKey round-trip, also with a space in the file", () => {
    expect(splitLockKey(lockKey("frob", "a b/c.md"))).toEqual({ item: "frob", file: "a b/c.md" })
  })

  test("lockRaises: the same lock and a lower lock are no raise", () => {
    expect(lockRaises(lock(), lock())).toEqual([])
    const lower = lock({ baseline: {}, pending: { [lockKey("frob", "a.md")]: 1 } })
    expect(lockRaises(lower, lock())).toEqual([])
  })

  test("lockRaises: a higher pending count, a new pending pair", () => {
    const up = lock({
      pending: {
        [lockKey("frob", "a.md")]: 3,
        [lockKey("zork", "b.md")]: 1,
        [lockKey("frob", "b.md")]: 1,
      },
    })
    expect(lockRaises(up, lock())).toEqual([
      "pending: frob @ a.md: 3 > 2",
      "pending: frob @ b.md: 1 > 0 (new)",
    ])
  })

  test("lockRaises: a higher baseline count, a new baseline pair of a known rule", () => {
    const up = lock({
      baseline: {
        [lockKey("ste-s15-slash", "a.md")]: 3,
        [lockKey("ste-s13-paragraph", "x.md")]: 1,
      },
    })
    expect(lockRaises(up, lock())).toEqual([
      "baseline: ste-s15-slash @ a.md: 3 > 2",
      "baseline: ste-s13-paragraph @ x.md: 1 > 0",
    ])
  })

  test("lockRaises: a rule removed from rules or from zeroTolerance", () => {
    const out = lock({ rules: ["ste-s13-paragraph", "ste-s7-passive"], zeroTolerance: [] })
    expect(lockRaises(out, lock())).toEqual([
      "rules: ste-s15-slash removed",
      "zeroTolerance: ste-s7-passive removed",
    ])
  })

  test("lockRaises: a NEW rule may record its debt once", () => {
    const next = lock({
      rules: [...lock().rules, "ste-s99-new"],
      baseline: { ...lock().baseline, [lockKey("ste-s99-new", "a.md")]: 4 },
    })
    expect(lockRaises(next, lock())).toEqual([])
    // After it lands, the new rule is known and cannot grow.
    const more = lock({
      rules: next.rules,
      baseline: { ...next.baseline, [lockKey("ste-s99-new", "a.md")]: 5 },
    })
    expect(lockRaises(more, next)).toEqual(["baseline: ste-s99-new @ a.md: 5 > 4"])
  })

  test("meetLocks takes the lower count and the union of the rule lists", () => {
    const a = lock({ pending: { [lockKey("frob", "a.md")]: 5, [lockKey("new", "a.md")]: 1 } })
    const met = meetLocks(a, lock())
    expect(met.pending).toEqual({ [lockKey("frob", "a.md")]: 2 })
    expect(met.baseline).toEqual(lock().baseline)
    const hand = lock({ rules: ["ste-s13-paragraph"], zeroTolerance: [] })
    expect(meetLocks(hand, lock()).rules).toEqual(normalizeLock(lock()).rules)
    expect(meetLocks(hand, lock()).zeroTolerance).toEqual(["ste-s7-passive"])
  })

  test("lockCeiling: a hand raise of the working lock does not raise the ceiling", () => {
    const raised = lock({ pending: { ...lock().pending, [lockKey("frob", "a.md")]: 9 } })
    const ceiling = lockCeiling(raised, [{ ref: "HEAD", lock: lock() }])
    expect(ceiling.pending[lockKey("frob", "a.md")]).toBe(2)
    expect(lockCeiling(raised, []).pending[lockKey("frob", "a.md")]).toBe(9)
  })

  test("lockProblems: bad keys, bad counts, a baseline rule that is unknown or zero-tolerance", () => {
    expect(lockProblems(lock())).toEqual([])
    const bad = lock({
      baseline: { "ste-s7-passive @ a.md": 1, "ste-s99-x @ a.md": 1, nokey: 1 },
      pending: { "frob @ a.md": 0 },
    })
    expect(lockProblems(bad)).toEqual([
      "baseline: ste-s7-passive @ a.md: the rule is zero-tolerance",
      "baseline: ste-s99-x @ a.md: the rule is not in rules",
      "baseline: bad key nokey",
      "baseline: nokey: the rule is not in rules",
      "pending: bad count frob @ a.md: 0",
    ])
  })
})

describe("lockHistory (a temp git repo)", () => {
  /** Run git in the temp repo with a fixed identity. */
  function run(cwd: string, ...args: string[]): string {
    return execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim()
  }

  /** Commit a lock (or only a note file) and return the sha. */
  function commit(cwd: string, value: RatchetLock | undefined, note: string): string {
    if (value) writeFileSync(join(cwd, LOCK_REL), lockText(value))
    writeFileSync(join(cwd, "note.txt"), note)
    run(cwd, "add", "-A")
    run(cwd, "commit", "-qm", note)
    return run(cwd, "rev-parse", "HEAD")
  }

  test("REVIEW-C2 K2: a squash onto a base with no lock does not lift the ceiling", () => {
    const dir = mkdtempSync(join(tmpdir(), "ste-squash-"))
    const remote = mkdtempSync(join(tmpdir(), "ste-remote-"))
    try {
      run(remote, "init", "-q", "--bare")
      run(dir, "init", "-q", "-b", "main")
      mkdirSync(join(dir, "tests/ste"), { recursive: true })
      // main has no lock: the first landing.
      const base = commit(dir, undefined, "main")
      run(dir, "remote", "add", "origin", remote)
      run(dir, "push", "-q", "origin", "main")
      run(dir, "fetch", "-q", "origin")
      run(dir, "checkout", "-q", "-b", "topic")
      const low = lock({ pending: { [lockKey("frob", "a.md")]: 1 } })
      commit(dir, low, "low lock")
      run(dir, "push", "-q", "-u", "origin", "topic")
      // The attack: squash the branch onto the base with a raised lock.
      const raised = lock({ pending: { [lockKey("frob", "a.md")]: 5 } })
      run(dir, "reset", "-q", "--soft", base)
      writeFileSync(join(dir, LOCK_REL), lockText(raised))
      run(dir, "add", "-A")
      run(dir, "commit", "-qm", "squash")
      // HEAD holds the raise, the base has no lock: only the pushed copy remains.
      const ceiling = lockCeiling(raised, lockHistory(dir))
      expect(ceiling.pending[lockKey("frob", "a.md")]).toBe(1)
      const lines = lockHistory(dir).flatMap((v) => lockRaises(raised, v.lock))
      expect(lines).toContain("pending: frob @ a.md: 5 > 1")
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(remote, { recursive: true, force: true })
    }
  })

  test("HEAD, the merge base and every branch commit that changed the lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "ste-lock-"))
    try {
      run(dir, "init", "-q")
      mkdirSync(join(dir, "tests/ste"), { recursive: true })
      // No lock anywhere: no history, so the lock tests have nothing to compare.
      commit(dir, undefined, "empty")
      expect(lockHistory(dir)).toEqual([])
      const base = commit(dir, lock(), "main")
      run(dir, "update-ref", "refs/remotes/origin/main", base)
      const lower = lock({ pending: { [lockKey("frob", "a.md")]: 1 } })
      const lowered = commit(dir, lower, "lower")
      const raised = lock({ pending: { ...lower.pending, [lockKey("new", "a.md")]: 1 } })
      const raisedSha = commit(dir, raised, "raise")
      const head = commit(dir, undefined, "unrelated")
      const refs = lockHistory(dir).map((v) => v.ref)
      expect(refs.slice(0, 2)).toEqual(["HEAD", base])
      expect(refs.slice(2).sort()).toEqual([lowered, raisedSha].sort())
      expect(refs).not.toContain(head)
      // The raise was committed on the branch, so HEAD has it. The copy before
      // it ("lower") is still in the history, so the raise is still caught.
      const lines = lockHistory(dir).flatMap((v) => lockRaises(raised, v.lock))
      expect(lines).toEqual([
        "pending: new @ a.md: 1 > 0 (new)",
        "pending: new @ a.md: 1 > 0 (new)",
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("--introduce refusal (REVIEW-C B2)", () => {
  const real = readLock()
  const head = ruleIdsInSource(readFileSync(new URL("./ste-rules.ts", import.meta.url), "utf8"))

  test("refuses every rule that exists today: in the lock, zero-tolerance or with debt", () => {
    const known = knownRules(real, head)
    for (const rule of RULE_IDS) {
      expect(introduceRefusal(rule, known), rule).toBeDefined()
    }
    expect(introduceRefusal("ste-s7-passive", known)).toContain("zero-tolerance")
    // Every real rule is zero-tolerance now, so the "already exists" branch is
    // proved with a zero set that leaves one known rule out.
    const zero = new Set([...ZERO_TOLERANCE].filter((rule) => rule !== "ste-s15-slash"))
    expect(introduceRefusal("ste-s15-slash", known, RULE_IDS, zero)).toContain("already exists")
  })

  test("refuses an existing rule also with an empty lock (the old merge-base hole)", () => {
    const empty: RatchetLock = {
      version: 1,
      rules: [],
      zeroTolerance: [],
      baseline: {},
      pending: {},
    }
    // A rule id that is in ste-rules.ts at HEAD is known.
    expect(introduceRefusal("ste-s15-slash", knownRules(empty, head))).toBeDefined()
    // A rule that only has a lock baseline entry is known.
    const debt = { ...empty, baseline: { [lockKey("ste-s13-paragraph", "a.md")]: 1 } }
    expect(introduceRefusal("ste-s13-paragraph", knownRules(debt))).toBeDefined()
    // Every ZERO_TOLERANCE rule is refused.
    for (const rule of ZERO_TOLERANCE) {
      expect(introduceRefusal(rule, knownRules(empty)), rule).toBeDefined()
    }
  })

  test("allows a NEW rule id only, and refuses an unknown id", () => {
    const ids = [...RULE_IDS, "ste-s99-new"]
    expect(introduceRefusal("ste-s99-new", knownRules(real, head), ids)).toBeUndefined()
    expect(introduceRefusal("ste-s99-typo", knownRules(real, head), ids)).toContain("unknown")
  })

  test("ruleIdsInSource reads every quoted rule id", () => {
    expect([...head].sort()).toEqual([...RULE_IDS].sort())
  })
})

describe("the committed lock (real tree)", () => {
  const real = readLock()
  const surfaces = [...allSurfaces(PLUGINS_ROOT), ...coreSurfaces(CORE_ROOT)]
  const current = toEntries(reportByFile(surfaces, { extraFindings: extraRules, isVerb }))

  test("the lock file is canonical and has a valid shape", () => {
    expect(readFileSync(LOCK_PATH, "utf8")).toBe(lockText(real))
    expect(lockProblems(real)).toEqual([])
  })

  test("the lock pins every rule id and the ZERO_TOLERANCE set", () => {
    expect(real.rules.filter((rule) => !RULE_IDS.includes(rule))).toEqual([])
    expect(RULE_IDS.filter((rule) => !real.rules.includes(rule))).toEqual([])
    // A rule may join ZERO_TOLERANCE, never leave it.
    expect(real.zeroTolerance.filter((rule) => !ZERO_TOLERANCE.has(rule))).toEqual([])
  })

  test("no file or rule of the tree is above the lock", () => {
    const lines = regressions(current, lockBaseline(real)).map(
      (r) => `${r.rule} @ ${r.file}: ${r.current} > ${r.baseline} (${r.reason})`,
    )
    expect(lines).toEqual([])
  })

  test("the lock baseline equals ste-baseline.json (ste:write writes both)", () => {
    expect(real.baseline).toEqual(
      normalizeLock({ ...real, baseline: entriesToCounts(readBaseline(BASELINE_PATH).entries) })
        .baseline,
    )
  })

  test("the lock is not above any committed copy (HEAD, merge base, the branch)", () => {
    const lines = lockHistory().flatMap(({ ref, lock: prev }) =>
      lockRaises(real, prev).map((line) => `${ref.slice(0, 10)}: ${line}`),
    )
    expect(lines).toEqual([])
  })
})
