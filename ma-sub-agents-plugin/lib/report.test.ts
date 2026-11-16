/**
 * Tests for the pure `ReportResult` core: validating the model's input and
 * building the exact sentinel digest the handler persists.
 *
 * @module sub-agents/lib/report.test
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import {
  buildDigest,
  checkDeliverables,
  isContractedFilePresent,
  parseContract,
  parseReportRequest,
  serializeDigest,
} from "./report.ts"
import { parseResultDigest } from "./spawn.ts"

describe("parseReportRequest", () => {
  it("requires a non-empty summary", () => {
    const r = parseReportRequest({})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/summary/i)
  })

  it("accepts summary + artifacts + incomplete and trims", () => {
    const r = parseReportRequest({
      summary: "  found the bug in parser.ts  ",
      artifacts: ["/a.md", "  /b.md  ", "", 7],
      incomplete: true,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.summary).toBe("found the bug in parser.ts")
    expect(r.value.artifacts).toEqual(["/a.md", "/b.md"])
    expect(r.value.incomplete).toBe(true)
  })

  it("accepts natural aliases for summary (short/result/findings)", () => {
    expect(parseReportRequest({ short: "x" }).ok).toBe(true)
    expect(parseReportRequest({ result: "x" }).ok).toBe(true)
    expect(parseReportRequest({ findings: "x" }).ok).toBe(true)
  })

  it("omits artifacts when none are valid; defaults incomplete to false", () => {
    const r = parseReportRequest({ summary: "ok", artifacts: [] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.artifacts).toBeUndefined()
    expect(r.value.incomplete).toBeUndefined()
  })
})

describe("buildDigest", () => {
  it("builds a digest whose short carries the findings and artifacts", () => {
    const d = buildDigest({ summary: "the synthesis", artifacts: ["/x.md"], tokens: 10, tools: 3 })
    expect(d.short).toBe("the synthesis")
    expect(d.artifacts).toEqual(["/x.md"])
    expect(d.tokens).toBe(10)
    expect(d.tools).toBe(3)
  })

  it("prefixes INCOMPLETE: AND sets the structured incomplete flag", () => {
    const d = buildDigest({ summary: "got halfway", incomplete: true })
    expect(d.short).toBe("INCOMPLETE: got halfway")
    expect(d.incomplete).toBe(true)
    expect(d.tokens).toBe(0)
  })

  it("leaves incomplete unset for a normal (finished) report", () => {
    const d = buildDigest({ summary: "all done" })
    expect(d.incomplete).toBeUndefined()
  })

  it("round-trips through the SAME parser the supervisor probe uses", () => {
    // The handler serializes a digest; the probe's readResult parses it back.
    // They must agree, or a tool-reported result would not be readable.
    const d = buildDigest({ summary: "done it", artifacts: ["/r.md"], tokens: 5, tools: 2 })
    const json = serializeDigest(d)
    const reparsed = parseResultDigest(JSON.parse(json))
    expect(reparsed).toEqual(d)
  })

  it("round-trips the incomplete flag so the supervisor sees it", () => {
    const d = buildDigest({ summary: "blocked on auth", incomplete: true })
    const reparsed = parseResultDigest(JSON.parse(serializeDigest(d)))
    expect(reparsed?.incomplete).toBe(true)
  })
})

describe("parseReportRequest: deliverables", () => {
  it("parses deliverables and trims the path", () => {
    const r = parseReportRequest({
      summary: "s",
      deliverables: [
        { path: "/a.md", content: "A" },
        { path: " /b.md ", content: "B" },
      ],
    })
    expect(r.ok).toBe(true)
    if (r.ok)
      expect(r.value.deliverables).toEqual([
        { path: "/a.md", content: "A" },
        { path: "/b.md", content: "B" },
      ])
  })

  it("does not accept file_path: the schema has only path (S1)", () => {
    const r = parseReportRequest({
      summary: "s",
      deliverables: [{ file_path: "/b.md", content: "B" }],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/path/)
  })

  it("rejects empty content", () => {
    const r = parseReportRequest({ summary: "s", deliverables: [{ path: "/a.md", content: "  " }] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/content/)
  })

  it("rejects a missing path", () => {
    const r = parseReportRequest({ summary: "s", deliverables: [{ content: "x" }] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/path/)
  })

  it("rejects a non-array", () => {
    const r = parseReportRequest({ summary: "s", deliverables: { path: "/a.md", content: "x" } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/array/)
  })

  it("rejects a total over the size cap", () => {
    const big = "a".repeat(2 * 1024 * 1024 + 1)
    const r = parseReportRequest({ summary: "s", deliverables: [{ path: "/a.md", content: big }] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/limit/)
  })

  it("omits deliverables when absent or empty", () => {
    const r = parseReportRequest({ summary: "s", deliverables: [] })
    expect(r.ok && "deliverables" in r.value).toBe(false)
  })
})

describe("parseContract / checkDeliverables", () => {
  it("parses a JSON array, resolves, dedupes, drops relative and junk", () => {
    expect(parseContract(JSON.stringify(["/x/a.md", "/x/./a.md", "rel.md", 3, "/y.md"]))).toEqual([
      "/x/a.md",
      "/y.md",
    ])
    expect(parseContract(undefined)).toEqual([])
    expect(parseContract("not json")).toEqual([])
  })

  it("allows contracted paths and refuses others with the allowed list", () => {
    expect(checkDeliverables([{ path: "/x/../a.md", content: "c" }], ["/a.md"]).ok).toBe(true)
    const bad = checkDeliverables([{ path: "/b.md", content: "c" }], ["/a.md"])
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain("/a.md")
    expect(checkDeliverables([{ path: "/a.md", content: "c" }], []).ok).toBe(false)
  })
  it("the no-contract error names an older plugin and the incomplete fallback (H)", () => {
    const r = checkDeliverables([{ path: "/a.md", content: "c" }], [])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain("the lead may run an older sub-agents plugin")
      expect(r.error).toContain("set incomplete:true and put the content in summary")
    }
  })

  it("allows a `..` path only when it resolves to a contracted path (S4)", () => {
    expect(checkDeliverables([{ path: "/x/../a.md", content: "c" }], ["/a.md"]).ok).toBe(true)
    const r = checkDeliverables([{ path: "/x/a/../b.md", content: "c" }], ["/x/a/b.md"])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("/x/a/b.md")
  })

  it("refuses a path with a trailing slash: it names a directory, not a file (S4)", () => {
    const r = checkDeliverables([{ path: "/x/a.md/", content: "c" }], ["/x/a.md"])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/trailing slash/)
  })

  it("refuses duplicate deliverable paths with a teaching error (S4)", () => {
    const r = checkDeliverables(
      [
        { path: "/x/a.md", content: "one" },
        { path: "/x/./a.md", content: "two" },
      ],
      ["/x/a.md"],
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/more than once/)
      expect(r.error).toContain("/x/a.md")
    }
  })
})

describe("isContractedFilePresent (S2)", () => {
  it("is true only for a regular file with size > 0", () => {
    const d = mkdtempSync(join(tmpdir(), "present-"))
    try {
      const full = join(d, "full.md")
      const empty = join(d, "empty.md")
      const sub = join(d, "sub")
      writeFileSync(full, "x")
      writeFileSync(empty, "")
      mkdirSync(sub)
      expect(isContractedFilePresent(full)).toBe(true)
      expect(isContractedFilePresent(empty)).toBe(false)
      expect(isContractedFilePresent(sub)).toBe(false)
      expect(isContractedFilePresent(join(d, "none.md"))).toBe(false)
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })
})
