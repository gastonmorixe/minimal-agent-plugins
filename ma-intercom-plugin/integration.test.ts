/**
 * Cross-session integration test: simulate two independent sessions sharing one
 * relocated `MINIMAL_AGENT_HOME`, and assert the end-to-end behaviors that make
 * intercom work — presence discovery, derived liveness, message delivery
 * (note/ping), and the wake channel — through the real filesystem layer.
 *
 * @module integration.test
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { type BeatDeps, runBeat } from "./lib/beat.ts"
import { resolveThresholds } from "./lib/config.ts"
import { readCursor, writeCursor } from "./lib/cursors.ts"
import type { SelfIdentity } from "./lib/identity.ts"
import { drainInbox } from "./lib/inbox.ts"
import {
  cursorPath,
  inboxPath,
  presenceDir,
  presencePath,
  subagentsPresenceDir,
} from "./lib/paths.ts"
import { readPresenceDir, readSubagentPresenceDir, writePresence } from "./lib/presence.ts"
import { mergePresence } from "./lib/roster.ts"
import { loadRoster, type ServiceDeps, send } from "./lib/service.ts"

let home: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "intercom-e2e-"))
  env = { MINIMAL_AGENT_HOME: home }
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

const HOST = "test-host"

function ident(sid: string, pid: number): SelfIdentity {
  return { sid, short: sid.slice(0, 6), pid, host: HOST, model: "m", agentVersion: "0.1.0" }
}

/** A beat harness for one session against the shared temp home. */
function beatFor(
  self: SelfIdentity,
  nowMs: number,
  aliveByPid: (pid: number) => boolean,
): BeatDeps {
  return {
    self,
    state: {
      phase: "idle",
      activity: null,
      cwd: `/work/${self.short}`,
      projectRoot: `/work/${self.short}`,
    },
    startedAt: new Date(nowMs - 60_000).toISOString(),
    nowMs,
    thresholds: resolveThresholds(env),
    probe: { now: nowMs, pidAlive: aliveByPid, host: HOST },
    publish: (rec) => writePresence(presencePath(self.sid, env), rec),
    readAllPresence: () =>
      mergePresence(
        readPresenceDir(presenceDir(env)),
        readSubagentPresenceDir(subagentsPresenceDir(env)),
      ),
    readMyInbox: () => drainInbox(inboxPath(self.sid, env), 0).fresh,
    readMyCursor: () => readCursor(cursorPath(self.sid, env)),
    writeMyCursor: (c) => writeCursor(cursorPath(self.sid, env), c),
    emit: () => {},
  }
}

/** Build ServiceDeps for a session against the shared temp home. */
function svc(self: SelfIdentity, nowMs: number, alive: (pid: number) => boolean): ServiceDeps {
  return {
    env,
    self,
    thresholds: resolveThresholds(env),
    now: () => nowMs,
    host: HOST,
    pidAlive: alive,
  }
}

describe("two sessions discover each other", () => {
  it("after both beat, each sees the other in the roster", () => {
    const a = ident("aaaaaaaa-1", 1001)
    const b = ident("bbbbbbbb-2", 1002)
    const now = Date.now()
    const alive = (pid: number) => pid === 1001 || pid === 1002

    runBeat(beatFor(a, now, alive))
    runBeat(beatFor(b, now, alive))

    const rosterFromA = loadRoster(svc(a, now + 1000, alive), { excludeSelf: true })
    expect(rosterFromA.map((r) => r.record.sid)).toContain("bbbbbbbb-2")
    expect(rosterFromA[0]?.liveness.status).toBe("online")
  })
})

describe("a session that dies is derived dead (no clean exit)", () => {
  it("stops beating + pid gone ⇒ peer classifies it dead past the stale window", () => {
    const a = ident("aaaaaaaa-1", 2001)
    const dead = ident("dddddddd-9", 2009)
    const t0 = Date.now()

    // Both beat once at t0; the doomed one never beats again and its pid dies.
    runBeat(beatFor(a, t0, () => true))
    runBeat(beatFor(dead, t0, () => true))

    // Long after the stale threshold, from A's view, with dead's pid gone.
    const later = t0 + 200_000
    const alive = (pid: number) => pid === 2001 // dead's pid 2009 is gone
    const roster = loadRoster(svc(a, later, alive), { excludeSelf: true })
    const deadRow = roster.find((r) => r.record.sid === "dddddddd-9")
    expect(deadRow?.liveness.status).toBe("dead")
  })

  it("stops beating but pid still alive ⇒ hung, not falsely online", () => {
    const a = ident("aaaaaaaa-1", 3001)
    const stuck = ident("ssssssss-8", 3008)
    const t0 = Date.now()
    runBeat(beatFor(stuck, t0, () => true))

    const later = t0 + 200_000
    const alive = () => true // stuck's pid is still around (wedged process)
    const roster = loadRoster(svc(a, later, alive), { excludeSelf: false })
    expect(roster.find((r) => r.record.sid === "ssssssss-8")?.liveness.status).toBe("hung")
  })
})

describe("message delivery between sessions", () => {
  it("a note from A lands in B's inbox and is drained once", () => {
    const a = ident("aaaaaaaa-1", 4001)
    const b = ident("bbbbbbbb-2", 4002)
    const now = Date.now()
    const alive = (pid: number) => pid === 4001 || pid === 4002

    // Both present so addressing resolves.
    runBeat(beatFor(a, now, alive))
    runBeat(beatFor(b, now, alive))

    const outcome = send(svc(a, now, alive), { to: "bbbbbb", body: "hello B", kind: "message" })
    expect(outcome.delivered.map((d) => d.sid)).toEqual(["bbbbbbbb-2"])

    // B drains its inbox.
    const drain = drainInbox(inboxPath(b.sid, env), 0)
    expect(drain.fresh.length).toBe(1)
    expect(drain.fresh[0]?.body).toBe("hello B")
    expect(drain.fresh[0]?.from.short).toBe("aaaaaa")

    // Second drain from the advanced mark yields nothing (delivered once).
    expect(drainInbox(inboxPath(b.sid, env), drain.nextMark).fresh.length).toBe(0)
  })

  it("broadcast 'all' reaches every reachable peer but not self", () => {
    const a = ident("aaaaaaaa-1", 5001)
    const b = ident("bbbbbbbb-2", 5002)
    const c = ident("cccccccc-3", 5003)
    const now = Date.now()
    const alive = (pid: number) => [5001, 5002, 5003].includes(pid)

    for (const s of [a, b, c]) runBeat(beatFor(s, now, alive))

    const outcome = send(svc(a, now, alive), { to: "all", body: "hi all", kind: "message" })
    const sids = outcome.delivered.map((d) => d.sid).sort()
    expect(sids).toEqual(["bbbbbbbb-2", "cccccccc-3"])
    expect(sids).not.toContain("aaaaaaaa-1")
  })

  it("a self-send is refused", () => {
    const a = ident("aaaaaaaa-1", 6001)
    const now = Date.now()
    const alive = () => true
    runBeat(beatFor(a, now, alive))
    const outcome = send(svc(a, now, alive), { to: "aaaaaa", body: "to me", kind: "message" })
    expect(outcome.delivered.length).toBe(0)
    expect(outcome.skipped[0]?.reason).toContain("self")
  })

  it("an unknown peer is reported, not delivered", () => {
    const a = ident("aaaaaaaa-1", 7001)
    const now = Date.now()
    const alive = () => true
    runBeat(beatFor(a, now, alive))
    const outcome = send(svc(a, now, alive), { to: "zzzzzz", body: "x", kind: "message" })
    expect(outcome.delivered.length).toBe(0)
    expect(outcome.skipped[0]?.reason).toContain("no such peer")
  })
})

describe("wake channel end-to-end", () => {
  it("a message into B causes B's next beat to inject a prompt", () => {
    const a = ident("aaaaaaaa-1", 8001)
    const b = ident("bbbbbbbb-2", 8002)
    const now = Date.now()
    const alive = (pid: number) => pid === 8001 || pid === 8002
    runBeat(beatFor(a, now, alive))
    runBeat(beatFor(b, now, alive))

    send(svc(a, now, alive), { to: "bbbbbb", body: "wake up", kind: "message" })

    const injected: { channel: string; payload: unknown }[] = []
    const bBeat = beatFor(b, now + 1000, alive)
    const withCapture: BeatDeps = {
      ...bBeat,
      emit: (channel, payload) => injected.push({ channel, payload }),
    }
    const res = runBeat(withCapture)

    expect(res.woke).toBe(1)
    expect(injected.length).toBe(1)
    const first = injected[0]
    if (!first) throw new Error("expected an injected message")
    expect(first.channel).toBe("prompt.inject")
    expect((first.payload as { text: string }).text).toContain("wake up")
  })
})
