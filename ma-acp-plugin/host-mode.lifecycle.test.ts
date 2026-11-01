/**
 * In-process tests for the `host-mode.ts` life cycle: shutdown on the
 * context abort signal, stdin EOF during a turn, the cancel stop reason
 * when a run settles "completed" after a cancel, and up-front params
 * checks (-32602).
 *
 * @module host-mode.lifecycle.test
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { createFakeRuntime } from "./__fixtures__/fake-runtime.ts"
import { openInMemorySession, startInMemoryHost } from "./__fixtures__/in-memory-host.ts"

const text = (t: string) => [{ type: "text", text: t }]

describe("session/new cwd check", () => {
  // macOS: the temp dir /var/folders/... is a symlink to /private/var/...
  // The process cwd is the real path. A client can send the symlink path.
  it("accepts a cwd that is a symlink to the process cwd, and refuses another dir", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "acp-cwd-")))
    try {
      const real = join(root, "real")
      const other = join(root, "other")
      mkdirSync(real)
      mkdirSync(other)
      symlinkSync(real, join(root, "link"))
      const h = startInMemoryHost(createFakeRuntime(), real)
      h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })
      await h.reply(1)
      h.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: other } })
      expect((await h.reply(2)).error?.code).toBe(-32602)
      h.send({
        jsonrpc: "2.0",
        id: 3,
        method: "session/new",
        params: { cwd: join(root, "link"), mcpServers: [] },
      })
      const created = await h.reply(3)
      expect(created.error).toBeUndefined()
      expect(typeof created.result?.sessionId).toBe("string")
      h.end()
      expect(await h.exit).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("host-mode life cycle", () => {
  it("on ctx.abort: aborts the run, answers the prompt, closes the session, and returns", async () => {
    const rt = createFakeRuntime()
    rt.turns.push({ events: [], outcome: "aborted", waitForAbort: true })
    const h = await openInMemorySession(rt)
    h.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId: h.sessionId, prompt: text("go") },
    })
    await Bun.sleep(20)
    h.abort.abort()
    // stdin stays open: only the abort signal can end the handler.
    const code = await Promise.race([h.exit, Bun.sleep(1000).then(() => "timeout" as const)])
    expect(code).toBe(0)
    expect(rt.lastRunAborted).toBe(true)
    expect(h.lines().find((m) => m.id === 3)?.result).toEqual({ stopReason: "cancelled" })
    expect(rt.closeCalls).toBe(1)
  })

  it("returns at once when ctx.abort fires with no turn running", async () => {
    const rt = createFakeRuntime()
    const h = await openInMemorySession(rt)
    h.abort.abort()
    const code = await Promise.race([h.exit, Bun.sleep(1000).then(() => "timeout" as const)])
    expect(code).toBe(0)
    expect(rt.closeCalls).toBe(1)
  })

  it("on stdin EOF during a turn: aborts the run, answers the prompt, then closes the session", async () => {
    const rt = createFakeRuntime()
    rt.turns.push({ events: [], outcome: "aborted", waitForAbort: true })
    const h = await openInMemorySession(rt)
    h.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId: h.sessionId, prompt: text("go") },
    })
    await Bun.sleep(20)
    h.end()
    const code = await Promise.race([h.exit, Bun.sleep(1000).then(() => "timeout" as const)])
    expect(code).toBe(0)
    expect(rt.lastRunAborted).toBe(true)
    // The reply is on stdout BEFORE the handler returns.
    expect(h.lines().find((m) => m.id === 3)?.result).toEqual({ stopReason: "cancelled" })
    expect(rt.closeCalls).toBe(1)
  })

  it("answers cancelled when the run settles completed after session/cancel", async () => {
    const rt = createFakeRuntime()
    rt.turns.push({ events: [], outcome: "completed", waitForAbort: true })
    const h = await openInMemorySession(rt)
    h.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId: h.sessionId, prompt: text("go") },
    })
    await Bun.sleep(20)
    h.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: h.sessionId } })
    expect((await h.reply(3)).result).toEqual({ stopReason: "cancelled" })
    h.end()
    expect(await h.exit).toBe(0)
  })
})

describe("host-mode params checks", () => {
  it("answers -32602 for missing or wrong-typed params, never -32603", async () => {
    const rt = createFakeRuntime()
    const h = startInMemoryHost(rt)
    h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })
    await h.reply(1)

    h.send({ jsonrpc: "2.0", id: 2, method: "session/new" })
    h.send({ jsonrpc: "2.0", id: 3, method: "session/new", params: null })
    h.send({ jsonrpc: "2.0", id: 4, method: "session/new", params: { cwd: 7 } })
    for (const id of [2, 3, 4]) expect((await h.reply(id)).error?.code).toBe(-32602)

    h.send({ jsonrpc: "2.0", id: 5, method: "session/new", params: { cwd: "/work" } })
    const sessionId = (await h.reply(5)).result?.sessionId as string
    expect(sessionId).toBe("sess_fake")

    h.send({ jsonrpc: "2.0", id: 6, method: "session/prompt" })
    h.send({ jsonrpc: "2.0", id: 7, method: "session/prompt", params: "x" })
    h.send({ jsonrpc: "2.0", id: 8, method: "session/set_config_option" })
    h.send({ jsonrpc: "2.0", id: 9, method: "session/set_config_option", params: [1] })
    h.send({
      jsonrpc: "2.0",
      id: 10,
      method: "session/set_config_option",
      params: { sessionId, configId: 3, value: "alpha" },
    })
    for (const id of [6, 7, 8, 9, 10]) {
      const r = await h.reply(id)
      expect(r.error?.code).toBe(-32602)
      expect(r.error?.message).not.toContain("TypeError")
    }
    // A cancel with no params is ignored, and the session still works.
    h.send({ jsonrpc: "2.0", method: "session/cancel" })
    h.send({
      jsonrpc: "2.0",
      id: 11,
      method: "session/prompt",
      params: { sessionId, prompt: text("hi") },
    })
    expect((await h.reply(11)).result).toEqual({ stopReason: "end_turn" })
    h.end()
    expect(await h.exit).toBe(0)
  })
})
