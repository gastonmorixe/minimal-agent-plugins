import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { buildEnvelope, type EnvelopeFrom } from "./envelope.ts"
import { appendEnvelope, drainFrom, drainInbox, readInbox } from "./inbox.ts"

const FROM: EnvelopeFrom = { sid: "s", short: "ssssss", pid: 1, host: "h", cwd: "/", model: "m" }

function tmp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "intercom-inbox-"))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function env(body: string) {
  return buildEnvelope({ from: FROM, to: "x", scope: "x", kind: "note", body })
}

describe("drainFrom (pure)", () => {
  it("returns everything at or after the mark and the next mark", () => {
    const list = [env("a"), env("b"), env("c")]
    const d = drainFrom(list, 1)
    expect(d.fresh.map((e) => e.body)).toEqual(["b", "c"])
    expect(d.nextMark).toBe(3)
    expect(d.total).toBe(3)
  })

  it("clamps a mark beyond the end to empty", () => {
    expect(drainFrom([env("a")], 5).fresh).toEqual([])
    expect(drainFrom([env("a")], 5).nextMark).toBe(1)
  })

  it("a zero mark drains everything", () => {
    expect(drainFrom([env("a"), env("b")], 0).fresh.length).toBe(2)
  })

  it("negative marks are treated as zero", () => {
    expect(drainFrom([env("a")], -3).fresh.length).toBe(1)
  })
})

describe("append + read + drainInbox (io)", () => {
  it("appends create the file and accumulate in order", () => {
    const { dir, cleanup } = tmp()
    try {
      const path = join(dir, "inbox.jsonl")
      appendEnvelope(path, env("first"))
      appendEnvelope(path, env("second"))
      const all = readInbox(path)
      expect(all.map((e) => e.body)).toEqual(["first", "second"])
    } finally {
      cleanup()
    }
  })

  it("readInbox is empty for a missing file", () => {
    const { dir, cleanup } = tmp()
    try {
      expect(readInbox(join(dir, "nope.jsonl"))).toEqual([])
    } finally {
      cleanup()
    }
  })

  it("drainInbox reads then yields only the tail past the mark", () => {
    const { dir, cleanup } = tmp()
    try {
      const path = join(dir, "inbox.jsonl")
      appendEnvelope(path, env("a"))
      appendEnvelope(path, env("b"))
      const first = drainInbox(path, 0)
      expect(first.fresh.length).toBe(2)
      appendEnvelope(path, env("c"))
      const second = drainInbox(path, first.nextMark)
      expect(second.fresh.map((e) => e.body)).toEqual(["c"])
    } finally {
      cleanup()
    }
  })
})
