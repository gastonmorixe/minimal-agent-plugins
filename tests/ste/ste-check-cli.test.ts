/**
 * The `ste-check.ts` command line, run as a process.
 *
 * REVIEW-C2 N0: `--strict` counted only baseline entries. Every rule is
 * zero-tolerance, so a zero-tolerance finding never became an entry, and
 * `--strict` printed "Findings: 0" and exited 0 while it listed a finding.
 *
 * @module tests/ste/ste-check-cli
 */

import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "ste-check.ts")

/** Run `ste-check.ts --dir <root>` on a temp plugins folder with one PROMPT.md. */
function runOn(prompt: string): { status: number | null; out: string } {
  const root = mkdtempSync(join(tmpdir(), "ste-cli-"))
  try {
    const plugin = join(root, "ma-zz-plugin")
    mkdirSync(plugin)
    writeFileSync(join(plugin, "manifest.json"), JSON.stringify({ name: "ma-zz-plugin" }))
    writeFileSync(join(plugin, "PROMPT.md"), prompt)
    const env = { ...process.env }
    delete env.DEBUG
    delete env.VERBOSE
    const res = spawnSync("bun", ["run", SCRIPT, "--dir", root], { encoding: "utf8", env })
    return { status: res.status, out: `${res.stdout}${res.stderr}` }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe("ste-check.ts --dir counts zero-tolerance findings (REVIEW-C2 N0)", () => {
  test("a zero-tolerance finding gives a non-zero count and exit 1", () => {
    // s2 (semicolon) and s6 (contraction) are zero-tolerance.
    const { status, out } = runOn("Read the file; don't stop.\n")
    expect(out).toMatch(/Findings: [1-9]/)
    expect(out).toContain("ste-s2-semicolon")
    expect(status).toBe(1)
  })

  test("clean text gives 0 and exit 0", () => {
    const { status, out } = runOn("Read the file. Do not stop.\n")
    expect(out).toContain("Findings: 0")
    expect(status).toBe(0)
  })
})
