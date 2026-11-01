/**
 * Guard: every `@minimal-agent/core` reference uses one full SHA.
 *
 * The root package.json pin is the source of truth. Every package.json dep
 * field and every bun.lock entry must use the same 40-char SHA. Use
 * `bun run pin:core` to fix drift.
 */

import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import {
  CORE_URL,
  collectPins,
  pinProblems,
  pinsInBunLock,
  pinsInPackageJson,
  repinText,
  rootPin,
} from "./core-pin.ts"

const REPO_ROOT = join(import.meta.dir, "..")
const A = "a".repeat(40)
const B = "b".repeat(40)

function pkg(field: string, ref: string): string {
  return `${JSON.stringify({ name: "x", [field]: { "@minimal-agent/core": `${CORE_URL}#${ref}` } }, null, 2)}\n`
}

describe("core pin (one SHA everywhere)", () => {
  test("root pin is a full SHA", () => {
    expect(rootPin(REPO_ROOT)).toMatch(/^[0-9a-f]{40}$/)
  })

  test("every package.json and bun.lock entry matches the root pin", () => {
    const pins = collectPins(REPO_ROOT)
    expect(pins.length).toBeGreaterThan(1)
    expect(pinProblems(pins, rootPin(REPO_ROOT))).toEqual([])
  })

  test("negative control: one stale package fails", () => {
    const pins = [
      ...pinsInPackageJson("package.json", pkg("dependencies", A)),
      ...pinsInPackageJson("ma-x-plugin/package.json", pkg("peerDependencies", B)),
    ]
    expect(pinProblems(pins, A)).toEqual([
      `ma-x-plugin/package.json peerDependencies: ${B} != ${A}`,
    ])
  })

  test("negative control: a short ref or a branch name fails", () => {
    const pins = [
      ...pinsInPackageJson("a/package.json", pkg("devDependencies", "a24be3a")),
      ...pinsInPackageJson("b/package.json", pkg("dependencies", "main")),
    ]
    expect(pinProblems(pins, A)).toHaveLength(2)
  })

  test("negative control: a stale bun.lock entry fails", () => {
    const lock = [
      `      "peerDependencies": {`,
      `        "@minimal-agent/core": "${CORE_URL}#${B}",`,
      `      },`,
      `    "@minimal-agent/core": ["@minimal-agent/core@${CORE_URL}#${A}", {}, "${B}"],`,
    ].join("\n")
    const pins = pinsInBunLock("bun.lock", lock)
    expect(pins).toHaveLength(3)
    expect(pinProblems(pins, A)).toEqual([
      `bun.lock line 2: ${B} != ${A}`,
      `bun.lock line 4 (resolved): ${B} != ${A}`,
    ])
  })

  test("repinText changes only the core ref", () => {
    const text = pkg("peerDependencies", B)
    expect(repinText(text, A)).toBe(text.replace(B, A))
  })
})
