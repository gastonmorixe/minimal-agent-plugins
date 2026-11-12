/**
 * Golden bytes for every prompt this plugin sends to a worker. The fixtures
 * were captured from the private engine before the move to `ctx.prompts`.
 * They must never change when the engine changes.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { getLibrary } from "./library.ts"
import { testRender } from "./prompt-test-render.ts"
import { leafDiscipline, renderResultProtocol } from "./prompts.ts"

const FIXTURES = join(import.meta.dir, "__fixtures__", "prompt-bytes")
const RESULT_PATH = "/sessions/fixed-sid.result.json"

function fixture(name: string): Buffer {
  const bytes = readFileSync(join(FIXTURES, name))
  expect(bytes.length).toBeGreaterThan(0)
  return bytes
}

describe("prompt bytes", () => {
  it("result protocol is byte identical", () => {
    const actual = Buffer.from(renderResultProtocol(testRender, RESULT_PATH), "utf-8")
    expect(actual.equals(fixture("result-protocol.txt"))).toBe(true)
  })

  it("leaf discipline is byte identical", () => {
    const actual = Buffer.from(leafDiscipline(testRender), "utf-8")
    expect(actual.equals(fixture("leaf-discipline.txt"))).toBe(true)
  })

  it("library definitions are byte identical", () => {
    const actual = Buffer.from(JSON.stringify(getLibrary(testRender), null, 2), "utf-8")
    expect(actual.equals(fixture("library.json.txt"))).toBe(true)
  })
})
