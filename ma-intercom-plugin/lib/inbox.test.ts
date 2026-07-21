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
  return buildEnvelope({ from: FROM, to: "x", scope: "x", kind: "message", body })
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

  it("preserves large bodies well over PIPE_BUF without truncation", () => {
    const { dir, cleanup } = tmp()
    try {
      const path = join(dir, "inbox.jsonl")
      // 50k body >> PIPE_BUF (4096). Must round-trip intact now that append
      // is lock-serialized rather than size-clamped to atomic O_APPEND.
      const body = `plan\n${"x".repeat(50_000)}\nend`
      appendEnvelope(path, env(body))
      const all = readInbox(path)
      expect(all.length).toBe(1)
      expect(all[0]?.body).toBe(body)
      expect(all[0]?.body).not.toContain("truncated")
    } finally {
      cleanup()
    }
  })

  it("concurrent large-body appends stay whole JSONL lines (append lock)", async () => {
    // Real multi-process writers: single-thread Promise.all would not stress the
    // exclusive .appendlock. Each child writes a body >> PIPE_BUF so a torn line
    // would make parseInbox drop messages or mangle bodies.
    const { dir, cleanup } = tmp()
    try {
      const path = join(dir, "inbox.jsonl")
      const n = 12
      const bodyLen = 12_000
      const inboxMod = join(import.meta.dir, "inbox.ts")
      const envelopeMod = join(import.meta.dir, "envelope.ts")

      const exits = await Promise.all(
        Array.from({ length: n }, (_, i) => {
          const marker = `W${i}-`
          const code = `
import { appendEnvelope } from ${JSON.stringify(inboxMod)};
import { buildEnvelope } from ${JSON.stringify(envelopeMod)};
const body = ${JSON.stringify(marker)} + "x".repeat(${bodyLen});
const env = buildEnvelope({
  from: {
    sid: ${JSON.stringify(`s${i}`)},
    short: ${JSON.stringify(`s${String(i).padStart(6, "0")}`)},
    pid: ${i + 1},
    host: "h",
    cwd: "/",
    model: "m",
  },
  to: "x",
  scope: "x",
  kind: "message",
  body,
});
appendEnvelope(${JSON.stringify(path)}, env);
`
          return Bun.spawn(["bun", "-e", code], {
            stdout: "ignore",
            stderr: "pipe",
          }).exited
        }),
      )
      expect(exits.every((code) => code === 0)).toBe(true)

      const all = readInbox(path)
      expect(all.length).toBe(n)
      const markers = new Set(all.map((e) => e.body.slice(0, e.body.indexOf("-") + 1)))
      expect(markers.size).toBe(n)
      for (const e of all) {
        expect(e.body.length).toBe(bodyLen + e.body.indexOf("-") + 1)
        expect(e.body).toMatch(/^W\d+-x+$/)
        expect(e.body).not.toContain("truncated")
      }
    } finally {
      cleanup()
    }
  })
})
