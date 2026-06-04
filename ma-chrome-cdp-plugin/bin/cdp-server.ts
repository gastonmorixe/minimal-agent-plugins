#!/usr/bin/env bun
/**
 * Persistent CDP daemon.
 *
 * Connects to Chrome's browser-level WebSocket ONCE and stays connected, then
 * serves a tiny HTTP API over a UNIX DOMAIN SOCKET. Why: macOS Local Network
 * privacy prompts on every NEW process that opens a TCP socket to Chrome's
 * debug port, so a short-lived client per command means a prompt per command.
 * A unix socket is a filesystem object (not "network"), so clients hitting the
 * daemon never trigger the prompt. One allow at daemon start, then silence.
 *
 * Run:  bun run bin/cdp-server.ts          (from the plugin dir)
 * Env:  CDP_PORT (9222) · CDP_SOCK (/tmp/cdp.sock) · CDP_DTAP (auto) · CDP_LOG
 *
 * @module bin/cdp-server
 */

import { readFileSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"

import { CdpConnection } from "../lib/connection.ts"
import { dispatch } from "../lib/dispatch.ts"
import { resolveDtapPath } from "../lib/profile.ts"
import { browserWsUrl, parseDevToolsActivePort } from "../lib/protocol.ts"
import { isRoute, validateBody } from "../lib/routes.ts"

const PORT = Number.parseInt(process.env.CDP_PORT ?? "9222", 10)
const SOCK = process.env.CDP_SOCK ?? "/tmp/cdp.sock"

function log(msg: string): void {
  console.log(`[cdp-server] ${msg}`)
}

const dtapPath = resolveDtapPath({ home: homedir(), override: process.env.CDP_DTAP })
const { wsPath } = parseDevToolsActivePort(readFileSync(dtapPath, "utf8"))
const wsUrl = browserWsUrl(PORT, wsPath)

// The live connection. Reassigned by the reconnect loop after an unexpected
// close, so callers always read the current `conn` via the module binding.
let conn: CdpConnection

function freshConnection(): CdpConnection {
  return new CdpConnection({
    url: wsUrl,
    socketFactory: (url) => new WebSocket(url),
    log,
    onClose: () => {
      log("reconnecting in 1s")
      setTimeout(() => {
        conn = freshConnection()
        conn.connect().catch((e: unknown) => log(`reconnect failed: ${String(e)}`))
      }, 1000)
    },
  })
}

async function main(): Promise<void> {
  conn = freshConnection()
  await conn.connect()
  // Turn on browser-level download events up front so /downloads works.
  await conn
    .send("Browser.setDownloadBehavior", { behavior: "default", eventsEnabled: true })
    .catch(() => {})

  try {
    unlinkSync(SOCK)
  } catch {
    // socket file may not exist; fine
  }

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
      try {
        const raw =
          req.method === "POST" || req.headers.get("content-length") ? await safeJson(req) : {}
        const params = validateBody(route, raw)
        const r = await dispatch(conn, route, params, wsUrl)
        return json(r.status, r.body)
      } catch (e) {
        return json(400, { error: e instanceof Error ? e.message : String(e) })
      }
    },
  })
  log(`listening ${SOCK}`)
}

async function safeJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const text = await req.text()
    return text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function bye(): void {
  try {
    unlinkSync(SOCK)
  } catch {
    // ignore
  }
  process.exit(0)
}
process.on("SIGTERM", bye)
process.on("SIGINT", bye)

main().catch((e: unknown) => {
  log(`fatal: ${String(e)}`)
  process.exit(1)
})
