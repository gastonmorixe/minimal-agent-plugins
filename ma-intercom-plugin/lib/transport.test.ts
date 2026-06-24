import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import type { Thresholds } from "./config.ts"
import { buildEnvelope, type Envelope } from "./envelope.ts"
import { appendEnvelope, readInbox } from "./inbox.ts"
import { classifyLiveness } from "./liveness.ts"
import { inboxPath, presenceDir, presencePath } from "./paths.ts"
import { type PresenceRecord, readPresenceDir, writePresence } from "./presence.ts"
import {
  buildTransport,
  CompositeTransport,
  type LocalFsIo,
  LocalFsTransport,
  type Transport,
} from "./transport.ts"

function tmp(): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "intercom-transport-"))
  return { env: { MINIMAL_AGENT_HOME: dir }, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function rec(overrides: Partial<PresenceRecord> = {}): PresenceRecord {
  return {
    v: 1,
    sid: "aaaaaaaa-1",
    short: "aaaaaaaa",
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
    ...overrides,
  }
}

/** Build the local transport bound to a temp home, the way the service does. */
function localFor(env: NodeJS.ProcessEnv, sid: string): LocalFsTransport {
  const io: LocalFsIo = {
    presencePath: (s) => presencePath(s, env),
    presenceDir: () => presenceDir(env),
    inboxPath: (s) => inboxPath(s, env),
    writePresence,
    readPresenceDir,
    appendEnvelope,
    readInbox,
  }
  return new LocalFsTransport(io, sid)
}

const env0 = (s: string): Envelope =>
  buildEnvelope({
    from: { sid: s, short: s.slice(0, 8), pid: 1, host: "h", cwd: "/c", model: "m" },
    to: "bbbbbbbb-2",
    scope: "bbbbbbbb-2",
    kind: "message",
    body: "hi",
    nowMs: Date.parse("2026-06-13T12:00:00.000Z"),
  })

describe("LocalFsTransport — byte-identical to direct fs (wire format frozen)", () => {
  it("publishPresence writes the SAME bytes as a direct writePresence", () => {
    const a = tmp()
    const b = tmp()
    try {
      const r = rec()
      // via transport
      localFor(a.env, r.sid).publishPresence(r)
      // via direct call
      writePresence(presencePath(r.sid, b.env), r)
      const viaTransport = readFileSync(presencePath(r.sid, a.env), "utf-8")
      const viaDirect = readFileSync(presencePath(r.sid, b.env), "utf-8")
      expect(viaTransport).toBe(viaDirect)
    } finally {
      a.cleanup()
      b.cleanup()
    }
  })

  it("deliver appends the SAME bytes as a direct appendEnvelope", () => {
    const a = tmp()
    const b = tmp()
    try {
      const e = env0("aaaaaaaa-1")
      localFor(a.env, "aaaaaaaa-1").deliver("bbbbbbbb-2", e)
      appendEnvelope(inboxPath("bbbbbbbb-2", b.env), e)
      expect(readFileSync(inboxPath("bbbbbbbb-2", a.env), "utf-8")).toBe(
        readFileSync(inboxPath("bbbbbbbb-2", b.env), "utf-8"),
      )
    } finally {
      a.cleanup()
      b.cleanup()
    }
  })

  it("round-trips presence + inbox through the port", () => {
    const t = tmp()
    try {
      const tr = localFor(t.env, "aaaaaaaa-1")
      tr.publishPresence(rec())
      tr.deliver("bbbbbbbb-2", env0("aaaaaaaa-1"))
      expect(tr.readPresence().map((r) => r.sid)).toEqual(["aaaaaaaa-1"])
      expect(tr.readInbox("bbbbbbbb-2").map((e) => e.body)).toEqual(["hi"])
      expect(tr.remote).toBe(false)
    } finally {
      t.cleanup()
    }
  })

  it("a written local presence record carries NO origin key (format unchanged)", () => {
    const t = tmp()
    try {
      localFor(t.env, "aaaaaaaa-1").publishPresence(rec())
      const raw = readFileSync(presencePath("aaaaaaaa-1", t.env), "utf-8")
      expect(raw).not.toContain("origin")
    } finally {
      t.cleanup()
    }
  })
})

/** An in-memory fake transport, for Composite tests without disk. */
class FakeTransport implements Transport {
  presence: PresenceRecord[] = []
  delivered: { to: string; env: Envelope }[] = []
  constructor(
    readonly id: string,
    readonly remote: boolean,
    seed: PresenceRecord[] = [],
  ) {
    this.presence = seed
  }
  publishPresence(r: PresenceRecord) {
    this.presence = [...this.presence.filter((p) => p.sid !== r.sid), r]
  }
  readPresence() {
    return this.presence
  }
  deliver(to: string, env: Envelope) {
    this.delivered.push({ to, env })
  }
  readInbox() {
    return []
  }
}

describe("CompositeTransport — merge local + remote", () => {
  it("remote flips true when any child is remote", () => {
    expect(new CompositeTransport([new FakeTransport("l", false)]).remote).toBe(false)
    expect(
      new CompositeTransport([new FakeTransport("l", false), new FakeTransport("c", true)]).remote,
    ).toBe(true)
  })

  it("readPresence merges children, newest beat per sid wins", () => {
    const local = new FakeTransport("l", false, [rec({ sid: "x", ts: "2026-06-13T12:00:00.000Z" })])
    const remote = new FakeTransport("c", true, [
      rec({ sid: "x", ts: "2026-06-13T12:05:00.000Z", origin: "remote" }),
      rec({ sid: "y", origin: "remote" }),
    ])
    const merged = new CompositeTransport([local, remote]).readPresence()
    const x = merged.find((r) => r.sid === "x")
    expect(merged.map((r) => r.sid).sort()).toEqual(["x", "y"])
    expect(x?.ts).toBe("2026-06-13T12:05:00.000Z") // newer (remote) wins
  })

  it("deliver fans to every child; a throwing child never stops the others", () => {
    const good = new FakeTransport("l", false)
    const bad: Transport = {
      id: "bad",
      remote: true,
      publishPresence() {},
      readPresence() {
        throw new Error("down")
      },
      deliver() {
        throw new Error("down")
      },
      readInbox() {
        return []
      },
    }
    const comp = new CompositeTransport([bad, good])
    comp.deliver("z", env0("aaaaaaaa-1"))
    expect(good.delivered.map((d) => d.to)).toEqual(["z"]) // good still delivered
    expect(comp.readPresence()).toEqual([]) // bad source skipped, no throw
  })
})

describe("buildTransport", () => {
  it("returns the local transport unchanged when there are no remotes", () => {
    const local = new FakeTransport("l", false)
    expect(buildTransport(local)).toBe(local)
  })
  it("wraps in a Composite when remotes exist", () => {
    const out = buildTransport(new FakeTransport("l", false), [new FakeTransport("c", true)])
    expect(out).toBeInstanceOf(CompositeTransport)
    expect(out.remote).toBe(true)
  })
})

describe("liveness Strategy by origin", () => {
  const TH: Thresholds = { heartbeatMs: 5_000, freshMs: 20_000, staleMs: 90_000 }
  const NOW = Date.parse("2026-06-13T12:00:00.000Z")

  it("remote record: fresh relay ⇒ online WITHOUT a pid probe (kills the sameHost blocker)", () => {
    // host mismatch + pid reported dead: a LOCAL record would be 'stale' (can't
    // probe cross-host). A remote record trusts the backend relay ⇒ online.
    const l = classifyLiveness(rec({ origin: "remote", host: "other" }), TH, {
      now: NOW + 45_000, // stale band for local, but remote keys on freshness only
      pidAlive: () => false,
      host: "h",
    })
    expect(l.status).toBe("online")
  })

  it("remote record: relay went quiet past stale ⇒ offline", () => {
    const l = classifyLiveness(rec({ origin: "remote" }), TH, {
      now: NOW + 120_000,
      host: "h",
    })
    expect(l.status).toBe("offline")
  })

  it("remote record: gone marker ⇒ offline (clean disconnect)", () => {
    const l = classifyLiveness(rec({ origin: "remote", gone: true }), TH, { now: NOW, host: "h" })
    expect(l.status).toBe("offline")
  })

  it("local record (no origin) is unchanged: cross-host stale", () => {
    const l = classifyLiveness(rec({ host: "other" }), TH, {
      now: NOW + 45_000,
      pidAlive: () => true,
      host: "h",
    })
    expect(l.status).toBe("stale")
  })
})
