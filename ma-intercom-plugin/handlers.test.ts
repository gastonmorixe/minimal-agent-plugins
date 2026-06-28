/**
 * Handler smoke tests: drive the tool entry points + the inbox attachment
 * against a temp home, asserting the model-facing contract (tool_result shape,
 * the intercom-inbox attachment block, seen-cursor advance).
 *
 * @module handlers.test
 */

import { mkdtempSync, rmSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { InboxAttachment } from "./handlers/inbox_attachment.ts"
import peersHandler from "./handlers/peers.ts"
import sendHandler from "./handlers/send.ts"
import { buildEnvelope, type EnvelopeFrom } from "./lib/envelope.ts"
import type { AgentContext, TUIContext } from "./lib/host-types.ts"
import { appendEnvelope } from "./lib/inbox.ts"
import { inboxPath, presencePath } from "./lib/paths.ts"
import { type PresenceRecord, writePresence } from "./lib/presence.ts"

let home: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "intercom-handlers-"))
  env = { MINIMAL_AGENT_HOME: home }
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

function agent(sid: string, pid: number): AgentContext {
  return { sessionId: sid, pid, model: "claude-opus-4-8", version: "0.1.0" }
}

function toolCtx(
  sid: string,
  pid: number,
  name: string,
  input: Record<string, unknown>,
): TUIContext {
  return {
    trigger: { type: "tool", name, input },
    packageDir: "/plugin",
    cwd: "/work",
    env: env as Record<string, string>,
    abort: new AbortController().signal,
    stdout: process.stdout,
    stdin: process.stdin,
    stderr: process.stderr,
    agent: agent(sid, pid),
  }
}

function presence(sid: string, pid: number): PresenceRecord {
  return {
    v: 1,
    sid,
    short: sid.slice(0, 6),
    pid,
    host: hostname(),
    ts: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    agentVersion: "0.1.0",
    model: "claude-opus-4-8",
    cwd: "/work",
    projectRoot: "/work",
    phase: "active",
    activity: null,
  }
}

describe("Peers list", () => {
  it("reports no peers when alone", async () => {
    const res = await peersHandler(toolCtx("solo-1", process.pid, "Peers", { action: "list" }))
    expect(res.kind).toBe("tool_result")
    if (res.kind === "tool_result") expect(res.content).toContain("only one running")
  })

  it("lists a present live peer (json)", async () => {
    // a peer with OUR pid so the liveness probe says alive
    writePresence(presencePath("peer-xyz", env), presence("peer-xyz", process.pid))
    const res = await peersHandler(
      toolCtx("me-aaaa", process.pid, "Peers", { action: "list", format: "json" }),
    )
    if (res.kind === "tool_result") {
      const parsed = JSON.parse(res.content) as { peers: { sid: string }[] }
      expect(parsed.peers.some((p) => p.sid === "peer-xyz")).toBe(true)
    }
  })
})

describe("Send", () => {
  it("requires to + body", async () => {
    const noTo = await sendHandler(toolCtx("a-1", process.pid, "Send", { body: "x" }))
    expect(noTo.kind === "tool_result" && noTo.is_error).toBe(true)
    const noBody = await sendHandler(toolCtx("a-1", process.pid, "Send", { to: "x" }))
    expect(noBody.kind === "tool_result" && noBody.is_error).toBe(true)
  })

  it("delivers to a present peer", async () => {
    writePresence(presencePath("peer-bbb", env), presence("peer-bbb", process.pid))
    const res = await sendHandler(
      toolCtx("me-aaa", process.pid, "Send", { to: "peer-b", body: "hi", kind: "message" }),
    )
    expect(res.kind).toBe("tool_result")
    if (res.kind === "tool_result") {
      expect(res.is_error).toBeFalsy()
      expect(res.content).toContain("Delivered")
    }
  })

  it("refuses delivery to a dead peer", async () => {
    // Write a presence record with a pid that doesn't exist, so the liveness
    // probe returns false and the peer classifies as dead.
    const deadRec = presence("peer-dead", 99999)
    writePresence(presencePath("peer-dead", env), deadRec)
    const res = await sendHandler(
      toolCtx("me-aaa", process.pid, "Send", { to: "peer-dead", body: "hi" }),
    )
    expect(res.kind).toBe("tool_result")
    if (res.kind === "tool_result") {
      expect(res.is_error).toBe(true)
      expect(res.content).toContain("peer is dead")
    }
  })
})

describe("InboxAttachment", () => {
  const FROM: EnvelopeFrom = {
    sid: "peer-1",
    short: "peer-1".slice(0, 6),
    pid: 1,
    host: "h",
    cwd: "/p",
    model: "m",
  }

  it("returns null with an empty inbox", () => {
    const att = new InboxAttachment("me-1", env)
    expect(att.toAttachment()).toBeNull()
  })

  it("renders new messages as <ma::agent::intercom-inbox> and advances seen", () => {
    const sid = "me-2"
    appendEnvelope(
      inboxPath(sid, env),
      buildEnvelope({ from: FROM, to: sid, scope: sid, kind: "message", body: "ping body" }),
    )
    const att = new InboxAttachment(sid, env)
    const block = att.toAttachment()
    expect(block).not.toBeNull()
    expect(block?.text).toContain("<ma::agent::intercom-inbox")
    expect(block?.text).toContain('count="1"')
    expect(block?.text).toContain("ping body")
    expect(block?.text).toContain("</ma::agent::intercom-inbox>")

    // Second call: already seen ⇒ null (delivered exactly once).
    expect(att.toAttachment()).toBeNull()
  })
})
