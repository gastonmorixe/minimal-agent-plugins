#!/usr/bin/env bun
/**
 * Control CLI for the CDP daemon: start | stop | restart | status | logs.
 *
 * Starting connects to Chrome ONCE (the single macOS Local Network allow);
 * afterwards the `ChromeCDP` tool and `curl --unix-socket` talk to it with no
 * further prompts.
 *
 * @module bin/cdpd
 */

import { spawn, spawnSync } from "node:child_process"
import { closeSync, existsSync, openSync, unlinkSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, "cdp-server.ts")
const SOCK = process.env.CDP_SOCK ?? "/tmp/cdp.sock"
const LOG = process.env.CDP_LOG ?? "/tmp/cdp-server.log"

function running(): boolean {
  const r = spawnSync("pgrep", ["-f", "cdp-server.ts"], { encoding: "utf8" })
  return r.status === 0 && r.stdout.trim().length > 0
}

async function ping(): Promise<unknown> {
  try {
    const res = await fetch("http://localhost/ping", { unix: SOCK } as RequestInit & {
      unix: string
    })
    return await res.json()
  } catch {
    return null
  }
}

const cmd = process.argv[2] ?? ""

switch (cmd) {
  case "start": {
    if (running()) {
      console.log("already running")
      break
    }
    // Append the daemon's stdout+stderr to LOG so `cdpd logs` and the
    // failure hint ("check CDP_LOG") actually have something to show. Opened
    // in append mode and handed to the detached child as fds 1 and 2; the
    // parent closes its own copies right after spawn (the child keeps them).
    const logFd = openSync(LOG, "a")
    const child = spawn("bun", ["run", SERVER], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    })
    child.unref()
    closeSync(logFd)
    await new Promise((r) => setTimeout(r, 1500))
    console.log(
      running() ? "started" : "failed to start; check Chrome --remote-debugging-port and CDP_LOG",
    )
    break
  }
  case "stop": {
    spawnSync("pkill", ["-f", "cdp-server.ts"])
    try {
      unlinkSync(SOCK)
    } catch {
      // ignore
    }
    console.log("stopped")
    break
  }
  case "restart": {
    spawnSync("pkill", ["-f", "cdp-server.ts"])
    await new Promise((r) => setTimeout(r, 800))
    spawnSync("bun", ["run", join(HERE, "cdpd.ts"), "start"], {
      stdio: "inherit",
      env: process.env,
    })
    break
  }
  case "status": {
    if (!running()) {
      console.log("not running")
      break
    }
    console.log("running")
    console.log(JSON.stringify(await ping()))
    break
  }
  case "logs": {
    if (existsSync(LOG))
      spawnSync("tail", ["-n", process.argv[3] ?? "40", LOG], { stdio: "inherit" })
    else console.log("(no log yet)")
    break
  }
  default:
    console.log("usage: bun run bin/cdpd.ts {start|stop|restart|status|logs}")
    process.exit(2)
}
