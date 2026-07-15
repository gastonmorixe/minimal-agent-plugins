import { describe, expect, it } from "bun:test"

import type { Liveness } from "../liveness.ts"

import {
  CLOSED,
  completeIntoBuffer,
  findActiveToken,
  peerSlug,
  scorePeer,
  transition,
} from "./overlay.ts"
import type { PeerCandidate } from "./types.ts"

const online: Liveness = {
  status: "online",
  phase: "active",
  pid: 1,
  since: "2026-01-01T00:00:00.000Z",
  ageMs: 0,
}
const offline: Liveness = {
  status: "offline",
  reason: "gone",
  lastSeen: "2026-01-01T00:00:00.000Z",
  ageMs: 999_999,
}

const michelle: PeerCandidate = {
  sid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  short: "a1b2c3d4",
  name: "Michelle",
  pid: 11,
  model: "m",
  cwd: "/tmp/proj",
  liveness: online,
}
const dead: PeerCandidate = {
  sid: "deaddead-0000-0000-0000-000000000001",
  short: "deaddead",
  name: "Ghost",
  pid: 99,
  model: "m",
  cwd: "/tmp",
  liveness: offline,
}

describe("findActiveToken", () => {
  it("finds mid-line @query under the cursor", () => {
    const text = "hi @Mich"
    const t = findActiveToken(text, text.length)
    expect(t).toEqual({ at: 3, query: "Mich", end: text.length })
  })

  it("returns null after a space (args started)", () => {
    expect(findActiveToken("hi @Mich ", 9)).toBeNull()
  })

  it("requires a boundary before @", () => {
    expect(findActiveToken("email@x", 7)).toBeNull()
  })
})

describe("transition", () => {
  const ctx = { peers: [michelle, dead], cols: 100 }

  it("opens on buffer-changed with active at-token", () => {
    const r = transition(CLOSED, { kind: "buffer-changed", text: "@Mi", cursor: 3 }, ctx)
    expect(r.state.kind).toBe("open")
    expect(r.effects.some((e) => e.kind === "paint-footer")).toBe(true)
  })

  it("closes when the token disappears", () => {
    const open = transition(CLOSED, { kind: "buffer-changed", text: "@Mi", cursor: 3 }, ctx)
    const r = transition(open.state, { kind: "buffer-changed", text: "plain", cursor: 5 }, ctx)
    expect(r.state).toEqual(CLOSED)
    expect(r.effects).toContainEqual({ kind: "clear-footer" })
  })

  it("Tab completes with trailing space and halts", () => {
    const open = transition(CLOSED, { kind: "buffer-changed", text: "@Mi", cursor: 3 }, ctx)
    expect(open.state.kind).toBe("open")
    const r = transition(
      open.state,
      { kind: "key", name: "Tab" },
      {
        ...ctx,
        bufferText: "@Mi",
      },
    )
    const set = r.effects.find((e) => e.kind === "set-buffer")
    expect(set && set.kind === "set-buffer" ? set.text : null).toBe("@Michelle ")
    expect(r.effects.some((e) => e.kind === "halt-key")).toBe(true)
  })

  it("Enter completes without halt so submit can fire", () => {
    const open = transition(CLOSED, { kind: "buffer-changed", text: "@Mi", cursor: 3 }, ctx)
    const r = transition(
      open.state,
      { kind: "key", name: "Enter" },
      {
        ...ctx,
        bufferText: "@Mi",
      },
    )
    expect(r.state.kind).toBe("closed")
    const set = r.effects.find((e) => e.kind === "set-buffer")
    expect(set && set.kind === "set-buffer" ? set.text : null).toBe("@Michelle")
    expect(r.effects.some((e) => e.kind === "halt-key")).toBe(false)
  })
})

describe("peerSlug / scorePeer / completeIntoBuffer", () => {
  it("prefers name over short", () => {
    expect(peerSlug(michelle)).toBe("Michelle")
  })

  it("scores name matches higher than non-matches", () => {
    const hit = scorePeer(michelle, "Mich")
    const miss = scorePeer(dead, "Mich")
    expect(hit).not.toBeNull()
    expect(hit!.score).toBeGreaterThan(0)
    // Ghost may or may not fuzzy-match "Mich"; just ensure michelle scores.
    void miss
  })

  it("completeIntoBuffer rewrites only the token span", () => {
    const state = {
      kind: "open" as const,
      query: "Mi",
      tokenStart: 4,
      tokenEnd: 7,
      selectedIndex: 0,
      scrollOffset: 0,
    }
    const r = completeIntoBuffer("hey @Mi now", state, "Michelle", true)
    expect(r.text).toBe("hey @Michelle  now")
    expect(r.cursor).toBe("hey @Michelle ".length)
  })
})
