/**
 * Process tests for the daemon lifetime: one daemon per socket, idle exit,
 * client leases, and the reconnect cap. Each test spawns real `cdp-server.ts`
 * processes against a fake Chrome (a local `Bun.serve` WebSocket) and a fresh
 * socket in a private temp dir. The real `/tmp/cdp.sock` is never touched.
 *
 * Every spawned pid is killed by exact pid in `afterEach`.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

const SERVER = join(import.meta.dir, "cdp-server.ts")
// Override with CDP_TEST_DIR to keep scratch inside a workspace.
const BASE = process.env.CDP_TEST_DIR ?? tmpdir()

type Proc = ReturnType<typeof Bun.spawn>

let dir: string
let sock: string
let leaseDir: string
let dtap: string
let chrome: ReturnType<typeof Bun.serve> | undefined
const procs: Proc[] = []

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** A fake Chrome: answers every CDP command with an empty result. */
function startFakeChrome(): ReturnType<typeof Bun.serve> {
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, server) {
      if (server.upgrade(req)) return undefined
      return Response.json({ webSocketDebuggerUrl: "ws://127.0.0.1/devtools/browser/fake" })
    },
    websocket: {
      message(ws, msg) {
        const m = JSON.parse(String(msg)) as { id?: number }
        if (typeof m.id === "number") ws.send(JSON.stringify({ id: m.id, result: {} }))
      },
    },
  })
  writeFileSync(dtap, `${srv.port}\n/devtools/browser/fake\n`)
  return srv
}

function spawnDaemon(env: Record<string, string>): Proc {
  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("CDP_")) base[k] = v
  }
  const p = Bun.spawn([process.execPath, SERVER], {
    env: {
      ...base,
      CDP_SOCK: sock,
      CDP_DTAP: dtap,
      CDP_PORT: String(chrome?.port ?? 1),
      CDP_LEASE_DIR: leaseDir,
      ...env,
    },
    stdout: "ignore",
    stderr: "ignore",
  })
  procs.push(p)
  return p
}

async function ping(): Promise<{ ok?: boolean; connected?: boolean } | null> {
  try {
    const res = await fetch("http://localhost/ping", {
      unix: sock,
      signal: AbortSignal.timeout(1000),
    } as RequestInit & { unix: string })
    return (await res.json()) as { ok?: boolean; connected?: boolean }
  } catch {
    return null
  }
}

async function waitFor(cond: () => Promise<boolean> | boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return true
    await sleep(50)
  }
  return cond()
}

/** True when `p` exits within `ms`. */
async function exitsWithin(p: Proc, ms: number): Promise<boolean> {
  const r = await Promise.race([p.exited.then(() => true), sleep(ms).then(() => false)])
  return r
}

function alive(p: Proc): boolean {
  return p.exitCode === null && p.signalCode === null
}

function lease(pid: number): string {
  mkdirSync(leaseDir, { recursive: true })
  const f = join(leaseDir, String(pid))
  writeFileSync(f, "")
  return f
}

async function deadPid(): Promise<number> {
  const p = Bun.spawn(["true"])
  await p.exited
  return p.pid
}

beforeEach(() => {
  mkdirSync(BASE, { recursive: true })
  dir = mkdtempSync(join(BASE, "cdp-"))
  sock = join(dir, "d.sock")
  leaseDir = join(dir, "leases")
  dtap = join(dir, "DevToolsActivePort")
  chrome = startFakeChrome()
})

afterEach(async () => {
  for (const p of procs.splice(0)) {
    if (alive(p)) p.kill("SIGKILL")
    await p.exited
  }
  await chrome?.stop(true)
  chrome = undefined
  rmSync(dir, { recursive: true, force: true })
})

describe("cdp-server lifetime", () => {
  test("socket path fits sun_path (104 bytes on macOS)", () => {
    expect(Buffer.byteLength(sock)).toBeLessThan(104)
  })

  test("two daemons started at once on one socket: exactly one stays", async () => {
    lease(process.pid)
    const a = spawnDaemon({})
    const b = spawnDaemon({})
    await sleep(3000)
    expect([a, b].filter(alive).length).toBe(1)
    expect((await ping())?.ok).toBe(true)
  }, 15_000)

  test("a second daemon does not steal the socket of a live one", async () => {
    lease(process.pid)
    const a = spawnDaemon({})
    expect(await waitFor(async () => (await ping())?.ok === true, 3000)).toBe(true)
    const b = spawnDaemon({})
    expect(await exitsWithin(b, 3000)).toBe(true)
    expect(b.exitCode).toBe(0)
    expect(alive(a)).toBe(true)
    expect((await ping())?.ok).toBe(true)
  }, 15_000)

  test("no live lease: exits after CDP_IDLE_MS and removes its socket", async () => {
    const p = spawnDaemon({ CDP_IDLE_MS: "500", CDP_LEASE_CHECK_MS: "200" })
    expect(await waitFor(async () => (await ping())?.ok === true, 3000)).toBe(true)
    expect(await exitsWithin(p, 3000)).toBe(true)
    expect(existsSync(sock)).toBe(false)
  }, 15_000)

  test("a live-pid lease keeps it up, a dead-pid lease does not", async () => {
    const live = lease(process.pid)
    const p = spawnDaemon({ CDP_IDLE_MS: "500", CDP_LEASE_CHECK_MS: "200" })
    expect(await waitFor(async () => (await ping())?.ok === true, 3000)).toBe(true)
    await sleep(2000)
    expect(alive(p)).toBe(true)

    const dead = lease(await deadPid())
    rmSync(live)
    expect(await exitsWithin(p, 3000)).toBe(true)
    expect(existsSync(dead)).toBe(false)
    expect(existsSync(sock)).toBe(false)
  }, 15_000)

  test("Chrome connect never settles: a request fails at CDP_READY_TIMEOUT_MS, idle exit still works", async () => {
    // Accepts TCP and reads the upgrade request, but never answers it.
    const mute = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
    try {
      const p = spawnDaemon({
        CDP_PORT: String(mute.port),
        CDP_READY_TIMEOUT_MS: "800",
        CDP_IDLE_MS: "500",
        CDP_LEASE_CHECK_MS: "200",
      })
      expect(await waitFor(async () => (await ping())?.ok === true, 3000)).toBe(true)
      const t0 = Date.now()
      let status = 0
      let body: { error?: string } | null = null
      try {
        const res = await fetch("http://localhost/targets", {
          unix: sock,
          method: "POST",
          body: "{}",
          signal: AbortSignal.timeout(4000),
        } as RequestInit & { unix: string })
        status = res.status
        body = (await res.json()) as { error?: string }
      } catch {
        status = -1
      }
      expect(status).toBe(503)
      expect(body?.error).toBe("chrome connect timeout")
      expect(Date.now() - t0).toBeLessThan(800 + 1000)
      // No lease, idle 500 ms: the daemon must end although the connect hangs.
      expect(await exitsWithin(p, 3000)).toBe(true)
      expect(existsSync(sock)).toBe(false)
    } finally {
      mute.stop(true)
    }
  }, 15_000)

  test("Chrome gone: stops after CDP_MAX_RECONNECT failed reconnects", async () => {
    lease(process.pid)
    const p = spawnDaemon({ CDP_MAX_RECONNECT: "3" })
    expect(await waitFor(async () => (await ping())?.connected === true, 3000)).toBe(true)
    await chrome?.stop(true)
    chrome = undefined
    expect(await exitsWithin(p, 6000)).toBe(true)
    expect(p.exitCode).toBe(0)
    expect(existsSync(sock)).toBe(false)
  }, 15_000)
})
