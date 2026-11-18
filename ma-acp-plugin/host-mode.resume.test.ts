/**
 * In-process tests for `session/resume` (ACP `sessionCapabilities.resume`):
 * the capability is advertised only when the CLI runtime has
 * `resumeSession`, a resume reopens the session under the id the client
 * sent, an unknown id is -32002 and leaves the process able to open a
 * fresh session, and the one-session limit covers both methods.
 *
 * @module host-mode.resume.test
 */

import { describe, expect, it } from "bun:test"

import type { HostSession } from "@minimal-agent/core/host-kit/host-mode"

import { createFakeRuntime, type FakeRuntime } from "./__fixtures__/fake-runtime.ts"
import { startInMemoryHost } from "./__fixtures__/in-memory-host.ts"
import { readResumeSession } from "./host-mode.ts"

const SAVED_ID = "6c9f57b4-bb7d-4720-8e2a-de1c0b8fdad2"

/** The fake runtime plus a CLI-like `resumeSession` that knows `known` ids. */
function resumableRuntime(known: readonly string[] = [SAVED_ID]) {
  const rt = createFakeRuntime()
  const resumeCalls: Array<{ id: string; options: unknown }> = []
  const resumeSession = async (id: string, options?: unknown): Promise<HostSession> => {
    resumeCalls.push({ id, options })
    if (!known.includes(id)) {
      throw Object.assign(new Error(`no saved session "${id}" to resume`), {
        code: "session.not-found",
      })
    }
    const opened = await rt.openSession()
    return { ...opened, sessionId: id, run: opened.run, answer: opened.answer, close: opened.close }
  }
  Object.assign(rt, { resumeSession })
  return { rt: rt as FakeRuntime & { resumeSession: typeof resumeSession }, resumeCalls }
}

async function init(h: ReturnType<typeof startInMemoryHost>) {
  h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })
  const r = await h.reply(1)
  return r.result?.agentCapabilities as Record<string, unknown> & {
    sessionCapabilities?: Record<string, unknown>
  }
}

const resume = (h: ReturnType<typeof startInMemoryHost>, id: number, params: object) =>
  h.send({ jsonrpc: "2.0", id, method: "session/resume", params })

describe("readResumeSession", () => {
  it("is undefined for a runtime with no resumeSession function", () => {
    expect(readResumeSession(createFakeRuntime())).toBeUndefined()
    expect(readResumeSession({ resumeSession: "x" })).toBeUndefined()
    expect(readResumeSession(null)).toBeUndefined()
  })
})

describe("session/resume", () => {
  it("an older CLI (no resumeSession): no resume capability, and session/resume is -32601", async () => {
    const h = startInMemoryHost(createFakeRuntime())
    const ac = await init(h)
    expect(ac.loadSession).toBe(false)
    expect(ac.sessionCapabilities?.resume).toBeUndefined()
    resume(h, 2, { sessionId: SAVED_ID, cwd: "/work", mcpServers: [] })
    expect((await h.reply(2)).error?.code).toBe(-32601)
    h.end()
    expect(await h.exit).toBe(0)
  })

  it("advertises sessionCapabilities.resume next to systemPrompt, loadSession stays false", async () => {
    const { rt } = resumableRuntime()
    const h = startInMemoryHost(rt)
    const ac = await init(h)
    expect(ac.loadSession).toBe(false)
    expect(ac.sessionCapabilities).toEqual({
      systemPrompt: { mode: { override: {} } },
      resume: {},
    })
    h.end()
    expect(await h.exit).toBe(0)
  })

  it("reopens the saved session under the client's id, and prompts run on it", async () => {
    const { rt, resumeCalls } = resumableRuntime()
    rt.turns.push({ events: [], outcome: "completed" })
    const h = startInMemoryHost(rt)
    await init(h)
    resume(h, 2, { sessionId: SAVED_ID, cwd: "/work", mcpServers: [] })
    const r = await h.reply(2)
    expect(r.error).toBeUndefined()
    // ResumeSessionResponse has no sessionId. The config options are there.
    expect(r.result?.sessionId).toBeUndefined()
    expect(Array.isArray(r.result?.configOptions)).toBe(true)
    expect(resumeCalls).toEqual([{ id: SAVED_ID, options: undefined }])
    h.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId: SAVED_ID, prompt: [{ type: "text", text: "go on" }] },
    })
    expect((await h.reply(3)).result?.stopReason).toBe("end_turn")
    expect(rt.prompts).toEqual(["go on"])
    h.end()
    expect(await h.exit).toBe(0)
    expect(rt.closeCalls).toBe(1)
  })

  it("passes a systemPrompt option to resumeSession", async () => {
    const { rt, resumeCalls } = resumableRuntime()
    const h = startInMemoryHost(rt)
    await init(h)
    resume(h, 2, {
      sessionId: SAVED_ID,
      cwd: "/work",
      systemPrompt: { mode: "append", content: [{ type: "text", text: "rules" }] },
    })
    expect((await h.reply(2)).error).toBeUndefined()
    expect(resumeCalls[0]?.options).toEqual({ systemPrompt: { mode: "append", text: "rules" } })
    h.end()
    expect(await h.exit).toBe(0)
  })

  it("an unknown id is -32002, and a session/new after it still opens", async () => {
    const { rt } = resumableRuntime([])
    const h = startInMemoryHost(rt)
    await init(h)
    resume(h, 2, { sessionId: SAVED_ID, cwd: "/work", mcpServers: [] })
    const r = await h.reply(2)
    expect(r.error?.code).toBe(-32002)
    expect(r.error?.message).toContain("no saved session")
    h.send({ jsonrpc: "2.0", id: 3, method: "session/new", params: { cwd: "/work" } })
    expect((await h.reply(3)).result?.sessionId).toBe("sess_fake")
    h.end()
    expect(await h.exit).toBe(0)
  })

  it("checks params: no sessionId or another cwd is -32602, and nothing opens", async () => {
    const { rt, resumeCalls } = resumableRuntime()
    const h = startInMemoryHost(rt)
    await init(h)
    resume(h, 2, { cwd: "/work" })
    resume(h, 3, { sessionId: 7, cwd: "/work" })
    resume(h, 4, { sessionId: SAVED_ID, cwd: "/elsewhere" })
    for (const id of [2, 3, 4]) expect((await h.reply(id)).error?.code).toBe(-32602)
    expect(resumeCalls).toEqual([])
    h.end()
    expect(await h.exit).toBe(0)
  })

  it("one session per process: a resume after session/new (and the reverse) is -32600", async () => {
    const { rt } = resumableRuntime()
    const h = startInMemoryHost(rt)
    await init(h)
    resume(h, 2, { sessionId: SAVED_ID, cwd: "/work" })
    expect((await h.reply(2)).error).toBeUndefined()
    h.send({ jsonrpc: "2.0", id: 3, method: "session/new", params: { cwd: "/work" } })
    resume(h, 4, { sessionId: SAVED_ID, cwd: "/work" })
    expect((await h.reply(3)).error?.code).toBe(-32600)
    expect((await h.reply(4)).error?.code).toBe(-32600)
    h.end()
    expect(await h.exit).toBe(0)
  })
})
