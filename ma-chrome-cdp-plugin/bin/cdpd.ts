#!/usr/bin/env bun
/**
 * Control CLI for the CDP daemon: start | stop | restart | status | logs.
 *
 * Starting connects to Chrome ONCE (the single macOS Local Network allow);
 * afterwards the `ChromeCDP` tool and `curl --unix-socket` talk to it with no
 * further prompts.
 *
 * Exports {@link main} so a compiled binary can dispatch it from its embedded
 * script map (`<binary> __run ma-chrome-cdp/cdpd`). Run directly, the
 * `import.meta.main` guard at the bottom calls it with `process.argv.slice(2)`.
 *
 * @module bin/cdpd
 */

import { spawn, spawnSync } from "node:child_process"
import { closeSync, existsSync, openSync, unlinkSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { daemonEnv, SERVER_PROCESS_PATTERN, serverArgv } from "../lib/daemon-spawn.ts"

// The package dir, for the SOURCE-run devPath of cdp-server.ts only. In a
// compiled binary this is `/$bunfs/`, and `serverArgv` ignores the path there
// (it spawns `<binary> __run ma-chrome-cdp/cdp-server`). Nothing is read from it.
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const SOCK = process.env.CDP_SOCK ?? "/tmp/cdp.sock"
const LOG = process.env.CDP_LOG ?? "/tmp/cdp-server.log"

function running(): boolean {
  const r = spawnSync("pgrep", ["-f", SERVER_PROCESS_PATTERN], { encoding: "utf8" })
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

/**
 * Run one control verb.
 *
 * @param argv - `[verb, ...args]`, e.g. `["logs", "80"]`.
 * @returns The exit code: 2 on an unknown verb, else 0.
 */
export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0] ?? ""

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
      const [cmd, ...args] = serverArgv(PACKAGE_DIR)
      const child = spawn(cmd, args, {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: daemonEnv(),
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
      spawnSync("pkill", ["-f", SERVER_PROCESS_PATTERN])
      try {
        unlinkSync(SOCK)
      } catch {
        // ignore
      }
      console.log("stopped")
      break
    }
    case "restart": {
      spawnSync("pkill", ["-f", SERVER_PROCESS_PATTERN])
      await new Promise((r) => setTimeout(r, 800))
      // In-process: no re-spawn of this script, so no runtime is assumed.
      return main(["start"])
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
      if (existsSync(LOG)) spawnSync("tail", ["-n", argv[1] ?? "40", LOG], { stdio: "inherit" })
      else console.log("(no log yet)")
      break
    }
    default:
      console.log("usage: bun run bin/cdpd.ts {start|stop|restart|status|logs}")
      return 2
  }
  return 0
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)))
}
