import { describe, expect, test } from "bun:test"

import type { DaemonResponse } from "../lib/client.ts"
import type { TUIContext } from "../lib/types.ts"

import { runWithDeps } from "./chrome_cdp.ts"

function ctxFor(input: Record<string, unknown>): TUIContext {
  return {
    trigger: { type: "tool", name: "ChromeCDP", input },
    packageDir: "/pkg",
    cwd: "/cwd",
    env: {},
    abort: new AbortController().signal,
    stdout: process.stdout,
    stdin: process.stdin,
    stderr: process.stderr,
  }
}

const ensureUp = async () => true

describe("ChromeCDP handler", () => {
  test("rejects invalid input before touching the daemon", async () => {
    let fetched = false
    const r = await runWithDeps(ctxFor({ action: "nope" }), {
      ensure: ensureUp,
      socketFetch: async () => {
        fetched = true
        return { status: 200, body: {} }
      },
    })
    expect(r.kind).toBe("tool_result")
    if (r.kind === "tool_result") {
      expect(r.is_error).toBe(true)
      expect(r.content).toMatch(/unknown action/)
    }
    expect(fetched).toBe(false)
  })

  test("forwards a valid action and renders the body", async () => {
    const calls: Array<{ route: string; body?: Record<string, unknown> }> = []
    const socketFetch = async (
      route: string,
      body?: Record<string, unknown>,
    ): Promise<DaemonResponse> => {
      calls.push({ route, body })
      if (route === "ping") return { status: 200, body: { ok: true } }
      return { status: 200, body: [{ id: "A", title: "Tab", url: "https://a" }] }
    }
    const r = await runWithDeps(ctxFor({ action: "targets" }), { ensure: ensureUp, socketFetch })
    if (r.kind === "tool_result") {
      expect(r.is_error).toBeFalsy()
      expect(r.content).toContain('"id": "A"')
      expect(r.displayFooter).toContain("1 target(s)")
      // The header now echoes the action being issued, and the body previews it.
      expect(r.displayHeader).toContain("targets")
      expect(r.display).toBeTruthy()
    }
    expect(calls.some((c) => c.route === "targets")).toBe(true)
  })

  test("eval header echoes the JS expression being issued", async () => {
    const socketFetch = async (route: string): Promise<DaemonResponse> => {
      if (route === "ping") return { status: 200, body: { ok: true } }
      return { status: 200, body: { result: 42 } }
    }
    const r = await runWithDeps(ctxFor({ action: "eval", target: "TAB99", expr: "21*2" }), {
      ensure: ensureUp,
      socketFetch,
    })
    if (r.kind === "tool_result") {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: strip SGR
      const header = (r.displayHeader ?? "").replace(/\x1b\[[0-9;]*m/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: strip SGR
      const body = (r.display ?? "").replace(/\x1b\[[0-9;]*m/g, "")
      expect(header).toContain("eval")
      expect(header).toContain("21*2")
      expect(body).toContain("❯ 21*2")
      expect(body).toContain("42")
    }
  })

  test("eval error body marks the result as an error", async () => {
    const socketFetch = async (route: string): Promise<DaemonResponse> => {
      if (route === "ping") return { status: 200, body: { ok: true } }
      return { status: 200, body: { result: { __error: "Error: boom" } } }
    }
    const r = await runWithDeps(ctxFor({ action: "eval", target: "T", expr: "throw 1" }), {
      ensure: ensureUp,
      socketFetch,
    })
    if (r.kind === "tool_result") {
      expect(r.is_error).toBe(true)
      expect(r.content).toContain("__error")
    }
  })

  test("reports a clear error when the daemon can't be started", async () => {
    const r = await runWithDeps(ctxFor({ action: "ping" }), {
      ensure: async () => false,
      socketFetch: async () => ({ status: 200, body: {} }),
      spawnDaemon: () => {},
    })
    if (r.kind === "tool_result") {
      expect(r.is_error).toBe(true)
      expect(r.content).toMatch(/not reachable/)
    }
  })

  test("eval forwards target + expr to the daemon", async () => {
    let seen: Record<string, unknown> | undefined
    const socketFetch = async (
      route: string,
      body?: Record<string, unknown>,
    ): Promise<DaemonResponse> => {
      if (route === "ping") return { status: 200, body: { ok: true } }
      seen = body
      return { status: 200, body: { result: 42 } }
    }
    await runWithDeps(ctxFor({ action: "eval", target: "T1", expr: "21*2" }), {
      ensure: ensureUp,
      socketFetch,
    })
    expect(seen).toEqual({ target: "T1", expr: "21*2" })
  })
})
