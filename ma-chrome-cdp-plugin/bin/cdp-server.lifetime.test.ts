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

/**
 * Behavior of the fake Chrome on a WebSocket upgrade, like Chromium with the
 * remote debugging setting on: each upgrade raises one "Allow" dialog.
 * approve: user clicks Allow. deny: user clicks Cancel (403). pend: the
 * dialog stays open until {@link releasePending}.
 */
let chromeMode: "approve" | "deny" | "pend" = "approve"
/** Count of upgrade requests seen, that is, of dialogs raised. */
let chromeUpgrades = 0
let pendingUpgrades: Array<() => void> = []
const chromeSockets = new Set<{ close(code?: number, reason?: string): void }>()

function releasePending(): void {
  chromeMode = "approve"
  for (const r of pendingUpgrades.splice(0)) r()
}

/** Close every live browser socket from the Chrome side (as a sleep/wake does). */
function dropChromeSockets(): void {
  for (const ws of chromeSockets) ws.close(1001, "gone")
}

/** A fake Chrome: answers every CDP command with an empty result. */
function startFakeChrome(): ReturnType<typeof Bun.serve> {
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, server) {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        chromeUpgrades++
        if (chromeMode === "deny") return new Response("denied", { status: 403 })
        if (chromeMode === "pend") await new Promise<void>((r) => pendingUpgrades.push(r))
      }
      if (server.upgrade(req)) return undefined
      return Response.json({ webSocketDebuggerUrl: "ws://127.0.0.1/devtools/browser/fake" })
    },
    websocket: {
      open(ws) {
        chromeSockets.add(ws)
      },
      close(ws) {
        chromeSockets.delete(ws)
      },
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

async function post(route: string): Promise<{ status: number; body: unknown }> {
  try {
    const res = await fetch(`http://localhost/${route}`, {
      unix: sock,
      method: "POST",
      body: "{}",
      signal: AbortSignal.timeout(5000),
    } as RequestInit & { unix: string })
    return { status: res.status, body: await res.json().catch(() => null) }
  } catch {
    return { status: -1, body: null }
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
  chromeMode = "approve"
  chromeUpgrades = 0
  pendingUpgrades = []
  chromeSockets.clear()
  chrome = startFakeChrome()
})

afterEach(async () => {
  for (const p of procs.splice(0)) {
    if (alive(p)) p.kill("SIGKILL")
    await p.exited
  }
  releasePending()
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

  test("Chrome gone: a request fails fast, no retry loop, idle exit still works", async () => {
    const p = spawnDaemon({ CDP_IDLE_MS: "1500", CDP_LEASE_CHECK_MS: "200" })
    expect(await waitFor(async () => (await ping())?.ok === true, 3000)).toBe(true)
    expect((await post("targets")).status).toBe(200)
    await chrome?.stop(true)
    chrome = undefined
    const r = await post("targets")
    expect(r.status).toBe(503)
    expect(await exitsWithin(p, 5000)).toBe(true)
    expect(existsSync(sock)).toBe(false)
  }, 15_000)

  // Chromium with remote debugging turned on in its settings (no launch flag)
  // shows an "Allow remote debugging?" dialog for EVERY new browser WebSocket.
  // Chromium queues those dialogs and keeps them after the client gives up.
  // So any connect attempt the user did not ask for becomes a dialog, and
  // retries while the Mac is locked pile up into hundreds of them.

  test("starting the daemon opens no Chrome connection until a request needs it", async () => {
    lease(process.pid)
    spawnDaemon({})
    expect(await waitFor(async () => (await ping())?.ok === true, 3000)).toBe(true)
    await sleep(500)
    expect(chromeUpgrades).toBe(0)
  }, 15_000)

  test("connection dropped (sleep/wake): no background reconnect", async () => {
    lease(process.pid)
    const p = spawnDaemon({})
    expect(await waitFor(async () => (await ping())?.ok === true, 3000)).toBe(true)
    expect((await post("targets")).status).toBe(200)
    expect(chromeUpgrades).toBe(1)
    dropChromeSockets()
    await sleep(3000)
    expect(chromeUpgrades).toBe(1)
    expect(alive(p)).toBe(true)
    // The next real request reconnects, once.
    expect((await post("targets")).status).toBe(200)
    expect(chromeUpgrades).toBe(2)
  }, 15_000)

  test("user cancels the dialog (403): no retry, clear error, cooldown", async () => {
    lease(process.pid)
    chromeMode = "deny"
    const p = spawnDaemon({ CDP_DENY_COOLDOWN_MS: "2000" })
    expect(await waitFor(async () => (await ping())?.ok === true, 3000)).toBe(true)
    const r = await post("targets")
    expect(r.status).toBe(403)
    expect(String((r.body as { error?: string })?.error)).toContain("denied")
    // A looping caller inside the cooldown raises no new dialog.
    expect((await post("targets")).status).toBe(403)
    await sleep(1000)
    expect(chromeUpgrades).toBe(1)
    expect(alive(p)).toBe(true)
    // After the cooldown, an explicit request may ask once more.
    await sleep(1500)
    chromeMode = "approve"
    expect((await post("targets")).status).toBe(200)
    expect(chromeUpgrades).toBe(2)
  }, 15_000)

  test("dialog left unanswered: concurrent and repeated requests share one attempt", async () => {
    lease(process.pid)
    chromeMode = "pend"
    spawnDaemon({ CDP_READY_TIMEOUT_MS: "500" })
    expect(await waitFor(async () => (await ping())?.ok === true, 3000)).toBe(true)
    const rs = await Promise.all([post("targets"), post("targets"), post("targets")])
    expect(rs.map((r) => r.status)).toEqual([503, 503, 503])
    expect((await post("targets")).status).toBe(503)
    expect(chromeUpgrades).toBe(1)
    // The user comes back and clicks Allow: the same attempt goes through.
    releasePending()
    expect(await waitFor(async () => (await ping())?.connected === true, 3000)).toBe(true)
    expect((await post("targets")).status).toBe(200)
    expect(chromeUpgrades).toBe(1)
  }, 15_000)
})
