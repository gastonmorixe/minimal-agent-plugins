import { describe, expect, it } from "bun:test"

import { type BeatDeps, buildSelfPresenceRecord, runBeat, wakeMessage } from "./beat.ts"
import type { Thresholds } from "./config.ts"
import { type Cursor, ZERO_CURSOR } from "./cursors.ts"
import { buildEnvelope, type Envelope, type EnvelopeFrom } from "./envelope.ts"
import type { SelfIdentity } from "./identity.ts"
import type { PresenceRecord } from "./presence.ts"

const TH: Thresholds = { heartbeatMs: 5_000, freshMs: 20_000, staleMs: 90_000 }
const NOW = Date.parse("2026-06-13T12:00:00.000Z")
const SELF: SelfIdentity = {
  sid: "self-1",
  short: "self-1".slice(0, 6),
  pid: 10,
  host: "h",
  model: "m",
  agentVersion: "0.1.0",
}
const PEER_FROM: EnvelopeFrom = {
  sid: "peer-2",
  short: "peer-2".slice(0, 6),
  pid: 20,
  host: "h",
  cwd: "/p",
  model: "m",
}

function msg(kind: Envelope["kind"], body: string): Envelope {
  return buildEnvelope({ from: PEER_FROM, to: SELF.sid, scope: SELF.sid, kind, body, nowMs: NOW })
}

/** Build BeatDeps with capturing fakes. */
function harness(opts: { inbox?: Envelope[]; cursor?: Cursor; presence?: PresenceRecord[] }) {
  const published: PresenceRecord[] = []
  const injected: { channel: string; payload: unknown }[] = []
  let written: Cursor | null = null
  const deps: BeatDeps = {
    self: SELF,
    state: { phase: "busy", activity: "doing x", cwd: "/work", projectRoot: "/work" },
    startedAt: new Date(NOW - 60_000).toISOString(),
    nowMs: NOW,
    thresholds: TH,
    probe: { now: NOW, pidAlive: () => true, host: "h" },
    publish: (rec) => published.push(rec),
    readAllPresence: () => opts.presence ?? [],
    readMyInbox: () => opts.inbox ?? [],
    readMyCursor: () => opts.cursor ?? ZERO_CURSOR,
    writeMyCursor: (c) => {
      written = c
    },
    emit: (channel, payload) => injected.push({ channel, payload }),
  }
  return {
    deps,
    published,
    injected,
    get written() {
      return written
    },
  }
}

describe("buildSelfPresenceRecord", () => {
  it("captures identity + state + timestamps", () => {
    const rec = buildSelfPresenceRecord(
      SELF,
      { phase: "busy", activity: "x", cwd: "/w", projectRoot: "/w" },
      "started",
      "now",
    )
    expect(rec.sid).toBe("self-1")
    expect(rec.pid).toBe(10)
    expect(rec.phase).toBe("busy")
    expect(rec.ts).toBe("now")
    expect(rec.startedAt).toBe("started")
  })
})

describe("runBeat — presence publish", () => {
  it("always publishes my presence record", () => {
    const h = harness({})
    runBeat(h.deps)
    expect(h.published.length).toBe(1)
    expect(h.published[0]?.sid).toBe("self-1")
  })
})

describe("runBeat — wake channel", () => {
  it("injects prompt.inject when a ping arrives past the woken cursor", () => {
    const h = harness({ inbox: [msg("ping", "hello")] })
    const res = runBeat(h.deps)
    expect(res.woke).toBe(1)
    expect(h.injected.length).toBe(1)
    expect(h.injected[0]?.channel).toBe("prompt.inject")
    const payload = h.injected[0]?.payload as { text: string; source: string }
    expect(payload.source).toBe("intercom")
    expect(payload.text).toContain("ping")
    // advances woken to the full inbox length
    expect(h.written).toEqual({ seen: 0, woken: 1, read: 0 })
  })

  it("injects for an interrupt and surfaces it in the text", () => {
    const h = harness({ inbox: [msg("interrupt", "stop now")] })
    const res = runBeat(h.deps)
    expect(res.woke).toBe(1)
    const payload = h.injected[0]?.payload as { text: string }
    expect(payload.text).toContain("interrupt")
    expect(payload.text).toContain("stop now")
  })

  it("does NOT wake for a note (passive delivery only)", () => {
    const h = harness({ inbox: [msg("note", "fyi")] })
    const res = runBeat(h.deps)
    expect(res.woke).toBe(0)
    expect(h.injected.length).toBe(0)
    // but still advances woken past the note so it never wakes later
    expect(h.written).toEqual({ seen: 0, woken: 1, read: 0 })
  })

  it("does not re-wake for messages already past the woken cursor", () => {
    const h = harness({ inbox: [msg("ping", "old")], cursor: { seen: 1, woken: 1, read: 0 } })
    const res = runBeat(h.deps)
    expect(res.woke).toBe(0)
    expect(h.injected.length).toBe(0)
  })

  it("wakes only for the fresh ping when a note precedes it", () => {
    const h = harness({ inbox: [msg("note", "a"), msg("ping", "b")], cursor: ZERO_CURSOR })
    const res = runBeat(h.deps)
    expect(res.woke).toBe(1)
    const payload = h.injected[0]?.payload as { text: string }
    expect(payload.text).toContain("ping")
  })
})

describe("wakeMessage", () => {
  it("leads with interrupts when present", () => {
    const text = wakeMessage([msg("ping", "p"), msg("interrupt", "i")])
    expect(text.startsWith("intercom: 1 interrupt")).toBe(true)
  })
  it("points at the inbox attachment and names the sender, without forging the tag", () => {
    const text = wakeMessage([msg("ping", "p")])
    expect(text).toContain("intercom-inbox attachment")
    // It must NOT contain a live `<ma::` framing sequence (that would let a peer
    // forge runtime framing into the woken session's injected prompt).
    expect(text).not.toContain("<ma::")
    expect(text).toContain("peer-2".slice(0, 6))
  })
})
