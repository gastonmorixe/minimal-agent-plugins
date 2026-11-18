/**
 * SPEC v6.1 D8 rule 4: the request after resume is the same with and without
 * a stored `outcome` on the tool_result record. The scenarios are in
 * scenarios-extra.ts (`resume-old-tool-results`, `resume-new-tool-results`,
 * `resume-tool-result`).
 */

import { readFileSync } from "node:fs"

import { describe, expect, test } from "bun:test"

import { goldenPath } from "./harness.ts"

const read = (name: string) => readFileSync(goldenPath(name), "utf8")
/** Only the scenario name differs. */
const norm = (text: string, name: string) =>
  text.replace(`"scenario": "${name}"`, '"scenario": "X"')

describe("resume tool_result goldens (D8 rule 4)", () => {
  test("old and new tool_result twins give byte equal resumed requests", () => {
    const a = read("resume-old-tool-results")
    const b = read("resume-new-tool-results")
    expect(norm(b, "resume-new-tool-results")).toBe(norm(a, "resume-old-tool-results"))
  })

  test("the twins equal the live resume-tool-result request", () => {
    const a = read("resume-old-tool-results")
    const live = read("resume-tool-result")
    expect(norm(a, "resume-old-tool-results")).toBe(norm(live, "resume-tool-result"))
  })

  test("the resumed request holds the tool_result from the stored record", () => {
    const golden = JSON.parse(read("resume-new-tool-results")) as {
      requests: Array<{ messages: Array<{ content: unknown }> }>
    }
    expect(golden.requests).toHaveLength(1)
    const blocks = golden.requests[0]?.messages.flatMap((m) =>
      Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : [],
    )
    const results = (blocks ?? []).filter((b) => b.type === "tool_result")
    expect(results).toHaveLength(1)
    expect(JSON.stringify(results[0]?.content)).toContain("one\\ntwo")
    expect(results[0]).not.toHaveProperty("outcome")
  })
})
