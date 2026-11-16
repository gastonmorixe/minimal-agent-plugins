#!/usr/bin/env bun
/**
 * Persistent CDP daemon.
 *
 * Connects to Chrome's browser-level WebSocket on the first request that needs
 * it and keeps that connection, then serves a tiny HTTP API over a UNIX
 * DOMAIN SOCKET. Why: macOS Local Network
 * privacy prompts on every NEW process that opens a TCP socket to Chrome's
 * debug port, so a short-lived client per command means a prompt per command.
 * A unix socket is a filesystem object (not "network"), so clients hitting the
 * daemon never trigger the prompt. One allow at daemon start, then silence.
 *
 * Run:  bun run bin/cdp-server.ts          (from the plugin dir)
 * Env:  CDP_PORT (9222) · CDP_SOCK (/tmp/cdp.sock) · CDP_DTAP (auto) · CDP_LOG
 *       CDP_LEASE_DIR (`<sock>.leases`) · CDP_IDLE_MS (600000, 0 = off)
 *       CDP_LEASE_CHECK_MS (30000) · CDP_READY_TIMEOUT_MS (15000)
 *       CDP_LEASE_MAX_AGE_MS (86400000, 0 = off) · CDP_DENY_COOLDOWN_MS (30000)
 *
 * Lifetime:
 * 1. One daemon per socket. Under `<sock>.bind.lock` the daemon pings the
 *    socket first. If a live daemon answers, this one exits 0. Else it removes
 *    the stale file and binds, before the slow Chrome connect.
 * 2. Leases: each client process writes `<lease dir>/<pid>` (lib/lifetime),
 *    refreshes it on each call and removes it on exit. Every
 *    CDP_LEASE_CHECK_MS the daemon removes the leases of dead pids and the
 *    leases not refreshed for CDP_LEASE_MAX_AGE_MS. It exits when no live
 *    lease is left and no request came for CDP_IDLE_MS.
 * 3. Connect on demand only. Chromium with remote debugging turned on in its
 *    settings (no `--remote-debugging-port` flag) shows an "Allow remote
 *    debugging?" dialog for EVERY new browser WebSocket. It queues those
 *    dialogs and keeps them after the client gives up. So the daemon never
 *    connects on its own: not at start, not after a drop (sleep/wake, Chrome
 *    restart). Only a request that needs Chrome starts a connect, and at most
 *    one attempt is in flight. Requests that come while it is pending share
 *    it. A request waits for it at most CDP_READY_TIMEOUT_MS, then gets 503
 *    `chrome connect timeout`. The attempt keeps going (the user may still
 *    click Allow). A 403 means the user clicked Cancel: requests get 403 for
 *    CDP_DENY_COOLDOWN_MS without a new attempt, so a looping caller cannot
 *    raise a dialog storm.
 * 4. On exit it removes the socket only if the file is still the one it bound.
 *
 * Exports {@link main} so a compiled binary can dispatch it from its embedded
 * script map (`<binary> __run chrome-cdp/cdp-server`). Importing the module has
 * no side effects: Chrome discovery, signal handlers and the socket all start
 * inside `main`. Run directly, the `import.meta.main` guard at the bottom calls
 * it. `main` resolves with `undefined` once the server is listening (the
 * caller must NOT exit then: the daemon lives on), with 0 when another daemon
 * already serves the socket, or with 1 on a fatal error.
 *
 * @module bin/cdp-server
 */

import { readFileSync, statSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"

import { socketAnswers } from "../lib/client.ts"
import { CdpConnection } from "../lib/connection.ts"
import { dispatch } from "../lib/dispatch.ts"
import {
  DEFAULT_DENY_COOLDOWN_MS,
  DEFAULT_IDLE_MS,
  DEFAULT_LEASE_CHECK_MS,
  DEFAULT_LEASE_MAX_AGE_MS,
  DEFAULT_READY_TIMEOUT_MS,
  envInt,
  leaseDirFor,
  pidAlive,
  shouldIdleExit,
  sweepLeases,
} from "../lib/lifetime.ts"
import { resolveDtapPath } from "../lib/profile.ts"
import { browserWsUrl, parseDevToolsActivePort } from "../lib/protocol.ts"
import { isRoute, validateBody } from "../lib/routes.ts"
import { acquireLockWait } from "../lib/spawn-lock.ts"

const PORT = Number.parseInt(process.env.CDP_PORT ?? "9222", 10)
const SOCK = process.env.CDP_SOCK ?? "/tmp/cdp.sock"
const LEASE_DIR = leaseDirFor(SOCK, process.env.CDP_LEASE_DIR)
const IDLE_MS = envInt(process.env.CDP_IDLE_MS, DEFAULT_IDLE_MS)
const LEASE_CHECK_MS = Math.max(
  10,
  envInt(process.env.CDP_LEASE_CHECK_MS, DEFAULT_LEASE_CHECK_MS) || DEFAULT_LEASE_CHECK_MS,
)
const READY_TIMEOUT_MS = envInt(process.env.CDP_READY_TIMEOUT_MS, DEFAULT_READY_TIMEOUT_MS)
const LEASE_MAX_AGE_MS = envInt(process.env.CDP_LEASE_MAX_AGE_MS, DEFAULT_LEASE_MAX_AGE_MS)
const DENY_COOLDOWN_MS = envInt(process.env.CDP_DENY_COOLDOWN_MS, DEFAULT_DENY_COOLDOWN_MS)

function log(msg: string): void {
  console.log(`[cdp-server] ${msg}`)
}

// Chrome's browser WebSocket URL, resolved once at the start of `main`.
let wsUrl: string

// The current connection. Replaced only by {@link ensureConnected}, on demand.
let conn: CdpConnection

// The connect attempt in flight, shared by every request that waits for it.
let connecting: Promise<void> | undefined
// Until this time, requests get 403 without a new attempt (user clicked Cancel).
let deniedUntil = 0

// Inode of the socket file this daemon bound, or undefined when it bound none.
let boundIno: number | undefined
let lastActivity = Date.now()
let inflight = 0
let shuttingDown = false
let leaseTimer: ReturnType<typeof setInterval> | undefined

function freshConnection(): CdpConnection {
  return new CdpConnection({
    url: wsUrl,
    socketFactory: (url) => new WebSocket(url),
    log,
    // No reconnect here. A background attempt would raise a Chromium dialog
    // nobody asked for (see the module doc). The next request reconnects.
    onClose: () => log("chrome connection closed, reconnect on next request"),
  })
}

/** Thrown when the user denied the connection (Chromium answered 403). */
class DeniedError extends Error {}

/**
 * Start a connect, or join the one in flight. Never runs a second attempt
 * while one is pending. A 403 starts the deny cooldown.
 */
function ensureConnected(): Promise<void> {
  if (conn?.connected) return Promise.resolve()
  if (connecting) return connecting
  if (Date.now() < deniedUntil) return Promise.reject(new DeniedError(DENIED_MSG))
  const c = freshConnection()
  conn = c
  connecting = c
    .connect()
    .then(async () => {
      // Turn on browser-level download events up front so /downloads works.
      await c
        .send("Browser.setDownloadBehavior", { behavior: "default", eventsEnabled: true })
        .catch(() => {})
    })
    .catch((e: unknown) => {
      const msg = String(e)
      log(`connect failed: ${msg}`)
      if (/\b403\b/.test(msg)) {
        deniedUntil = Date.now() + DENY_COOLDOWN_MS
        throw new DeniedError(DENIED_MSG)
      }
      throw e
    })
    .finally(() => {
      connecting = undefined
    })
  return connecting
}

const DENIED_MSG =
  "chrome denied the remote debugging connection (the Allow dialog was cancelled). " +
  "Ask the user, then retry"

/**
 * Start the daemon: resolve Chrome's WebSocket from `DevToolsActivePort`,
 * bind the unix socket (or step aside for a live daemon), connect once, then
 * serve the HTTP API.
 *
 * @param _argv - Arguments after the script (unused, config is env-only).
 * @returns `undefined` once listening (keep the process alive), 0 when another
 *   daemon already serves the socket, 1 on a fatal error.
 */
export async function main(_argv: string[] = []): Promise<number | undefined> {
  try {
    return await serve()
  } catch (e: unknown) {
    log(`fatal: ${String(e)}`)
    removeOwnSocket()
    return 1
  }
}

async function serve(): Promise<number | undefined> {
  const dtapPath = resolveDtapPath({ home: homedir(), override: process.env.CDP_DTAP })
  const { wsPath } = parseDevToolsActivePort(readFileSync(dtapPath, "utf8"))
  wsUrl = browserWsUrl(PORT, wsPath)
  conn = freshConnection()

  // Bind first, under a lock, so two daemons started at once cannot both
  // unlink+bind. The loser sees a live daemon and steps aside.
  const release = await acquireLockWait(`${SOCK}.bind.lock`)
  try {
    if (await socketAnswers(SOCK)) {
      log(`another daemon serves ${SOCK}, exiting`)
      return 0
    }
    try {
      unlinkSync(SOCK)
    } catch {
      // socket file may not exist; fine
    }
    listen()
    boundIno = statSync(SOCK).ino
  } finally {
    release()
  }
  log(`listening ${SOCK}`)

  process.on("SIGTERM", bye)
  process.on("SIGINT", bye)

  // No Chrome connect here: the first request that needs Chrome starts it.
  leaseTimer = setInterval(checkIdle, LEASE_CHECK_MS)
  leaseTimer.unref()
  log(`idle exit ${IDLE_MS}ms, lease check ${LEASE_CHECK_MS}ms, leases ${LEASE_DIR}`)

  return undefined
}

/**
 * Wait for `ready` at most `ms`. Resolves "ok", "timeout", or the rejection
 * error. On timeout the attempt keeps running: the user may still click Allow.
 */
async function settleWithin(ready: Promise<void>, ms: number): Promise<"ok" | "timeout" | Error> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<"timeout">((res) => {
    timer = setTimeout(() => res("timeout"), ms)
  })
  try {
    return await Promise.race([
      ready.then(
        () => "ok" as const,
        (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
      ),
      timeout,
    ])
  } finally {
    clearTimeout(timer)
  }
}

function listen(): void {
  Bun.serve({
    unix: SOCK,
    async fetch(req: Request): Promise<Response> {
      const route = new URL(req.url).pathname.replace(/^\//, "")
      const json = (status: number, body: unknown): Response =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        })

      if (!isRoute(route)) return json(404, { error: `unknown route ${route}` })
      inflight++
      lastActivity = Date.now()
      try {
        // Real work connects on demand (one shared attempt), but waits for it
        // only so long: an unanswered Allow dialog holds the upgrade open.
        if (route !== "ping") {
          const r = await settleWithin(ensureConnected(), READY_TIMEOUT_MS)
          if (r === "timeout") {
            return json(503, {
              error: "chrome connect timeout",
              hint: "an 'Allow remote debugging?' dialog may be waiting in the browser",
            })
          }
          if (r instanceof DeniedError) return json(403, { error: r.message })
          if (r instanceof Error) {
            return json(503, { error: `chrome unreachable: ${r.message}` })
          }
        }
        const raw =
          req.method === "POST" || req.headers.get("content-length") ? await safeJson(req) : {}
        const params = validateBody(route, raw)
        const r = await dispatch(conn, route, params, wsUrl)
        return json(r.status, r.body)
      } catch (e) {
        return json(400, { error: e instanceof Error ? e.message : String(e) })
      } finally {
        inflight--
        lastActivity = Date.now()
      }
    },
  })
}

/** Lease sweep plus the idle rule. Runs on the unref'd lease timer. */
function checkIdle(): void {
  if (shuttingDown) return
  const liveLeases = sweepLeases(LEASE_DIR, pidAlive, LEASE_MAX_AGE_MS)
  if (inflight > 0) return
  if (shouldIdleExit({ liveLeases, idleMs: IDLE_MS, lastActivity, now: Date.now() })) {
    log(`no live lease and idle ${Date.now() - lastActivity}ms, exiting`)
    shutdown(0)
  }
}

async function safeJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const text = await req.text()
    return text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Remove the socket file, but only if it is still the one this daemon bound. */
function removeOwnSocket(): void {
  if (boundIno === undefined) return
  try {
    if (statSync(SOCK).ino === boundIno) unlinkSync(SOCK)
  } catch {
    // already gone
  }
  boundIno = undefined
}

function shutdown(code: number): void {
  if (shuttingDown) return
  shuttingDown = true
  if (leaseTimer) clearInterval(leaseTimer)
  removeOwnSocket()
  process.exit(code)
}

function bye(): void {
  shutdown(0)
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2))
  if (code !== undefined) process.exit(code)
}
