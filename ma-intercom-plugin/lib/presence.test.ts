import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import {
  adaptSubagentRow,
  coercePresence,
  type PresenceRecord,
  parsePresence,
  phaseFromMtime,
  readPresenceDir,
  readPresenceFile,
  readSubagentPresenceDir,
  writePresence,
} from "./presence.ts"

function tmp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "intercom-presence-"))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const REC: PresenceRecord = {
  v: 1,
  sid: "aaaa-1",
  short: "aaaa-1".slice(0, 6),
  pid: 7,
  host: "h",
  ts: "2026-06-13T12:00:00.000Z",
  startedAt: "2026-06-13T11:00:00.000Z",
  agentVersion: "0.1.0",
  model: "m",
  cwd: "/c",
  projectRoot: "/c",
  phase: "active",
  activity: null,
}

describe("coercePresence", () => {
  it("requires sid + ts", () => {
    expect(coercePresence({ ts: "x" })).toBeNull()
    expect(coercePresence({ sid: "x" })).toBeNull()
    expect(coercePresence({ sid: "x", ts: "t" })).not.toBeNull()
  })

  it("defaults phase to active and clips activity to 100 chars", () => {
    const r = coercePresence({ sid: "s", ts: "t", phase: "weird", activity: "x".repeat(200) })
    expect(r?.phase).toBe("active")
    expect(r?.activity?.length).toBe(100)
  })

  it("parsePresence tolerates junk", () => {
    expect(parsePresence("not json")).toBeNull()
    expect(parsePresence("")).toBeNull()
  })

  it("carries an opt-in name (trimmed, capped) and omits it when blank/absent", () => {
    expect(coercePresence({ sid: "s", ts: "t", name: "  Laura  " })?.name).toBe("Laura")
    // absent ⇒ no key (byte-identical to pre-naming records)
    expect("name" in (coercePresence({ sid: "s", ts: "t" }) as object)).toBe(false)
    // blank ⇒ treated as absent
    expect("name" in (coercePresence({ sid: "s", ts: "t", name: "   " }) as object)).toBe(false)
    // capped at 48 chars
    expect(coercePresence({ sid: "s", ts: "t", name: "z".repeat(80) })?.name?.length).toBe(48)
  })
})

describe("phaseFromMtime", () => {
  it("busy when transcript touched within the window", () => {
    expect(phaseFromMtime(1_000, 5_000, 10_000)).toBe("busy")
  })
  it("idle when older than the window", () => {
    expect(phaseFromMtime(1_000, 50_000, 10_000)).toBe("idle")
  })
  it("idle when mtime unknown", () => {
    expect(phaseFromMtime(null, 50_000, 10_000)).toBe("idle")
  })
})

describe("write + read round-trip", () => {
  it("writes atomically and reads back", () => {
    const { dir, cleanup } = tmp()
    try {
      const path = join(dir, "aaaa-1.json")
      writePresence(path, REC)
      const back = readPresenceFile(path)
      expect(back?.sid).toBe("aaaa-1")
      expect(back?.pid).toBe(7)
    } finally {
      cleanup()
    }
  })

  it("readPresenceDir merges newest per sid and skips temp files", () => {
    const { dir, cleanup } = tmp()
    try {
      writePresence(join(dir, "a.json"), REC)
      writePresence(join(dir, "b.json"), { ...REC, sid: "bbbb-2", ts: "2026-06-13T12:05:00.000Z" })
      const recs = readPresenceDir(dir)
      expect(recs.length).toBe(2)
      expect(new Set(recs.map((r) => r.sid))).toEqual(new Set(["aaaa-1", "bbbb-2"]))
    } finally {
      cleanup()
    }
  })

  it("readPresenceDir returns empty for a missing dir", () => {
    expect(readPresenceDir(join(tmpdir(), "does-not-exist-intercom"))).toEqual([])
  })
})

describe("adaptSubagentRow (sub-agents feed interop)", () => {
  it("adapts an active worker row and stamps the local host (so the pid probe applies)", () => {
    const r = adaptSubagentRow(
      {
        sid: "w-1",
        role: "worker",
        status: "active",
        pid: 222,
        ts: "2026-06-13T12:00:00.000Z",
        model: "claude-opus-4-8",
        cwd: "/x",
        label: "explorer",
      },
      "my-host",
    )
    expect(r?.sid).toBe("w-1")
    expect(r?.phase).toBe("busy")
    expect(r?.activity).toContain("explorer")
    expect(r?.gone).toBeUndefined()
    // The feed has no host field; we stamp the reader's host so sameHost is true
    // in classifyLiveness and a crashed worker can be probed dead.
    expect(r?.host).toBe("my-host")
  })

  it("marks terminal statuses as gone", () => {
    const r = adaptSubagentRow(
      { sid: "w-2", status: "done", pid: 0, ts: "2026-06-13T12:00:00.000Z" },
      "my-host",
    )
    expect(r?.gone).toBe(true)
  })

  it("rejects rows without sid/ts", () => {
    expect(adaptSubagentRow({ status: "active" }, "my-host")).toBeNull()
  })

  it("rejects a path-traversal sid", () => {
    expect(
      adaptSubagentRow(
        { sid: "../../etc/evil", status: "active", pid: 1, ts: "2026-06-13T12:00:00.000Z" },
        "my-host",
      ),
    ).toBeNull()
  })

  it("readSubagentPresenceDir folds a multi-line lead file (latest per sid wins)", () => {
    const { dir, cleanup } = tmp()
    try {
      const lead = join(dir, "lead.jsonl")
      const l1 = JSON.stringify({
        sid: "w-9",
        status: "active",
        pid: 5,
        ts: "2026-06-13T12:00:00.000Z",
        label: "a",
      })
      const l2 = JSON.stringify({
        sid: "w-9",
        status: "done",
        pid: 0,
        ts: "2026-06-13T12:01:00.000Z",
        label: "a",
      })
      writeFileSync(lead, `${l1}\n${l2}\n`)
      const recs = readSubagentPresenceDir(dir)
      expect(recs.length).toBe(1)
      // the newer (done) row wins, so it's marked gone
      expect(recs[0]?.gone).toBe(true)
    } finally {
      cleanup()
    }
  })
})
