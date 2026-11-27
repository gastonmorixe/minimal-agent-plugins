import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import type { UiSetupContext } from "@minimal-agent/core/plugin-api/types/plugin"

import { TEST_TERMINAL_KIT } from "../../scripts/ui/test-terminal-kit.ts"
import type { DaemonResponse } from "../lib/client.ts"
import { slots } from "../lib/style.ts"
import type { TUIContext } from "../lib/types.ts"
import setup from "../ui/setup.ts"

import { type HandlerDeps, runWithDeps } from "./chrome_cdp.ts"

// The display tests below check styled bytes: install the test kit (S41).
beforeAll(() => setup({ tui: { kit: TEST_TERMINAL_KIT } } as UiSetupContext))
afterAll(() => slots.reset())

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

/** `runWithDeps` with a no-op lease writer, so no test writes a real lease file. */
function run(ctx: TUIContext, deps: HandlerDeps) {
  return runWithDeps(ctx, { writeLease: () => {}, ...deps })
}

describe("ChromeCDP handler lifetime wiring", () => {
  test("writes the lease before ensure, and passes the spawn lock path", async () => {
    const calls: string[] = []
    let lockPath: string | undefined
    await runWithDeps(ctxFor({ action: "ping" }), {
      writeLease: () => calls.push("lease"),
      ensure: async (deps) => {
        calls.push("ensure")
        lockPath = deps.lockPath
        return true
      },
      socketFetch: async () => ({ status: 200, body: { ok: true } }),
    })
    expect(calls).toEqual(["lease", "ensure"])
    expect(lockPath?.endsWith(".spawn.lock")).toBe(true)
  })

  test("a client process refreshes its lease on each call and removes it on a normal exit", async () => {
    const base = process.env.CDP_TEST_DIR ?? tmpdir()
    mkdirSync(base, { recursive: true })
    const dir = mkdtempSync(join(base, "hl-"))
    const leaseDir = join(dir, "leases")
    const p = Bun.spawn([process.execPath, join(import.meta.dir, "chrome_cdp.lease.fixture.ts")], {
      env: { ...process.env, CDP_SOCK: join(dir, "d.sock"), CDP_LEASE_DIR: leaseDir },
      stdout: "pipe",
      stderr: "pipe",
    })
    try {
      const out = await new Response(p.stdout).text()
      expect(await p.exited).toBe(0)
      const [a, b] = out
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { pid: number; time: number })
      expect(a?.pid).toBe(p.pid)
      expect(b?.pid).toBe(p.pid)
      expect((b?.time ?? 0) > (a?.time ?? 0)).toBe(true)
      expect(existsSync(join(leaseDir, String(p.pid)))).toBe(false)
    } finally {
      if (p.exitCode === null) p.kill("SIGKILL")
      await p.exited
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)
})

describe("ChromeCDP handler", () => {
  test("rejects invalid input before touching the daemon", async () => {
    let fetched = false
    const r = await run(ctxFor({ action: "nope" }), {
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
    const r = await run(ctxFor({ action: "targets" }), { ensure: ensureUp, socketFetch })
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
    const r = await run(ctxFor({ action: "eval", target: "TAB99", expr: "21*2" }), {
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
    const r = await run(ctxFor({ action: "eval", target: "T", expr: "throw 1" }), {
      ensure: ensureUp,
      socketFetch,
    })
    if (r.kind === "tool_result") {
      expect(r.is_error).toBe(true)
      expect(r.content).toContain("__error")
    }
  })

  test("reports a clear error when the daemon can't be started", async () => {
    const r = await run(ctxFor({ action: "ping" }), {
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
    await run(ctxFor({ action: "eval", target: "T1", expr: "21*2" }), {
      ensure: ensureUp,
      socketFetch,
    })
    expect(seen).toEqual({ target: "T1", expr: "21*2" })
  })

  test("a screenshot result gives an attachment and no base64 in content or display", async () => {
    const png = new Uint8Array(4096)
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
    const data = Buffer.from(png).toString("base64")
    const socketFetch = async (route: string): Promise<DaemonResponse> =>
      route === "ping"
        ? { status: 200, body: { ok: true } }
        : { status: 200, body: { result: { data }, sessionId: "S1" } }
    const r = await run(
      ctxFor({ action: "send", target: "T1", method: "Page.captureScreenshot", params: {} }),
      { ensure: ensureUp, socketFetch },
    )
    if (r.kind !== "tool_result") throw new Error("expected tool_result")
    expect(r.is_error).toBe(false)
    expect(r.attachments).toHaveLength(1)
    expect(r.attachments?.[0]?.mimeType).toBe("image/png")
    expect(Array.from(r.attachments?.[0]?.bytes ?? [])).toEqual(Array.from(png))
    expect(r.content).toContain("[attachment 1: image/png 4.0 KB")
    expect(r.content).not.toContain(data.slice(0, 40))
    expect(r.display ?? "").not.toContain(data.slice(0, 40))
  })

  test("a result with no media has no attachments field", async () => {
    const r = await run(ctxFor({ action: "ping" }), {
      ensure: ensureUp,
      socketFetch: async () => ({ status: 200, body: { ok: true, connected: true } }),
    })
    if (r.kind !== "tool_result") throw new Error("expected tool_result")
    expect("attachments" in r).toBe(false)
  })
})
