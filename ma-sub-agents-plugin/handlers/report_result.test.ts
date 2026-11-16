/**
 * Handler test for `ReportResult`: it must write a valid sentinel to the path in
 * the worker's environment, be a no-op (with an explanation) when no result path
 * is present (a lead called it), and round-trip through the same parser the
 * supervisor probe uses.
 *
 * @module sub-agents/handlers/report_result.test
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import type { TUIContext, TUIResult } from "../lib/host-types.ts"
import { ENV_EXPECT_ARTIFACTS, ENV_RESULT_PATH, parseResultDigest } from "../lib/spawn.ts"

import reportResult, { available } from "./report_result.ts"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "report-result-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function ctx(input: Record<string, unknown>, env: Record<string, string>): TUIContext {
  return {
    trigger: { type: "tool", name: "ReportResult", input, tool_use_id: "t1" },
    packageDir: "/tmp/fake",
    cwd: "/tmp/fake",
    env,
    abort: new AbortController().signal,
    stdout: process.stdout,
    stdin: process.stdin,
    stderr: process.stderr,
    log: { info() {}, warn() {}, error() {}, debug() {} } as never,
  }
}

async function call(
  input: Record<string, unknown>,
  env: Record<string, string>,
): Promise<TUIResult> {
  return reportResult(ctx(input, env))
}

describe("ReportResult handler", () => {
  it("writes a valid sentinel to the worker's result path and confirms", async () => {
    const resultPath = join(dir, "abc.result.json")
    const res = await call(
      { summary: "found the leak in pool.ts", artifacts: [join(dir, "out.md")] },
      { [ENV_RESULT_PATH]: resultPath },
    )
    expect(res.kind).toBe("tool_result")
    if (res.kind === "tool_result") expect(res.is_error).toBeFalsy()
    expect(existsSync(resultPath)).toBe(true)

    // The bytes parse through the SAME validator the supervisor probe uses.
    const digest = parseResultDigest(JSON.parse(readFileSync(resultPath, "utf-8")))
    expect(digest?.short).toBe("found the leak in pool.ts")
    expect(digest?.artifacts).toEqual([join(dir, "out.md")])
  })

  it("prefixes INCOMPLETE: into the sentinel when the worker flags incompletion", async () => {
    const resultPath = join(dir, "x.result.json")
    await call({ summary: "only got halfway", incomplete: true }, { [ENV_RESULT_PATH]: resultPath })
    const digest = parseResultDigest(JSON.parse(readFileSync(resultPath, "utf-8")))
    expect(digest?.short).toMatch(/^INCOMPLETE: /)
  })

  it("is a no-op with an explanation when there is no result path (a LEAD called it)", async () => {
    const res = await call({ summary: "hello" }, {})
    expect(res.kind).toBe("tool_result")
    if (res.kind === "tool_result") {
      expect(res.is_error).toBe(true)
      expect(res.content).toMatch(/sub-agent completion tool|not a sub-agent/i)
    }
  })

  it("rejects a missing summary as a teaching error", async () => {
    const res = await call({}, { [ENV_RESULT_PATH]: join(dir, "y.result.json") })
    expect(res.kind).toBe("tool_result")
    if (res.kind === "tool_result") {
      expect(res.is_error).toBe(true)
      expect(res.content).toMatch(/summary/i)
    }
    // nothing written
    expect(existsSync(join(dir, "y.result.json"))).toBe(false)
  })
})

describe("ReportResult availability predicate", () => {
  it("is available only when the worker's result-path env is present", () => {
    expect(available({ env: { [ENV_RESULT_PATH]: "/x/r.json" }, cwd: "/" })).toBe(true)
    // a lead (no result path) does NOT see the tool
    expect(available({ env: {}, cwd: "/" })).toBe(false)
    // an empty/whitespace value is treated as absent
    expect(available({ env: { [ENV_RESULT_PATH]: "   " }, cwd: "/" })).toBe(false)
  })
})

describe("ReportResult deliverables + expectArtifacts contract", () => {
  function env(resultPath: string, contract?: string[]): Record<string, string> {
    return {
      [ENV_RESULT_PATH]: resultPath,
      ...(contract ? { [ENV_EXPECT_ARTIFACTS]: JSON.stringify(contract) } : {}),
    }
  }

  it("(a) writes a contracted deliverable, then the sentinel, and lists it in artifacts", async () => {
    const resultPath = join(dir, "a.result.json")
    const out = join(dir, "nested", "findings.md")
    const res = await call(
      { summary: "the findings", deliverables: [{ path: out, content: "# Findings\n" }] },
      env(resultPath, [out]),
    )
    if (res.kind === "tool_result") expect(res.is_error).toBeFalsy()
    expect(readFileSync(out, "utf-8")).toBe("# Findings\n")
    const digest = parseResultDigest(JSON.parse(readFileSync(resultPath, "utf-8")))
    expect(digest?.artifacts).toContain(out)
  })

  it("(b) rejects a deliverable path that is not in the contract: no file, no sentinel", async () => {
    const resultPath = join(dir, "b.result.json")
    const allowed = join(dir, "allowed.md")
    const other = join(dir, "other.md")
    const res = await call(
      { summary: "x", deliverables: [{ path: other, content: "nope" }] },
      env(resultPath, [allowed]),
    )
    expect(res.kind === "tool_result" && res.is_error).toBe(true)
    if (res.kind === "tool_result") expect(res.content).toContain(allowed)
    expect(existsSync(other)).toBe(false)
    expect(existsSync(resultPath)).toBe(false)
  })

  it("(c) refuses to finish when a contracted file is missing and incomplete is not set", async () => {
    const resultPath = join(dir, "c.result.json")
    const out = join(dir, "missing.md")
    const res = await call({ summary: "done, trust me" }, env(resultPath, [out]))
    expect(res.kind === "tool_result" && res.is_error).toBe(true)
    if (res.kind === "tool_result") {
      expect(res.content).toContain(out)
      expect(res.content).toMatch(/deliverables/)
    }
    expect(existsSync(resultPath)).toBe(false)
  })

  it("(d) with incomplete:true, a missing contracted file still records the sentinel", async () => {
    const resultPath = join(dir, "d.result.json")
    const out = join(dir, "missing.md")
    const res = await call({ summary: "blocked by X", incomplete: true }, env(resultPath, [out]))
    if (res.kind === "tool_result") expect(res.is_error).toBeFalsy()
    const digest = parseResultDigest(JSON.parse(readFileSync(resultPath, "utf-8")))
    expect(digest?.incomplete).toBe(true)
  })

  it("(e) with no contract env, deliverables are an error and summary-only still works", async () => {
    const resultPath = join(dir, "e.result.json")
    const out = join(dir, "free.md")
    const bad = await call(
      { summary: "x", deliverables: [{ path: out, content: "y" }] },
      env(resultPath),
    )
    expect(bad.kind === "tool_result" && bad.is_error).toBe(true)
    if (bad.kind === "tool_result") expect(bad.content).toMatch(/expectArtifacts|no required/i)
    expect(existsSync(out)).toBe(false)
    expect(existsSync(resultPath)).toBe(false)

    const good = await call({ summary: "plain" }, env(resultPath))
    if (good.kind === "tool_result") expect(good.is_error).toBeFalsy()
    expect(existsSync(resultPath)).toBe(true)
  })

  it("accepts an existing non-empty contracted file written earlier (writable worker)", async () => {
    const resultPath = join(dir, "f.result.json")
    const out = join(dir, "pre.md")
    writeFileSync(out, "already here")
    const res = await call({ summary: "ok", artifacts: [out] }, env(resultPath, [out]))
    if (res.kind === "tool_result") expect(res.is_error).toBeFalsy()
    expect(existsSync(resultPath)).toBe(true)
  })

  it("rejects deliverables over the total size cap", async () => {
    const resultPath = join(dir, "g.result.json")
    const out = join(dir, "big.md")
    const res = await call(
      { summary: "x", deliverables: [{ path: out, content: "a".repeat(3 * 1024 * 1024) }] },
      env(resultPath, [out]),
    )
    expect(res.kind === "tool_result" && res.is_error).toBe(true)
    expect(existsSync(out)).toBe(false)
  })
  it("refuses to write through a symlink at a contracted path (S4)", async () => {
    const resultPath = join(dir, "s.result.json")
    const outside = join(dir, "outside.md")
    writeFileSync(outside, "original")
    const link = join(dir, "link.md")
    symlinkSync(outside, link)
    const res = await call(
      { summary: "x", deliverables: [{ path: link, content: "overwrite" }] },
      env(resultPath, [link]),
    )
    expect(res.kind === "tool_result" && res.is_error).toBe(true)
    if (res.kind === "tool_result") expect(res.content).toMatch(/symlink/)
    expect(readFileSync(outside, "utf-8")).toBe("original")
    expect(existsSync(resultPath)).toBe(false)
  })

  it("counts a directory at a contracted path as missing (S2)", async () => {
    const resultPath = join(dir, "dir.result.json")
    const out = join(dir, "adir")
    mkdirSync(out)
    const res = await call({ summary: "x" }, env(resultPath, [out]))
    expect(res.kind === "tool_result" && res.is_error).toBe(true)
    expect(existsSync(resultPath)).toBe(false)
  })

  it("writes nothing and leaves no temp file when one of several files fails (W1, W2)", async () => {
    const resultPath = join(dir, "w.result.json")
    const good = join(dir, "good.md")
    const lockedDir = join(dir, "locked")
    mkdirSync(lockedDir)
    const bad = join(lockedDir, "bad.md")
    chmodSync(lockedDir, 0o500)
    try {
      const res = await call(
        {
          summary: "x",
          deliverables: [
            { path: good, content: "good" },
            { path: bad, content: "bad" },
          ],
        },
        env(resultPath, [good, bad]),
      )
      expect(res.kind === "tool_result" && res.is_error).toBe(true)
      if (res.kind === "tool_result") expect(res.content).toContain(bad)
      expect(existsSync(good)).toBe(false)
      expect(existsSync(resultPath)).toBe(false)
      expect(readdirSync(dir).filter((n) => n.includes(".tmp-"))).toEqual([])
      expect(readdirSync(lockedDir)).toEqual([])
    } finally {
      chmodSync(lockedDir, 0o700)
    }
  })

  it("leaves no temp file when the rename fails (W1)", async () => {
    const resultPath = join(dir, "r.result.json")
    const target = join(dir, "target.md")
    // A non-empty directory at the target makes rename(file, dir) fail.
    mkdirSync(target)
    writeFileSync(join(target, "keep"), "k")
    const res = await call(
      { summary: "x", deliverables: [{ path: target, content: "c" }] },
      env(resultPath, [target]),
    )
    expect(res.kind === "tool_result" && res.is_error).toBe(true)
    expect(readdirSync(dir).filter((n) => n.includes(".tmp-"))).toEqual([])
    expect(existsSync(resultPath)).toBe(false)
  })
  it("lists the files already renamed when a later rename fails (W2)", async () => {
    const resultPath = join(dir, "p.result.json")
    const first = join(dir, "first.md")
    const second = join(dir, "second.md")
    mkdirSync(second)
    writeFileSync(join(second, "keep"), "k")
    const res = await call(
      {
        summary: "x",
        deliverables: [
          { path: first, content: "1" },
          { path: second, content: "2" },
        ],
      },
      env(resultPath, [first, second]),
    )
    expect(res.kind === "tool_result" && res.is_error).toBe(true)
    if (res.kind === "tool_result") expect(res.content).toContain(`already written: ${first}`)
    expect(readdirSync(dir).filter((n) => n.includes(".tmp-"))).toEqual([])
    expect(existsSync(resultPath)).toBe(false)
  })
})
