import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { readPeerFleet, readPeerJobs, readPeerTasks, summarizeTasks } from "./sidecars.ts"

function tmp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "intercom-sidecar-"))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe("readPeerTasks", () => {
  it("parses the real tasks sidecar shape and tolerates junk", () => {
    const { dir, cleanup } = tmp()
    try {
      const sid = "sess-1"
      const lines = [
        JSON.stringify({
          v: 2,
          id: "a1",
          parent: null,
          status: "done",
          title: "first",
          created_at: "t",
        }),
        "garbage",
        JSON.stringify({
          v: 2,
          id: "a2",
          parent: null,
          status: "doing",
          title: "second",
          created_at: "t",
        }),
        JSON.stringify({ id: "a3", status: "bogus", title: "x" }), // invalid status
        JSON.stringify({ id: "a4", status: "todo" }), // no title
      ]
      writeFileSync(join(dir, `${sid}.tasks.jsonl`), `${lines.join("\n")}\n`)
      const tasks = readPeerTasks(dir, sid)
      expect(tasks.map((t) => t.id)).toEqual(["a1", "a2"])
      const s = summarizeTasks(tasks)
      expect(s.total).toBe(2)
      expect(s.done).toBe(1)
      expect(s.doing).toBe(1)
    } finally {
      cleanup()
    }
  })

  it("returns empty for a missing file", () => {
    const { dir, cleanup } = tmp()
    try {
      expect(readPeerTasks(dir, "nope")).toEqual([])
    } finally {
      cleanup()
    }
  })
})

describe("readPeerJobs", () => {
  it("parses the bgjobs status.kind + exitCode", () => {
    const { dir, cleanup } = tmp()
    try {
      const sid = "sess-2"
      const line = JSON.stringify({
        id: "j1",
        command: "bun test",
        description: "suite",
        status: { kind: "exited", exitCode: 0 },
      })
      writeFileSync(join(dir, `${sid}.bgjobs.jsonl`), `${line}\n`)
      const jobs = readPeerJobs(dir, sid)
      expect(jobs.length).toBe(1)
      expect(jobs[0]?.state).toBe("exited")
      expect(jobs[0]?.exitCode).toBe(0)
    } finally {
      cleanup()
    }
  })
})

describe("readPeerFleet", () => {
  it("parses the subagents shape and keeps the latest per id", () => {
    const { dir, cleanup } = tmp()
    try {
      const sid = "sess-3"
      const a1 = JSON.stringify({
        id: "A1",
        label: "rev",
        model: "claude-opus-4-8",
        status: { kind: "running" },
      })
      const a1done = JSON.stringify({
        id: "A1",
        label: "rev",
        model: "claude-opus-4-8",
        status: { kind: "done" },
      })
      writeFileSync(join(dir, `${sid}.subagents.jsonl`), `${a1}\n${a1done}\n`)
      const fleet = readPeerFleet(dir, sid)
      expect(fleet.length).toBe(1)
      expect(fleet[0]?.id).toBe("A1")
      expect(fleet[0]?.state).toBe("done")
    } finally {
      cleanup()
    }
  })
})
